/**
 * ChatGPT 订阅渠道（codex Responses API）：复用 oauth.ts / discovery.ts / adapter.ts
 * 的 OAuth（授权码 + PKCE + localhost 回调）、模型发现与 Responses API 适配器。
 * @module dsh-subscription-auth/channels/chatgpt
 */
import { LlmError } from '@deepseek-ai/dsh-llm'
import { ChatGptAdapter } from '../adapter.js'
import type { AdapterModel } from '../adapter.js'
import {
  buildAuthorizeUrl,
  callbackRedirectUri,
  exchangeAuthorizationCode,
  FALLBACK_REDIRECT_PORT,
  generatePkce,
  openBrowser,
  REDIRECT_PORT,
  refreshAccessToken,
  startCallbackListener,
} from '../oauth.js'
import type { CallbackListener } from '../oauth.js'
import {
  exchangeDeviceAuthorization,
  requestDeviceAuthorization,
  waitForDeviceAuthorization,
} from '../chatgpt-device-auth.js'
import { fetchCodexModels, resolveCodexClientVersion } from '../discovery.js'
import type {
  AuthStatus,
  ChannelContext,
  ChannelDefinition,
  ChannelReasoning,
  ChannelRuntime,
  LoginResult,
  StoredToken,
} from '../channel.js'

const DEFAULT_MODELS: AdapterModel[] = [
  { id: 'gpt-5.5', name: 'GPT-5.5', contextWindow: 400_000 },
  { id: 'gpt-5.4', name: 'GPT-5.4', contextWindow: 400_000 },
  { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', contextWindow: 400_000 },
  { id: 'gpt-5.3-codex-spark', name: 'GPT-5.3 Codex Spark', contextWindow: 400_000 },
  { id: 'gpt-5.5-pro', name: 'GPT-5.5 Pro', contextWindow: 400_000 },
]

/** codex Responses API 的 reasoning.effort 取值（与 opencode 一致）。 */
const REASONING: ChannelReasoning = {
  efforts: [
    { id: 'minimal', name: 'Minimal' },
    { id: 'low', name: 'Low' },
    { id: 'medium', name: 'Medium' },
    { id: 'high', name: 'High' },
  ],
  defaultEffort: 'medium',
}

/** 浏览器登录回调的等待上限。 */
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000

/**
 * ChatGPT 的回调只允许 OpenAI 注册过的 1455 / 1457：配置里指定其中之一则优先，
 * 否则按 1455 → 1457。两个都占不到才会退回设备授权，不静默换任意端口。
 */
export function callbackPortCandidates(configured: number): number[] {
  const registered = [REDIRECT_PORT, FALLBACK_REDIRECT_PORT]
  return registered.includes(configured)
    ? [configured, ...registered.filter((port) => port !== configured)]
    : registered
}

/** 只有「端口占不到」才允许换下一个候选端口；其他错误不静默降级。 */
function isPortUnavailable(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code
  return code === 'EACCES' || code === 'EADDRINUSE'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const chatgptChannel: ChannelDefinition = {
  id: 'chatgpt',
  displayName: 'ChatGPT (订阅)',
  name: 'ChatGPT 订阅',
  description: '用 ChatGPT Plus/Pro 订阅额度访问 codex 系模型（模型列表登录后自动从官方 API 获取）',
  tokenRefName: 'CHATGPT_SUBSCRIPTION_TOKEN',
  defaultApiBaseURL: 'https://chatgpt.com/backend-api/codex/responses',
  defaultRedirectPort: 1455,
  defaultContextWindow: 400_000,
  defaultMaxTokens: 8192,
  defaultModels: DEFAULT_MODELS,
  reasoning: REASONING,

  create(ctx: ChannelContext): ChannelRuntime {
    /** 当前登录尝试；undefined 表示没有进行中的会话。 */
    let controller: AbortController | undefined
    /** 进行中的登录会话（authStatus 上报 url / userCode）。 */
    let pending: { url: string; userCode?: string } | undefined
    /** 最近一次登录失败的原因；设置页据此显示失败，重试 / 注销时清空。 */
    let lastError: string | undefined

    /** 读令牌，快过期就先刷新并写回；未登录返回 undefined。对话请求和模型发现共用。 */
    const freshToken = async () => {
      const token = await ctx.readToken()
      if (!token) return undefined
      if (token.expires - Date.now() >= 60_000) return token
      const refreshed = await refreshAccessToken(token.refresh)
      await ctx.writeToken(refreshed)
      return refreshed
    }

    /**
     * 只有当前这次尝试（未被取消、未被新尝试替换）才允许改状态、写凭据。
     * cancelLogin() 会把 controller 清空并 abort，因此旧尝试的 then/catch/finally
     * 永远不会碰新尝试的 pending / 错误 / 凭据。
     */
    const isCurrent = (attempt: AbortController): boolean =>
      controller === attempt && !attempt.signal.aborted

    /** 登录会话结束：只清理属于这次尝试的状态。 */
    const settle = (attempt: AbortController): void => {
      if (controller === attempt) {
        controller = undefined
        pending = undefined
      }
    }

    /** 异步阶段的失败（回调换码 / 设备轮询）：只归因给仍属当前的尝试。 */
    const failAttempt = (attempt: AbortController, error: unknown): void => {
      if (controller !== attempt) return
      if (!attempt.signal.aborted) {
        lastError = messageOf(error)
        ctx.log(`登录失败: ${lastError}`)
      }
      settle(attempt)
    }

    /**
     * 凭据写入串行队列：finishLogin 的写入 / 回滚与 logout 的清空都排队执行，
     * 保证「被取消的旧尝试回滚自己刚写的凭据」一定排在「新尝试写入」之前，
     * 不会互相覆盖；前一个任务失败也不会卡住后面的任务。
     */
    let credentialQueue: Promise<void> = Promise.resolve()
    const runCredentialTask = (task: () => Promise<void>): Promise<void> => {
      const next = credentialQueue.then(task, task)
      credentialQueue = next.catch(() => {})
      return next
    }

    /** clearToken 失败不致命（凭据可能本来就不存在），但要留日志。 */
    const clearTokenQuietly = async (context: string): Promise<void> => {
      try {
        await ctx.clearToken()
      } catch (error) {
        ctx.log(`${context}: ${messageOf(error)}`)
      }
    }

    /**
     * 成功路径：写凭据 → afterLogin。写入在串行队列里执行，队内再确认一次这次
     * 尝试仍然有效；若写入期间被取消（或被新尝试替换），回滚自己刚写下的凭据——
     * 回滚发生在本队列任务内部，必然排在新尝试的写入之前。
     */
    const finishLogin = (attempt: AbortController, token: StoredToken): Promise<void> =>
      runCredentialTask(async () => {
        if (!isCurrent(attempt)) return
        try {
          await ctx.writeToken(token)
        } catch (error) {
          // 写入可能只落了一半：尽力清干净，再把错误交给调用方记录。
          await clearTokenQuietly('写凭据失败后的清理也失败')
          throw error
        }
        if (!isCurrent(attempt)) {
          await clearTokenQuietly('回滚被取消的凭据写入失败')
          return
        }
        ctx.log(`登录成功${token.accountId ? `（account: ${token.accountId}）` : ''}，开始发现模型列表…`)
        settle(attempt)
        ctx.afterLogin()
      })

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
          throw new LlmError('chatgpt: 未登录。请在 设置 → 订阅服务 里完成订阅账号授权。', 'MISSING_CREDENTIAL')
        }
        return { access: token.access }
      },
      label: 'chatgpt',
      displayName: 'ChatGPT (订阅)',
    })

    return {
      adapter,

      async login(): Promise<LoginResult> {
        // 重试就清掉上次的失败信息（注销时另清一次，见 logout）。
        lastError = undefined
        const existing = await ctx.readToken()
        if (existing && existing.expires > Date.now() + 60_000) {
          return { status: 'logged-in', account: existing.accountId }
        }
        // 新尝试：中止上一次（它的后续回调会被 identity guard 挡掉）。
        this.cancelLogin()
        const attempt = new AbortController()
        controller = attempt
        const { verifier, challenge } = generatePkce()
        const state = verifier
        const candidates = callbackPortCandidates(ctx.options().redirectPort)

        // 1) 浏览器回调流：按候选端口逐个真正试绑定，绑定成功才继续（以前是不看
        //    绑定结果就先打开授权 URL），只对 EACCES / EADDRINUSE 换下一个。
        let listener: CallbackListener | undefined = undefined
        for (const port of candidates) {
          try {
            listener = await startCallbackListener(port, state, attempt.signal, LOGIN_TIMEOUT_MS)
            break
          } catch (error) {
            if (isPortUnavailable(error)) continue
            if (controller === attempt) {
              if (!attempt.signal.aborted) lastError = messageOf(error)
              settle(attempt)
            }
            throw error
          }
        }

        // 等待绑定期间可能被取消 / 被新尝试接管：不认这个监听器（关掉它，别漏
        // socket），也不碰新尝试的状态。
        if (listener !== undefined && !isCurrent(attempt)) {
          listener.close()
          throw new Error('aborted')
        }

        if (listener !== undefined) {
          const port = listener.port
          // 授权 URL / redirect_uri / 换令牌都用实际绑定到的端口。
          const url = buildAuthorizeUrl(port, challenge, state)
          pending = { url }
          void listener.code
            .then((code) => {
              // 回调可能恰好撞上取消 / 新尝试接管：只有仍属当前的尝试才换令牌。
              if (!isCurrent(attempt)) return undefined
              ctx.log('收到授权回调，开始换取令牌…')
              return exchangeAuthorizationCode(code, callbackRedirectUri(port), verifier, attempt.signal)
                .then((token) => finishLogin(attempt, token))
            })
            .catch((error: unknown) => { failAttempt(attempt, error) })
          // 只在真正监听成功后才打开浏览器。
          openBrowser(url)
          return { status: 'pending', url }
        }

        // 2) 两个注册端口都不可用 → 官方设备授权兜底。
        if (!isCurrent(attempt)) throw new Error('aborted')
        ctx.log(`localhost:${candidates.join('、')} 都不可用，改用 ChatGPT 设备授权登录`)
        const start = await requestDeviceAuthorization(attempt.signal).catch((error: unknown) => {
          // 网络 / 协议错误必须交给 UI（设置页会显示出来），同时记进 lastError。
          if (controller === attempt) {
            if (!attempt.signal.aborted) lastError = messageOf(error)
            settle(attempt)
          }
          ctx.log(`设备授权初始化失败: ${messageOf(error)}`)
          throw error
        })
        // 设备码请求期间被取消 / 被替换：不设置 pending、不打开浏览器。
        if (!isCurrent(attempt)) throw new Error('aborted')
        pending = { url: start.verificationUrl, userCode: start.userCode }
        void waitForDeviceAuthorization(start, attempt.signal)
          .then((authorized) => {
            // 轮询可能一直到被取消之后才返回（在途请求）：取消 / 被替换的尝试不换令牌。
            if (!isCurrent(attempt)) return undefined
            return exchangeDeviceAuthorization(authorized, attempt.signal)
              .then((token) => finishLogin(attempt, token))
          })
          .catch((error: unknown) => { failAttempt(attempt, error) })
        openBrowser(start.verificationUrl)
        return { status: 'pending', url: start.verificationUrl, userCode: start.userCode }
      },

      async authStatus(): Promise<AuthStatus> {
        const token = await ctx.readToken()
        if (token) {
          return { provider: ctx.id, status: 'logged-in', account: token.accountId, expiresAt: token.expires }
        }
        if (pending && controller && !controller.signal.aborted) {
          return {
            provider: ctx.id,
            status: 'pending',
            url: pending.url,
            ...(pending.userCode !== undefined ? { userCode: pending.userCode } : {}),
          }
        }
        if (lastError !== undefined) {
          return { provider: ctx.id, status: 'not-logged-in', error: lastError }
        }
        return { provider: ctx.id, status: 'not-logged-in' }
      },

      async logout() {
        this.cancelLogin()
        lastError = undefined
        // 清空也走同一条队列：排在已在途的凭据写入（及其回滚）之后。
        await runCredentialTask(async () => { await ctx.clearToken() })
      },

      cancelLogin() {
        const attempt = controller
        controller = undefined
        pending = undefined
        // abort 放在最后：abort 处理器里不再回头看 controller，只关自己的服务器 / 轮询。
        if (attempt && !attempt.signal.aborted) attempt.abort()
      },

      async discoverModels() {
        try {
          // 过期令牌先刷新：以前这里直接返回空列表，令牌一过期，已登录的账号
          // 每次启动都只能看到内置的兜底列表，直到重新登录。
          const token = await freshToken()
          if (!token) return []
          const clientVersion = ctx.options().clientVersion ?? await resolveCodexClientVersion(ctx.log)
          return await fetchCodexModels(
            token.access,
            token.accountId,
            ctx.options().apiBaseURL.replace(/\/codex\/responses$/, ''),
            undefined,
            clientVersion,
          )
        } catch (error) {
          ctx.log(`模型列表发现失败: ${error?.message ?? error}`)
          return []
        }
      },
    }
  },
}
