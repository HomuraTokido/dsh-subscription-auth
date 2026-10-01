/**
 * dsh-subscription-auth：给 dsh 增加订阅会员（ChatGPT / Claude / Grok / Kimi）的
 * OAuth 登录支持。
 *
 * 本模块是薄的通用驱动：遍历 {@link CHANNELS} 里的渠道定义，为每个渠道声明一段
 * volatile 配置（Config.<id>）、注册 llm provider + adapter，以及配置中心
 * 的登录/注销/状态路由。每个渠道的 OAuth 流程、模型发现与适配器都封装在
 * src/channels/<id>.ts 里（见 src/channel.ts 的 ChannelDefinition 契约）。
 *
 * 登录入口在配置中心的「订阅服务」页（client half）：三条端点
 * providers / login / logout 挂在 Typert Gateway 的 /api 通道上（见 src/remote.ts，
 * 官方 Electron 壳没有 webserver，HTTP 路由挂不上）。
 * @module dsh-subscription-auth
 */
import z from '@deepseek-ai/schemastery'
import type { Context as CordisContext } from '@deepseek-ai/cordis'
import type LlmRuntime from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { AdapterModel } from './adapter.js'
import type {
  ChannelConfig,
  ChannelContext,
  ChannelDefinition,
  ChannelRuntime,
  StoredToken,
} from './channel.js'
import { chatgptChannel } from './channels/chatgpt.js'
import { claudeChannel } from './channels/claude.js'
import { grokChannel } from './channels/grok.js'
import { kimiChannel } from './channels/kimi.js'
// 只引类型：运行时通过动态 import() 加载 ./remote.js，避免静态依赖协议包
// （终端型 profile 没有 gateway 时也要能加载本插件）。
import type { SubscriptionAuthRemoteDeps } from './remote.js'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'

type Context = CordisContext & { llm: LlmRuntime }

export const name = 'dsh-subscription-auth'
export const inject = ['llm']

/** 所有订阅渠道（顺序即「订阅服务」页卡片顺序）。 */
export const CHANNELS: ChannelDefinition[] = [
  chatgptChannel,
  claudeChannel,
  grokChannel,
  kimiChannel,
]

/** 日志文件：~/.dsh/tmp/subscription-auth.log（stdout 之外的可检测渠道）。 */
function logLine(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}`
  try {
    console.log(line)
    const dir = join(os.homedir(), '.dsh', 'tmp')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'subscription-auth.log'), line + '\n')
  } catch {
    /* 日志写入失败不影响功能 */
  }
}

const catalogModel = z.object({
  id: z.string().required(),
  name: z.string().required(),
  contextWindow: z.number(),
})

function makeConfigSchema(def: ChannelDefinition) {
  return z.object({
    apiBaseURL: z.string().default(def.defaultApiBaseURL),
    redirectPort: z.number().default(def.defaultRedirectPort),
    // 注意：models 不能带 .default()——否则 schemastery 总是用默认值填充，
    // 登录发现的模型列表就永远被默认列表压住。默认值由 resolveOptions 统一处理。
    models: z.array(catalogModel),
    defaultContextWindow: z.number().default(def.defaultContextWindow),
    maxTokens: z.number().default(def.defaultMaxTokens),
    clientVersion: z.string(),
    discoveredModels: z.array(catalogModel),
  })
}

/**
 * 插件配置：每个渠道一段，整段 volatile。core 0.2 的 settings 服务只编辑插件自己
 * Config 里声明为 volatile 的字段（旧的 settings.register 已经没有了），写入经
 * configEditor 落到当前 profile 的 cordis.patch.yml，运行中的引用随之更新、不重挂。
 */
export const Config = z.object(Object.fromEntries(
  CHANNELS.map((def) => [def.id, makeConfigSchema(def).volatile()]),
))

/** 一个渠道的配置引用（volatile：.get() 返回当前快照）。 */
type ChannelConfigRef = { get(): ChannelConfig | undefined }

/** 模型列表从哪来：界面据此区分「官方列表」和「内置兜底」。 */
type ModelsSource = 'config' | 'discovered' | 'saved' | 'builtin'

/**
 * 模型优先级：用户显式 models → 本次运行发现的结果 → 上次持久化的 discoveredModels → 内置列表。
 * 本次发现排在持久化之前：写回失败时不让旧列表压住刚拿到的新列表。
 */
function resolveOptions(
  raw: ChannelConfig,
  discovered: AdapterModel[] | undefined,
  def: ChannelDefinition,
): {
  apiBaseURL: string
  redirectPort: number
  models: AdapterModel[]
  modelsSource: ModelsSource
  defaultContextWindow: number
  maxTokens: number
  clientVersion?: string
} {
  const [source, modelsSource]: [AdapterModel[], ModelsSource] = (raw.models !== undefined && raw.models.length > 0)
    ? [raw.models, 'config']
    : (discovered !== undefined && discovered.length > 0)
      ? [discovered, 'discovered']
      : (raw.discoveredModels !== undefined && raw.discoveredModels.length > 0)
        ? [raw.discoveredModels, 'saved']
        : [def.defaultModels, 'builtin']
  const models = source.map((m) => ({
    id: m.id,
    name: m.name ?? m.id,
    ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
  }))
  return {
    apiBaseURL: raw.apiBaseURL ?? def.defaultApiBaseURL,
    redirectPort: raw.redirectPort ?? def.defaultRedirectPort,
    models,
    modelsSource,
    defaultContextWindow: raw.defaultContextWindow ?? def.defaultContextWindow,
    maxTokens: raw.maxTokens ?? def.defaultMaxTokens,
    ...(raw.clientVersion !== undefined && raw.clientVersion.trim() !== ''
      ? { clientVersion: raw.clientVersion.trim() }
      : {}),
  }
}

interface ChannelState {
  def: ChannelDefinition
  runtime: ChannelRuntime
  channelCtx: ChannelContext
  discovered?: { models: AdapterModel[]; at: number }
  /** 进行中的发现：同时来的几次触发（登录回调、设置页轮询）共用一次请求。 */
  discovering?: Promise<void>
  /** 模型发现/登录状态变化后刷新注册（announce：让 UI 重新拉取列表）。 */
  replaceRegistration?: () => void
  /** 按登录状态注册/撤销 provider + adapter（false = 从模型列表移除）。 */
  syncRegistration?: (enabled: boolean) => void
}

/** 插件在 profile 里的条目，以及 core 的配置编辑器（只用到这里出现的几样）。 */
interface ProfileEntry { options: { id: string } }
interface ConfigEditor { edit(entry: ProfileEntry, change: (raw: unknown) => unknown): Promise<unknown> }

export function apply(ctx: Context, config: Record<string, ChannelConfigRef | undefined> = {}): void {
  const states = new Map<string, ChannelState>()
  const credentials = () => ctx.get('credentials') as CredentialProvider | undefined
  const attachments = () => ctx.get('attachments')
  /** 插件卸载后停止启动门控轮询。 */
  const gateStopped = new Map<string, boolean>()
  const entry = (ctx as unknown as { fiber?: { entry?: ProfileEntry } }).fiber?.entry
  /** 配置中心表单的命名空间就是本插件的 profile 条目 id；provider 的设置链接指向这里。 */
  const settingsNs = entry?.options.id ?? name

  // 配置写回按提交顺序串行：同一条目的两次 edit 交错会互相覆盖。
  let saves: Promise<unknown> = Promise.resolve()
  const writeChannelConfig = async (id: string, patch: ChannelConfig): Promise<void> => {
    const editor = ctx.get('configEditor') as ConfigEditor | undefined
    if (entry === undefined || editor === undefined) {
      logLine(`[${id}] 没有 configEditor 或 profile 条目，配置只在本次运行里生效，重启后不保留`)
      return
    }
    const saved = saves.then(() => editor.edit(entry, (raw) => {
      const current = raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : {}
      const section = current[id] !== null && typeof current[id] === 'object' ? current[id] as ChannelConfig : {}
      return { ...current, [id]: { ...section, ...patch } }
    }))
    saves = saved.catch(() => {})
    await saved
  }

  // ---------- 每个渠道：构建 ctx + runtime ----------
  for (const def of CHANNELS) {
    const st: ChannelState = {
      def,
      runtime: undefined as unknown as ChannelRuntime,
      channelCtx: undefined as unknown as ChannelContext,
    }
    states.set(def.id, st)

    const ref = credentialRef(def.tokenRefName)
    const readToken = async (): Promise<StoredToken | undefined> => {
      const c = credentials()
      if (!c) return undefined
      const hit = await c.resolve(ref)
      if (!hit) return undefined
      try {
        const t = JSON.parse(hit.value) as StoredToken
        if (t && typeof t.refresh === 'string' && typeof t.access === 'string') return t
      } catch {
        /* corrupt → treat as absent */
      }
      return undefined
    }
    const writeToken = async (token: StoredToken): Promise<void> => {
      const c = credentials()
      if (c) await c.set(ref, JSON.stringify(token))
    }
    const clearToken = async (): Promise<void> => {
      const c = credentials()
      if (c) await c.unset(ref)
    }
    const getRaw = (): ChannelConfig => config[def.id]?.get() ?? {}

    const channelCtx: ChannelContext = {
      id: def.id,
      tokenRefName: def.tokenRefName,
      options: () => resolveOptions(getRaw(), st.discovered?.models, def),
      getConfig: getRaw,
      updateConfig: (patch) => writeChannelConfig(def.id, patch),
      credentials,
      attachments,
      log: logLine,
      notifyModelsChanged: () => {
        try {
          st.replaceRegistration?.()
        } catch (error) {
          logLine(`模型列表刷新通知失败: ${(error as Error)?.message ?? error}`)
        }
      },
      readToken,
      writeToken,
      clearToken,
      afterLogin: () => {
        void discoverAndStore(st)
      },
    }
    st.channelCtx = channelCtx
    st.runtime = def.create(channelCtx)
  }

  // ---------- 官方模型列表发现（通用：拉取 → 缓存 → 持久化 → 通知） ----------
  /**
   * 拉官方模型列表 → 缓存 → 写回配置 → 通知。并发的触发共用同一次请求。
   * 令牌过期由各渠道的 discoverModels 先刷新，这里只看登没登录。
   */
  function discoverAndStore(st: ChannelState): Promise<void> {
    st.discovering ??= (async () => {
      const token = await st.channelCtx.readToken()
      if (!token) return
      const found = await st.runtime.discoverModels()
      if (found.length === 0) {
        logLine(`[${st.def.id}] 没发现到模型（原因见上一行，没有上一行就是接口返回了空列表），模型列表先用${(st.channelCtx.getConfig().discoveredModels?.length ?? 0) > 0 ? '上次保存的' : '内置兜底'}的`)
        return
      }
      st.discovered = { models: found, at: Date.now() }
      try {
        await st.channelCtx.updateConfig({ discoveredModels: found })
      } catch (error) {
        logLine(`[${st.def.id}] 模型列表写回配置失败，本次运行照常用新列表，重启后会退回旧的：${(error as Error)?.message ?? error}`)
      }
      st.channelCtx.notifyModelsChanged()
      logLine(`[${st.def.id}] 已发现 ${found.length} 个订阅模型：${found.map((m) => m.id).join(', ')}`)
    })().finally(() => {
      st.discovering = undefined
    })
    return st.discovering
  }

  async function logoutChannel(st: ChannelState): Promise<void> {
    await st.runtime.logout()
    st.discovered = undefined
    // 注销后从模型列表移除该提供商（未登录不再占用模型选择器）。
    st.syncRegistration?.(false)
    try {
      await st.channelCtx.updateConfig({ discoveredModels: [] })
    } catch (error) {
      logLine(`清除模型列表失败: ${(error as Error)?.message ?? error}`)
    }
    logLine(`[${st.def.id}] 已注销，清除令牌与模型列表`)
  }

  // ---------- provider + adapter 注册（按登录状态门控） ----------
  // 未登录的渠道不注册 provider/adapter：其模型不会出现在模型选择器里。
  // 登录成功（afterLogin → discoverAndStore → notifyModelsChanged）后注册，
  // 注销时撤销。registerConfigurableProviders / registerAdapter 初次注册
  // 必须至少一个条目，因此先全量注册，再按令牌状态异步收窄（令牌读取是
  // 异步的，且发生在启动早期，UI 目录加载前即可收敛）。
  for (const def of CHANNELS) {
    const st = states.get(def.id)!
    const entry = {
      provider: def.id,
      displayName: def.displayName,
      settingsNs,
      settingsPath: [def.id],
    }
    const providersHandle = ctx.llm.registerConfigurableProviders([entry])
    const adapterHandle = ctx.llm.registerAdapter([def.id], st.runtime.adapter)
    let registered = true
    const sync = (next: boolean, announce: boolean): void => {
      if (next === registered && !announce) return
      providersHandle.replace(next ? [entry] : [])
      adapterHandle.replace(next ? [def.id] : [])
      registered = next
    }
    st.syncRegistration = (next: boolean) => sync(next, false)
    // 模型发现后刷新（announce：即使注册状态没变也发 llm/adapters-updated，
    // 让模型选择器等 UI 重新拉取发现到的模型列表）。
    st.replaceRegistration = () => sync(true, true)
    // 启动门控：credential 服务可能晚于本插件激活（apply 时序竞态），
    // 若尚未就绪则轮询等待（约 60s 上限；插件卸载即停止），再读令牌决定
    // 是否注册 provider + 触发模型发现。否则未就绪时会把已登录的渠道误判
    // 为未登录而撤销注册，导致启动后模型列表为空，直到访问设置页兜底。
    let attempts = 0
    const gate = async (): Promise<void> => {
      if (gateStopped.get(def.id) === true || attempts >= 200) return
      attempts += 1
      if (credentials() === undefined) {
        setTimeout(() => { void gate() }, 300)
        return
      }
      const token = await st.channelCtx.readToken()
      if (gateStopped.get(def.id) === true) return
      const loggedIn = token !== undefined
      sync(loggedIn, false)
      logLine(`[${def.id}] 登录状态: ${loggedIn ? '已登录，注册 provider' : '未登录，不注册 provider'}`)
      // 已登录但内存没有发现结果（如升级后存量会话）：顺手触发一次发现。
      if (loggedIn) void discoverAndStore(st)
    }
    void gate()
  }

  // ---------- 插件停止时中止所有进行中的登录会话与启动门控轮询 ----------
  ctx.effect(() => () => {
    for (const def of CHANNELS) gateStopped.set(def.id, true)
    for (const st of states.values()) st.runtime.cancelLogin()
  }, 'subscription-auth.auth-cleanup')

  // ---------- 配置中心「订阅服务」页的 RPC 端点（Typert Gateway 的 /api 通道）----------
  // 不再挂 webServer 路由：官方 Electron 壳的组合补丁把 webserver 行 disabled
  // （apps/desktop-host/config/desktop.cordis.patch.yml），缺服务时注册不成立，
  // 页面的 fetch 只落到静态处理的 SPA 回退拿到 index.html。gateway 的 /api
  // interceptor 是官方壳唯一通行、legacy 壳同样具备的通道（见 src/remote.ts）。
  const channelCard = async (st: ChannelState): Promise<Record<string, unknown>> => {
    let state = await st.runtime.authStatus()
    // 已登录但还没有发现结果：当场发现并等它（最多 10 秒）再回列表。以前是
    // 触发了就走，页面在登录完成那一刻拿到的永远是兜底列表，之后也不会再刷新。
    if (state.status === 'logged-in' && st.discovered === undefined) {
      await Promise.race([
        discoverAndStore(st),
        new Promise((resolve) => setTimeout(resolve, 10_000)),
      ])
      // 发现前可能刷新过令牌，状态里的有效期跟着更新。
      state = await st.runtime.authStatus()
    }
    const resolved = resolveOptions(st.channelCtx.getConfig(), st.discovered?.models, st.def)
    return {
      id: st.def.id,
      name: st.def.name,
      description: st.def.description,
      models: resolved.models.map((m) => m.id),
      modelsSource: resolved.modelsSource,
      ...(st.discovered !== undefined ? { discoveredAt: st.discovered.at } : {}),
      ...state,
    }
  }

  const remoteDeps: SubscriptionAuthRemoteDeps = {
    providers: async () => {
      const providers: Record<string, unknown>[] = []
      for (const def of CHANNELS) providers.push(await channelCard(states.get(def.id)!))
      return providers
    },
    login: async (provider) => {
      const st = states.get(provider)
      // 抛错由 gateway 包成 failure 信封，客户端按 error.message 显示。
      if (st === undefined) throw new Error(`unknown provider: ${provider}`)
      return await st.runtime.login()
    },
    logout: async (provider) => {
      const st = states.get(provider)
      if (st === undefined) throw new Error(`unknown provider: ${provider}`)
      await logoutChannel(st)
      return { ok: true }
    },
  }

  // 与 plugins/dsh-update-watch 同形：动态 import 让协议包只在真正挂载时才解析，
  // 终端型 profile（没有 gateway）不会因此加载失败；协议包不在场时只降级为
  // 「页面读不到列表」，不影响已登录渠道的 provider/adapter 注册。
  ctx.effect(() => {
    let disposed = false
    void import('./remote.js')
      .then(({ createSubscriptionAuthRemote }) => {
        if (!disposed) ctx.plugin(createSubscriptionAuthRemote(remoteDeps))
      })
      .catch((error: unknown) => {
        logLine(`订阅服务 RPC 端点未挂载: ${error instanceof Error ? error.message : String(error)}`)
      })
    return () => {
      disposed = true
    }
  }, 'subscription-auth: settings remote')
}
