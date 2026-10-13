/**
 * Claude 订阅渠道（Anthropic OAuth）：授权码 + PKCE + localhost 回调，
 * 用 Claude Pro/Max 订阅额度访问 Claude 模型。授权/换码/续期是本渠道专属函数，
 * 推理走 AnthropicMessagesAdapter（../adapters/anthropic.js）。
 * @module dsh-subscription-auth/channels/claude
 */
import { LlmError } from '@deepseek-ai/dsh-llm'
import { AnthropicMessagesAdapter } from '../adapters/anthropic.js'
import type { AdapterModel } from '../adapter.js'
import { boundedSignal, generatePkce, openBrowser, readAuthJson, waitForCallback } from '../oauth.js'
import type {
  AuthStatus,
  ChannelContext,
  ChannelDefinition,
  ChannelReasoning,
  ChannelRuntime,
  LoginResult,
} from '../channel.js'
import type { StoredToken } from '../channel.js'
import { AuthSession } from '../auth-session.js'

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const AUTHORIZE = 'https://claude.ai/oauth/authorize'
const TOKEN_ENDPOINT = 'https://api.anthropic.com/v1/oauth/token'
const MODELS_ENDPOINT = 'https://api.anthropic.com/v1/models'
const CALLBACK_PATH = '/callback'
const SCOPES =
  'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload'
const RESOLVE_THRESHOLD_MS = 60_000
/** 浏览器回调的等待上限。 */
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000

/** `unknown` 错误的可读文本（catch 变量在 strict 下是 unknown，不能直接取 .message）。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const defaultModels: AdapterModel[] = [
  { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', contextWindow: 400_000 },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', contextWindow: 1_000_000 },
  { id: 'claude-fable-5', name: 'Claude Fable 5', contextWindow: 1_000_000 },
  { id: 'claude-mythos-5', name: 'Claude Mythos 5', contextWindow: 1_000_000 },
]

const ANTHROPIC_VERSION = '2023-06-01'
const ANTHROPIC_BETA =
  'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,advanced-tool-use-2025-11-20,effort-2025-11-24,extended-cache-ttl-2025-04-11'

/** 思考强度 → extended thinking budget_tokens（Claude 官方推荐预算区间）。 */
const REASONING: ChannelReasoning = {
  efforts: [
    { id: 'low', name: 'Low', budgetTokens: 8_192 },
    { id: 'medium', name: 'Medium', budgetTokens: 16_384 },
    { id: 'high', name: 'High', budgetTokens: 32_000 },
  ],
  defaultEffort: 'medium',
}

function redirectUri(port: number): string {
  return 'http://localhost:' + port + CALLBACK_PATH
}

function toStoredToken(json: any, fallbackRefresh: string | undefined): StoredToken {
  const access = typeof json.access_token === 'string' ? json.access_token : ''
  if (access === '') throw new Error('token response missing access_token')
  const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : 600
  const refresh = typeof json.refresh_token === 'string' ? json.refresh_token : (fallbackRefresh ?? '')
  return {
    refresh,
    access,
    expires: Date.now() + expiresIn * 1000,
    accountId: json?.account?.uuid,
    email: json?.account?.email_address,
  }
}

function buildAuthorizeUrl(port: number, challenge: string, state: string): string {
  const params = new URLSearchParams({
    code: 'true',
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri(port),
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  })
  return AUTHORIZE + '?' + params.toString()
}

async function exchangeClaudeCode(
  code: string,
  port: number,
  verifier: string,
  signal?: AbortSignal,
): Promise<StoredToken> {
  const request = boundedSignal(signal)
  try {
    const res = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        code,
        state: verifier,
        redirect_uri: redirectUri(port),
        code_verifier: verifier,
      }),
      signal: request.signal,
    })
    // 失败只报 HTTP 状态码：响应体可能带令牌材料，不写进错误信息
    if (!res.ok) throw new Error('token exchange failed (HTTP ' + res.status + ')')
    return toStoredToken(await readAuthJson(res, 'token response is not valid JSON'), undefined)
  } finally {
    request.cleanup()
  }
}

async function refreshClaudeToken(refresh: string, signal?: AbortSignal): Promise<StoredToken> {
  const request = boundedSignal(signal)
  try {
    const res = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'anthropic-sdk-typescript/0.94.0 userOAuthProvider',
      },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        refresh_token: refresh,
      }),
      signal: request.signal,
    })
    if (!res.ok) throw new Error('token refresh failed (HTTP ' + res.status + ')')
    return toStoredToken(await readAuthJson(res, 'token refresh response is not valid JSON'), refresh)
  } finally {
    request.cleanup()
  }
}

async function fetchClaudeModels(access: string): Promise<AdapterModel[]> {
  const res = await fetch(MODELS_ENDPOINT, {
    method: 'GET',
    headers: {
      authorization: 'Bearer ' + access,
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-dangerous-direct-browser-access': 'true',
      'anthropic-beta': ANTHROPIC_BETA,
    },
  })
  if (!res.ok) throw new Error('model list failed (HTTP ' + res.status + ')')
  const json: any = await res.json()
  const data: any[] = Array.isArray(json?.data) ? json.data : []
  return data.map((m) => {
    const id = String(m?.id ?? '')
    const name = typeof m?.display_name === 'string' && m.display_name !== '' ? m.display_name : id
    return id !== '' ? { id, name } : null
  }).filter((m): m is AdapterModel => m !== null)
}

export const claudeChannel: ChannelDefinition = {
  id: 'claude',
  displayName: 'Claude (订阅)',
  name: 'Claude 订阅',
  description: '用 Claude Pro/Max 订阅额度访问 Claude 模型（OAuth 登录，模型列表登录后自动从官方 API 获取）',
  tokenRefName: 'CLAUDE_SUBSCRIPTION_TOKEN',
  defaultApiBaseURL: 'https://api.anthropic.com/v1/messages',
  defaultRedirectPort: 54545,
  defaultContextWindow: 1_000_000,
  defaultMaxTokens: 64000,
  defaultModels,
  reasoning: REASONING,

  create(ctx: ChannelContext): ChannelRuntime {
    const session = new AuthSession<{ url: string; userCode?: string }>({
      log: ctx.log,
      write: (token, isCurrent) => ctx.writeToken(token, isCurrent),
      afterLogin: ctx.afterLogin,
    })

    /** 读令牌，快过期就先刷新并写回；未登录返回 undefined。对话请求和模型发现共用。 */
    const freshToken = () =>
      ctx.freshToken((token, signal) => refreshClaudeToken(token.refresh, signal))

    const adapter = new AnthropicMessagesAdapter({
      options: () => ({
        apiBaseURL: ctx.options().apiBaseURL,
        maxTokens: ctx.options().maxTokens,
        models: ctx.options().models,
        defaultContextWindow: ctx.options().defaultContextWindow,
        headers: () => ({
          'anthropic-version': ANTHROPIC_VERSION,
          'anthropic-beta': ANTHROPIC_BETA,
        }),
      }),
      attachments: ctx.attachments,
      reasoning: REASONING,
      resolveAccessToken: async () => {
        const token = await freshToken()
        if (!token) {
          throw new LlmError('claude: 未登录。请在 设置 → 订阅服务 里完成订阅账号授权。', 'MISSING_CREDENTIAL')
        }
        return { access: token.access }
      },
      label: 'claude',
      displayName: 'Claude (订阅)',
    })

    return {
      adapter,

      async login(): Promise<LoginResult> {
        // 先同步作废旧尝试（abort + 清 pending/error），再做任何 await。
        const attempt = session.begin()
        const existing = await ctx.readToken()
        if (!attempt.isCurrent()) throw new Error('aborted')
        if (existing && existing.expires > Date.now() + RESOLVE_THRESHOLD_MS) {
          session.settle(attempt)
          return { status: 'logged-in', account: existing.accountId }
        }
        const port = ctx.options().redirectPort
        const { verifier, challenge } = generatePkce()
        const state = verifier
        const url = buildAuthorizeUrl(port, challenge, state)
        attempt.publish({ url })
        void waitForCallback(port, state, attempt.signal, LOGIN_TIMEOUT_MS, CALLBACK_PATH)
          .then(async (code) => {
            if (!attempt.isCurrent()) return
            ctx.log('收到授权回调，开始换取令牌…')
            const token = await exchangeClaudeCode(code, port, verifier, attempt.signal)
            await session.succeed(attempt, token)
          })
          .catch((error: unknown) => { session.fail(attempt, error) })
        openBrowser(url)
        return { status: 'pending', url }
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
          return await fetchClaudeModels(token.access)
        } catch (error) {
          ctx.log('模型列表发现失败: ' + messageOf(error))
          return []
        }
      },
    }
  },
}
