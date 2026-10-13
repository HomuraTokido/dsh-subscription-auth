/**
 * ChatGPT（codex）订阅 OAuth：授权码 + PKCE + localhost 回调。
 *
 * 常量以 omp（@oh-my-pi/pi-coding-agent）的实现为准（2026-08 实测可登录），
 * 与 opencode 的差异只有两处：scope 多了 `api.connectors.read
 * api.connectors.invoke`（opencode 的旧 scope 会被 auth.openai.com 以
 * missing_required_parameter 拒绝），originator 用 `pi`：
 *   - client_id:   app_EMoamEEZ73f0CkXaXp7hrann
 *   - 授权端点:     https://auth.openai.com/oauth/authorize
 *   - 令牌端点:     https://auth.openai.com/oauth/token
 *   - scope:        openid profile email offline_access
 *                   api.connectors.read api.connectors.invoke
 *   - redirect_uri: http://localhost:1455/auth/callback
 *   - 额外参数:     code_challenge(S256) / id_token_add_organizations /
 *                   codex_cli_simplified_flow / originator=pi
 *
 * 返回的 access_token 用于调用 ChatGPT 后端 codex Responses API
 * （默认 https://chatgpt.com/backend-api/codex/responses）。
 * @module dsh-subscription-auth/oauth
 */
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'

export const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const AUTH_BASE = 'https://auth.openai.com'
export const REDIRECT_PORT = 1455
/** OpenAI 注册的第二个 localhost 回调端口：1455 被占用时用它。 */
export const FALLBACK_REDIRECT_PORT = 1457
/** 单次 HTTP 请求的超时上限（换令牌与设备流共用），与调用方取消信号合并。 */
export const REQUEST_TIMEOUT_MS = 30 * 1000
/** omp 使用的完整 scope 集合；缺 `api.connectors.*` 会被端点拒绝。 */
const SCOPES = 'openid profile email offline_access api.connectors.read api.connectors.invoke'
/** omp（pi-coding-agent）的 originator 值。 */
const ORIGINATOR = 'pi'

/** 持久化在 credential 里的令牌（JSON 字符串）。 */
export interface StoredToken {
  refresh: string
  access: string
  /** epoch 毫秒。 */
  expires: number
  accountId?: string
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

function decodeJwt(token: string): any | undefined {
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString())
  } catch {
    return undefined
  }
}

function accountIdFromClaims(payload: any): string | undefined {
  return payload?.chatgpt_account_id
    ?? payload?.['https://api.openai.com/auth']?.chatgpt_account_id
    ?? payload?.organizations?.[0]?.id
}

function accountIdFromTokens(idToken?: string, access?: string): string | undefined {
  if (idToken) {
    const fromId = accountIdFromClaims(decodeJwt(idToken))
    if (fromId) return fromId
  }
  if (access) return accountIdFromClaims(decodeJwt(access))
  return undefined
}

/** 授权页与换令牌必须用同一个 redirect_uri；端口取实际绑定到的那个。 */
export function callbackRedirectUri(port: number): string {
  return `http://localhost:${port}/auth/callback`
}

export function buildAuthorizeUrl(port: number, challenge: string, state: string): string {
  const redirectUri = callbackRedirectUri(port)
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    state,
    originator: ORIGINATOR,
  })
  return `${AUTH_BASE}/oauth/authorize?${params.toString()}`
}

export function openBrowser(url: string): void {
  try {
    const platform = process.platform
    if (platform === 'win32') {
      // Windows: 不能用 `cmd /c start`（URL 里的 `&` 会被 cmd 当命令分隔符
      // 截断参数），也不能用 explorer.exe（带 `?` 的 URL 会被当本地文件
      // 路径）。rundll32 url.dll,FileProtocolHandler 是 CreateProcess 直传
      // 参数、不经 shell 解析，正确处理任意 URL。
      const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { stdio: 'ignore', detached: true })
      child.on('error', () => {})
      child.unref()
      return
    }
    const cmd = platform === 'darwin' ? 'open' : 'xdg-open'
    const child = spawn(cmd, [url], { stdio: 'ignore', detached: true })
    child.on('error', () => {})
    child.unref()
  } catch {
    /* 打不开浏览器也不致命——页面里会回显 URL 供用户手动打开 */
  }
}

function toStoredToken(json: any, fallbackRefresh: string | undefined): StoredToken {
  const access = typeof json.access_token === 'string' ? json.access_token : ''
  if (access === '') throw new Error('token response missing access_token')
  const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : 600
  const idToken = typeof json.id_token === 'string' ? json.id_token : undefined
  const refresh = typeof json.refresh_token === 'string' ? json.refresh_token : (fallbackRefresh ?? '')
  return {
    refresh,
    access,
    expires: Date.now() + expiresIn * 1000,
    accountId: accountIdFromTokens(idToken, access),
  }
}

/**
 * 把「调用方取消」与「单请求超时」合成一个 AbortSignal。
 * 请求结束后必须 cleanup()，否则超时计时器会一直挂到点。
 */
export function boundedSignal(
  signal?: AbortSignal,
  timeoutMs = REQUEST_TIMEOUT_MS,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    },
  }
}

/**
 * 授权码换令牌（ChatGPT 浏览器回调流与设备流共用，两者只有 redirect_uri 不同）。
 * 请求带 30s 超时，并与 `signal` 上的取消合并；失败只报 HTTP 状态码——
 * 响应体在异常路径上也可能带令牌材料，不写进错误信息。
 */
export async function exchangeAuthorizationCode(
  code: string,
  redirectUri: string,
  verifier: string,
  signal?: AbortSignal,
): Promise<StoredToken> {
  const request = boundedSignal(signal)
  try {
    const res = await fetch(`${AUTH_BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: CLIENT_ID,
        code_verifier: verifier,
      }).toString(),
      signal: request.signal,
    })
    if (!res.ok) throw new Error(`token exchange failed (HTTP ${res.status})`)
    return toStoredToken(await res.json(), undefined)
  } finally {
    request.cleanup()
  }
}

/** ChatGPT 浏览器回调流：redirect_uri 落在本机回调端口上。 */
export function exchangeCode(code: string, port: number, verifier: string): Promise<StoredToken> {
  return exchangeAuthorizationCode(code, callbackRedirectUri(port), verifier)
}

export async function refreshAccessToken(refresh: string): Promise<StoredToken> {
  const res = await fetch(`${AUTH_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: CLIENT_ID,
    }).toString(),
  })
  if (!res.ok) throw new Error(`token refresh failed (HTTP ${res.status})`)
  return toStoredToken(await res.json(), refresh)
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ))
}

/** 已绑定并正在监听的本地回调服务器。 */
export interface CallbackListener {
  /** 实际绑定到的端口（只监听 127.0.0.1）。 */
  port: number
  /** 收到合法授权码时 resolve；错误回调 / state 不匹配 / 超时 / 取消时 reject。 */
  code: Promise<string>
  /** 关闭服务器并释放端口（幂等）。 */
  close(): void
}

/**
 * 启动一次性 loopback HTTP 服务器收授权码，只在**真正监听成功之后** resolve。
 * 端口绑定失败（`err.code` 保留原始值）会让返回的 promise reject，方便调用方
 * 判断要不要换下一个端口；服务器一直保留到收到 code、取消或超时。
 * 只绑 127.0.0.1，不监听外部地址。
 */
export function startCallbackListener(
  port: number,
  state: string,
  signal?: AbortSignal,
  timeoutMs = 10 * 60 * 1000,
  path = '/auth/callback',
): Promise<CallbackListener> {
  return new Promise<CallbackListener>((resolveReady, rejectReady) => {
    const server: Server = createServer()
    let readySettled = false
    let closing = false
    let codeSettled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let resolveCode: (code: string) => void = () => {}
    let rejectCode: (error: Error) => void = () => {}
    const code = new Promise<string>((resolve, reject) => {
      resolveCode = resolve
      rejectCode = reject
    })
    // 调用方可能在 readiness 失败（换端口 / 走设备流）后丢弃 code：先挂一个
    // noop handler，免得这个 promise 的 rejection 变成进程级 unhandled rejection。
    code.catch(() => {})
    const listener: CallbackListener = { port, code, close }

    /**
     * readiness 只 settle 一次，而且 abort / 超时 / 绑定失败时也必须 settle：
     * 否则调用方会永远挂在 `await startCallbackListener(...)` 上（promise 泄漏）。
     */
    function settleReady(error?: Error): void {
      if (readySettled) return
      readySettled = true
      if (error === undefined) resolveReady(listener)
      else rejectReady(error)
    }

    function close(): void {
      if (closing) return
      closing = true
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      server.close()
    }

    function fail(error: Error): void {
      settleReady(error)
      if (codeSettled) return
      codeSettled = true
      close()
      rejectCode(error)
    }

    function done(received: string): void {
      if (codeSettled) return
      codeSettled = true
      close()
      resolveCode(received)
    }

    function onAbort(): void {
      fail(new Error('aborted'))
    }

    server.on('request', (req, res) => {
      const u = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
      if (u.pathname !== path) {
        res.writeHead(404)
        res.end('not found')
        return
      }
      const error = u.searchParams.get('error')
      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(`<h1>登录失败</h1><p>${escapeHtml(error)}</p>`)
        fail(new Error(`oauth error: ${error}`))
        return
      }
      const received = u.searchParams.get('code')
      if (!received) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end('<h1>缺少授权码</h1>')
        return
      }
      if (u.searchParams.get('state') !== state) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end('<h1>state 不匹配</h1>')
        fail(new Error('oauth state mismatch'))
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<h1>登录成功</h1><p>可以关闭此页面，回到 dsh 继续。</p>')
      done(received)
    })

    server.on('error', (err: Error) => {
      // 绑定失败（端口被占 / 没权限）与运行期错误共用一条路：包装后的错误保留
      // 原始 err.code，调用方据此决定能不能换下一个端口。
      const failure = new Error(
        `localhost:${port} 启动失败：${err.message}（端口被占用？）`,
      ) as Error & { code?: string }
      failure.code = (err as NodeJS.ErrnoException).code
      fail(failure)
    })
    if (signal?.aborted) {
      fail(new Error('aborted'))
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => {
      fail(new Error('oauth timed out: 等待授权回调超时'))
    }, timeoutMs)
    server.listen(port, '127.0.0.1', () => {
      // close()（abort / 超时）之后才到的 listen 回调：不算成功，也别把已经建立
      // 的 socket 漏在外面。
      if (closing) {
        server.close()
        return
      }
      settleReady()
    })
  })
}

/**
 * 启动一次性 localhost HTTP 服务器，等待浏览器回调返回授权码。
 * 收到 code 且 state 匹配时 resolve；用户取消 / 信号中止 / 端口被占 /
 * 超过 `timeoutMs` 未回调时 reject。claude 渠道与冒烟测试沿用这个包装。
 */
export async function waitForCallback(
  port: number,
  state: string,
  signal?: AbortSignal,
  timeoutMs = 10 * 60 * 1000,
  path = '/auth/callback',
): Promise<string> {
  const listener = await startCallbackListener(port, state, signal, timeoutMs, path)
  return listener.code
}
