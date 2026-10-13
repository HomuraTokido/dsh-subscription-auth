/**
 * Grok (xAI / SuperGrok) 订阅渠道：OAuth 设备授权流（RFC 8628）+ xAI
 * Responses-style API 适配器。复用 device-flow.ts 的轮询与 adapter.ts 的
 * ChatGptAdapter（Responses API）。
 * @module dsh-subscription-auth/channels/grok
 */
import { LlmError } from '@deepseek-ai/dsh-llm'
import { ChatGptAdapter } from '../adapter.js'
import type { AdapterModel } from '../adapter.js'
import { boundedSignal, openBrowser, readAuthJson } from '../oauth.js'
import { pollDeviceFlow } from '../device-flow.js'
import type { DevicePollResult } from '../device-flow.js'
import type {
  AuthStatus,
  ChannelContext,
  ChannelDefinition,
  ChannelReasoning,
  ChannelRuntime,
  LoginResult,
} from '../channel.js'
import { AuthSession } from '../auth-session.js'

const CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828'

/** `unknown` 错误的可读文本（catch 变量在 strict 下是 unknown，不能直接取 .message）。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
const SCOPE = 'openid profile email offline_access grok-cli:access api:access'

const DEFAULT_MODELS: AdapterModel[] = [
  { id: 'grok-4.6', name: 'Grok 4.6', contextWindow: 500000 },
  { id: 'grok-4.3', name: 'Grok 4.3', contextWindow: 1000000 },
  { id: 'grok-build', name: 'Grok Build', contextWindow: 512000 },
  { id: 'grok-build-0.1', name: 'Grok Build 0.1', contextWindow: 256000 },
  { id: 'grok-4.5', name: 'Grok 4.5', contextWindow: 500000 },
  { id: 'grok-4.20-multi-agent-0309', name: 'Grok 4.20 (Multi-Agent)', contextWindow: 2000000 },
  { id: 'grok-4.20-0309-reasoning', name: 'Grok 4.20 (Reasoning)', contextWindow: 2000000 },
  { id: 'grok-4.20-0309-non-reasoning', name: 'Grok 4.20 (Non-Reasoning)', contextWindow: 2000000 },
  { id: 'grok-composer-2.5-fast', name: 'Grok Composer 2.5 Fast', contextWindow: 200000 },
]

/** xAI Responses API 的 reasoning.effort 取值；无默认档位（用户显式选择才发送）。 */
const REASONING: ChannelReasoning = {
  efforts: [
    { id: 'low', name: 'Low' },
    { id: 'medium', name: 'Medium' },
    { id: 'high', name: 'High' },
  ],
}

/** 从 OIDC 元数据发现 token_endpoint（设备流 / 续期共用）。 */
async function discoverTokenEndpoint(signal?: AbortSignal): Promise<string> {
  const request = boundedSignal(signal)
  try {
    const res = await fetch('https://auth.x.ai/.well-known/openid-configuration', {
      headers: { accept: 'application/json' },
      signal: request.signal,
    })
    if (!res.ok) throw new Error(`OIDC 发现失败 (HTTP ${res.status})`)
    const meta = await readAuthJson(res, 'OIDC 发现响应不是合法 JSON')
    const endpoint = typeof meta?.token_endpoint === 'string' ? meta.token_endpoint : undefined
    if (!endpoint) throw new Error('OIDC 发现响应缺少 token_endpoint')
    return endpoint
  } finally {
    request.cleanup()
  }
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

function accountIdFromAccessToken(access: string): string | undefined {
  const claims = decodeJwt(access)
  const sub = typeof claims?.sub === 'string' && claims.sub !== '' ? claims.sub : undefined
  return sub ?? (typeof claims?.preferred_username === 'string' ? claims.preferred_username : undefined)
}

/** GET userinfo 取 sub/email/name；acountId 用 sub（实际以 email 为准可另行扩展）。 */
async function fetchUserinfo(
  access: string,
  signal?: AbortSignal,
): Promise<{ accountId?: string; email?: string }> {
  const request = boundedSignal(signal)
  try {
    const res = await fetch('https://auth.x.ai/oauth2/userinfo', {
      headers: { authorization: `Bearer ${access}`, accept: 'application/json' },
      signal: request.signal,
    })
    if (!res.ok) return { accountId: accountIdFromAccessToken(access) }
    const info = await readAuthJson(res, 'userinfo 响应不是合法 JSON')
    const accountId =
      typeof info?.sub === 'string' && info.sub !== '' ? info.sub : accountIdFromAccessToken(access)
    const email = typeof info?.email === 'string' ? info.email : undefined
    return { accountId, email }
  } catch (error) {
    // 取消必须原样抛出去（不能当成「拿不到 userinfo」静默降级）
    if (signal?.aborted) throw error
    return { accountId: accountIdFromAccessToken(access) }
  } finally {
    request.cleanup()
  }
}

/** 把 OAuth 令牌响应归一为 StoredToken。 */
function toStoredToken(json: any, fallbackRefresh: string | undefined = undefined): {
  refresh: string
  access: string
  expires: number
} {
  const access = typeof json.access_token === 'string' ? json.access_token : ''
  if (access === '') throw new Error('令牌响应缺少 access_token')
  const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : 600
  const refresh = typeof json.refresh_token === 'string' ? json.refresh_token : (fallbackRefresh ?? '')
  return { refresh, access, expires: Date.now() + expiresIn * 1000 }
}

async function exchangeDeviceCode(
  tokenEndpoint: string,
  deviceCode: string,
  signal?: AbortSignal,
): Promise<DevicePollResult<any>> {
  const request = boundedSignal(signal)
  try {
    const res = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: CLIENT_ID,
        device_code: deviceCode,
      }).toString(),
      signal: request.signal,
    })
    const body = await readAuthJson(res, '设备授权响应不是合法 JSON').catch(() => ({}))
    if (res.ok && typeof body?.access_token === 'string' && body.access_token !== '') {
      return { status: 'complete', value: body }
    }
    // 错误串只用错误码（协议字段），不回显响应体
    const code = typeof body?.error === 'string' ? body.error : ''
    switch (code) {
      case 'authorization_pending':
        return { status: 'pending' }
      case 'slow_down':
        return { status: 'slow_down' }
      case 'access_denied':
        return { status: 'failed', message: '用户拒绝了授权' }
      case 'expired_token':
        return { status: 'failed', message: '设备授权已过期，请重新发起登录' }
      default:
        return { status: 'failed', message: `设备授权失败${code !== '' ? `: ${code}` : ''}` }
    }
  } finally {
    request.cleanup()
  }
}

async function startDeviceFlow(signal?: AbortSignal): Promise<{
  deviceCode: string
  intervalSeconds: number
  expiresInSeconds: number
  verificationUriComplete: string
  userCode: string
}> {
  const request = boundedSignal(signal)
  try {
    const res = await fetch('https://auth.x.ai/oauth2/device/code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: CLIENT_ID, scope: SCOPE }).toString(),
      signal: request.signal,
    })
    if (!res.ok) throw new Error(`设备码请求失败 (HTTP ${res.status})`)
    const body = await readAuthJson(res, '设备码响应不是合法 JSON')
    const deviceCode = typeof body?.device_code === 'string' ? body.device_code : ''
    const userCode = typeof body?.user_code === 'string' ? body.user_code : ''
    if (!deviceCode || !userCode) throw new Error('设备码响应缺少 device_code/user_code')
    return {
      deviceCode,
      intervalSeconds: typeof body?.interval === 'number' ? body.interval : 5,
      expiresInSeconds: typeof body?.expires_in === 'number' ? body.expires_in : 600,
      verificationUriComplete:
        typeof body?.verification_uri_complete === 'string'
          ? body.verification_uri_complete
          : (typeof body?.verification_uri === 'string' ? body.verification_uri : ''),
      userCode,
    }
  } finally {
    request.cleanup()
  }
}

async function refreshToken(
  refresh: string,
  signal?: AbortSignal,
): Promise<{ refresh: string; access: string; expires: number }> {
  const tokenEndpoint = await discoverTokenEndpoint(signal)
  const request = boundedSignal(signal)
  try {
    const res = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        refresh_token: refresh,
      }).toString(),
      signal: request.signal,
    })
    if (!res.ok) throw new Error(`令牌续期失败 (HTTP ${res.status})`)
    return toStoredToken(await readAuthJson(res, '令牌续期响应不是合法 JSON'), refresh)
  } finally {
    request.cleanup()
  }
}

/** 从 xAI 官方 API 拉取模型列表并过滤掉非对话模型。 */
async function fetchGrokModels(access: string): Promise<AdapterModel[]> {
  const res = await fetch('https://api.x.ai/v1/models', {
    headers: { authorization: `Bearer ${access}`, accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`模型列表请求失败 (HTTP ${res.status})`)
  const body = (await res.json()) as any
  const list: any[] = Array.isArray(body?.data) ? body.data : []
  return list
    .filter((m) => {
      const id = typeof m?.id === 'string' ? m.id : ''
      return (
        id !== '' &&
        !id.startsWith('grok-imagine-') &&
        !id.startsWith('grok-stt-') &&
        !id.startsWith('grok-voice-')
      )
    })
    .map((m) => ({ id: String(m.id), name: String(m.id) }))
}

export const grokChannel: ChannelDefinition = {
  id: 'grok',
  displayName: 'Grok (订阅)',
  name: 'Grok 订阅',
  description: '用 SuperGrok / X Premium+ 订阅额度访问 Grok 模型（设备授权登录，模型列表登录后自动从官方 API 获取）',
  tokenRefName: 'GROK_SUBSCRIPTION_TOKEN',
  defaultApiBaseURL: 'https://api.x.ai/v1/responses',
  defaultRedirectPort: 0,
  defaultContextWindow: 500_000,
  defaultMaxTokens: 8192,
  defaultModels: DEFAULT_MODELS,
  reasoning: REASONING,

  create(ctx: ChannelContext): ChannelRuntime {
    const session = new AuthSession<{ url: string; userCode?: string }>({
      log: ctx.log,
      write: (token, isCurrent) => ctx.writeToken(token, isCurrent),
      afterLogin: ctx.afterLogin,
    })

    /** 读令牌，快过期就先刷新并写回；未登录返回 undefined。对话请求和模型发现共用。 */
    const freshToken = () =>
      ctx.freshToken((token, signal) => refreshToken(token.refresh, signal))

    const adapter = new ChatGptAdapter({
      options: () => ({
        apiBaseURL: ctx.options().apiBaseURL,
        maxTokens: ctx.options().maxTokens,
        models: ctx.options().models,
        defaultContextWindow: ctx.options().defaultContextWindow,
      }),
      attachments: ctx.attachments,
      reasoning: REASONING,
      resolveAccessToken: async () => {
        const token = await freshToken()
        if (!token) {
          throw new LlmError('grok: 未登录。请在 设置 → 订阅服务 里完成订阅账号授权。', 'MISSING_CREDENTIAL')
        }
        return { access: token.access }
      },
      label: 'grok',
      displayName: 'Grok (订阅)',
    })

    return {
      adapter,

      async login(): Promise<LoginResult> {
        // 先同步作废旧尝试（abort + 清 pending/error），再做任何 await。
        const attempt = session.begin()
        const existing = await ctx.readToken()
        if (!attempt.isCurrent()) throw new Error('aborted')
        if (existing && existing.expires > Date.now() + 60_000) {
          session.settle(attempt)
          return { status: 'logged-in', account: existing.accountId }
        }
        try {
          const flow = await startDeviceFlow(attempt.signal)
          if (!attempt.isCurrent()) throw new Error('aborted')
          const tokenEndpoint = await discoverTokenEndpoint(attempt.signal)
          if (!attempt.isCurrent()) throw new Error('aborted')
          attempt.publish({ url: flow.verificationUriComplete, userCode: flow.userCode })

          void pollDeviceFlow<any>({
            signal: attempt.signal,
            intervalSeconds: flow.intervalSeconds,
            expiresInSeconds: flow.expiresInSeconds,
            poll: (): Promise<DevicePollResult<any>> =>
              exchangeDeviceCode(tokenEndpoint, flow.deviceCode, attempt.signal),
          })
            .then(async (body) => {
              if (!attempt.isCurrent()) return
              const base = toStoredToken(body)
              const user = await fetchUserinfo(base.access, attempt.signal)
              if (!attempt.isCurrent()) return
              const stored = {
                ...base,
                ...(user.accountId !== undefined ? { accountId: user.accountId } : {}),
                ...(user.email !== undefined ? { email: user.email } : {}),
              }
              await session.succeed(attempt, stored)
            })
            .catch((error: unknown) => { session.fail(attempt, error) })

          if (flow.verificationUriComplete) openBrowser(flow.verificationUriComplete)
          return { status: 'pending', url: flow.verificationUriComplete, userCode: flow.userCode }
        } catch (error: unknown) {
          session.fail(attempt, error)
          throw error
        }
      },

      async authStatus(): Promise<AuthStatus> {
        const token = await ctx.readToken()
        if (token) {
          return { provider: ctx.id, status: 'logged-in', account: token.accountId, expiresAt: token.expires }
        }
        const pending = session.pending()
        if (pending !== undefined) {
          return {
            provider: ctx.id,
            status: 'pending',
            url: pending.url,
            ...(pending.userCode !== undefined ? { userCode: pending.userCode } : {}),
          }
        }
        const error = session.lastError()
        if (error !== undefined) {
          return { provider: ctx.id, status: 'not-logged-in', error }
        }
        return { provider: ctx.id, status: 'not-logged-in' }
      },

      async logout() {
        // 先 cancel（abort + 清 pending/error），再清凭据。
        session.cancel()
        await ctx.clearToken()
      },

      cancelLogin() {
        session.cancel()
      },

      async discoverModels() {
        try {
          const token = await freshToken()
          if (!token) return []
          return await fetchGrokModels(token.access)
        } catch (error) {
          ctx.log(`模型列表发现失败: ${messageOf(error)}`)
          return []
        }
      },
    }
  },
}
