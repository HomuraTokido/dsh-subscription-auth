/**
 * 订阅渠道的 pi-ai 适配器装配层：把手写的 Responses / Anthropic 协议实现换成
 * 宿主公开的 {@link PiAiAdapter}（`@deepseek-ai/dsh-llm-pi-ai`），本文件只做
 * 「渠道配置 → 公开 profile / provider 选项」的映射，消息、工具、图片、思考
 * 与 replay 的 wire 转换全部交给 SDK。
 *
 * 三条约束决定了这里的形状：
 *  - **每个操作一次快照**：`options()` 每次操作同步读一次渠道配置；内容没变
 *    就复用同一个 `ReadonlyMap`（SDK 按身份识别配置未变），变了就建新 map +
 *    新 provider，绝不原地改正在用的快照。
 *  - **路由自持 auth**：access token 由本插件的事务层提供，SDK 自己的 OAuth
 *    持久化被显式关掉（空只读 CredentialStore + 无 ambient 的 AuthContext），
 *    请求级 apiKey 通过 `resolveApiKey` 注入——它就是我们 refresh 的入口。
 *  - **协议选择走公开 lazy factory**：codex / OpenAI Responses / Anthropic
 *    Messages 各自用 pi-ai 公开的 `.lazy` 工厂，不深导入宿主内部实现。
 * @module dsh-subscription-auth/pi-adapter
 */
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { PiAiAdapterOptions, ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { createProvider } from '@earendil-works/pi-ai'
import type {
  Api,
  AuthContext,
  CredentialStore,
  Model,
  ModelThinkingLevel,
  Provider,
  ProviderStreams,
  ThinkingBudgets,
  ThinkingLevelMap,
} from '@earendil-works/pi-ai'
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import { openAICodexResponsesApi } from '@earendil-works/pi-ai/api/openai-codex-responses.lazy'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { ChannelReasoning } from './channel.js'

/** 本插件用到的三条 pi-ai wire 协议。 */
export type PiApiId = 'openai-codex-responses' | 'openai-responses' | 'anthropic-messages'

/** 模型描述（与 adapter.ts 的 AdapterModel 同形；本文件不反向依赖，避免循环导入）。 */
export interface PiAdapterModel {
  id: string
  name: string
  contextWindow?: number
}

/** 一次快照读到的渠道配置。 */
export interface PiAdapterRouteOptions {
  apiBaseURL: string
  maxTokens: number
  models: readonly PiAdapterModel[]
  defaultContextWindow: number
  /** 渠道要求的额外请求头（Anthropic 系：oauth / Kimi 头）。 */
  headers?: Record<string, string>
}

/** 一个渠道路由交给适配器装配的全部信息。 */
export interface PiAdapterRoute {
  /** 路由 id，同时是 provider id 与 `models.provider`（chatgpt / claude / grok / kimi）。 */
  provider: string
  displayName: string
  /** 覆盖协议推断（缺省按路由名推断）。 */
  protocol?: PiApiId
  options(): PiAdapterRouteOptions
  /** 共享事务的 refresh 入口：每次 stream 调用前解析一次可用 access token。 */
  resolveAccessToken(): Promise<{ access: string }>
  reasoning?: ChannelReasoning
  attachments?: () => AttachmentStore | undefined
  log?(message: string): void
}

/** 路由 → 协议：Grok 走 OpenAI Responses，ChatGPT 走 codex Responses。 */
const PROTOCOL_BY_ROUTE: Record<string, PiApiId> = {
  chatgpt: 'openai-codex-responses',
  grok: 'openai-responses',
  claude: 'anthropic-messages',
  kimi: 'anthropic-messages',
}

/**
 * 路由 → pi-ai 内置目录 provider id（借它的模型 metadata）。
 * `kimi` 的内置 id 是 `kimi-coding`；目录里没有的路由返回 undefined，
 * 走安全自包含（模型元数据全部由渠道配置给出）。
 */
const CATALOG_BY_ROUTE: Record<string, string> = {
  chatgpt: 'openai-codex',
  claude: 'anthropic',
  grok: 'xai',
  kimi: 'kimi-coding',
}

/** pi 的思考等级，按升级顺序；`off` 明确允许（发空 = 不带参数）。 */
const ALL_THINKING_LEVELS: readonly ModelThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
/** 能带 token 预算的等级（`ThinkingBudgets` 的真实键，不含 xhigh / max）。 */
const BUDGET_LEVELS: readonly (keyof ThinkingBudgets)[] = ['minimal', 'low', 'medium', 'high']

/** 渠道 effort id 是否是 `ThinkingBudgets` 的键。 */
function isBudgetLevel(value: string): value is keyof ThinkingBudgets {
  return (BUDGET_LEVELS as readonly string[]).includes(value)
}
/** 渠道没给预算时的兜底（沿用改造前 Anthropic 适配器的 16384）。 */
const LEGACY_THINKING_BUDGET = 16_384
/** 没声明图片能力的模型沿用改造前的能力：文本 + 图片。 */
const DEFAULT_INPUT: readonly ('text' | 'image')[] = ['text', 'image']
/** provider 空闲超时：与宿主默认一致（300s）。 */
const STREAM_IDLE_TIMEOUT_MS = 300_000
/** 单请求图片 base64 上限：与宿主默认一致（20MiB）。 */
const MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024
/** 单张图片请求版本的像素预算：2048×2048（宿主默认保持完整归一化附件）。 */
const REQUEST_IMAGE_PIXEL_BUDGET = 2048 * 2048
/** 请求版本原始字节目标：1MiB（质量梯度里最小的输出兜底）。 */
const REQUEST_IMAGE_MAX_BYTES = 1024 * 1024

/** 协议推断（未声明的路由按 Responses 处理，保持自包含可用）。 */
export function protocolForRoute(provider: string): PiApiId {
  return PROTOCOL_BY_ROUTE[provider] ?? 'openai-codex-responses'
}

/** 协议对应的公开 lazy 工厂。SDK 负责协议细节，这里只挑工厂。 */
export function protocolApi(protocol: PiApiId): ProviderStreams {
  switch (protocol) {
    case 'openai-codex-responses': return openAICodexResponsesApi()
    case 'openai-responses': return openAIResponsesApi()
    case 'anthropic-messages': return anthropicMessagesApi()
  }
}

/**
 * SDK 的 factory 会自己往 baseURL 追加协议路径：Responses 追加 `/responses`，
 * Anthropic 追加 `/v1/messages`。渠道配置里带的那个尾段要先裁掉，避免拼成
 * `.../responses/responses` 或 `.../v1/v1/messages`。
 *
 * Anthropic 只裁自己协议的尾段（`/v1/messages`、裸 `/messages`、裸 `/v1`）：
 *   https://api.anthropic.com/v1/messages → https://api.anthropic.com
 *   https://api.kimi.com/coding/v1/messages → https://api.kimi.com/coding
 * 自定义根路径里的其它段（如 `/coding`）一律保留；**不**把「裁 /v1」套到
 * Responses / codex 上（它们只裁 `/responses`）。
 */
export function normalizeBaseUrl(apiBaseURL: string, protocol: PiApiId): string {
  const trimmed = apiBaseURL.trim().replace(/\/+$/, '')
  if (protocol === 'anthropic-messages') {
    for (const suffix of ['/v1/messages', '/messages', '/v1'] as const) {
      if (trimmed.endsWith(suffix)) return trimmed.slice(0, -suffix.length)
    }
    return trimmed
  }
  const suffix = '/responses'
  return trimmed.endsWith(suffix) ? trimmed.slice(0, -suffix.length) : trimmed
}

/** 内置目录里这个路由的 model metadata，按 id 索引；目录没有就空表。 */
export function catalogModelsFor(provider: string): Map<string, Model<Api>> {
  const catalogId = CATALOG_BY_ROUTE[provider]
  if (catalogId === undefined) return new Map()
  try {
    const models = getBuiltinModels(catalogId as never) as readonly Model<Api>[]
    return new Map(models.map((model) => [model.id, model]))
  } catch {
    // 目录里没有这个 provider（或版本漂移）：安全自包含
    return new Map()
  }
}

/**
 * 渠道声明的档位 → `Model.thinkingLevelMap`。取值词汇由 pi-ai 定：
 *  - 字符串 = 该档位的 wire 值（`off` 也允许，如 `'off'`）；
 *  - `null` = 该档位不支持（禁用）；
 *  - 空字符串 = 该档位不发思考参数（pi-ai 据此省略 `output_config.effort`）。
 *
 * 目录（catalog）声明过的键以目录为准，含它显式禁用的档位——渠道声明不能把
 * 这些被目录禁用的档位扩增回来；目录没提的档位才按渠道 efforts 映射（wire 值
 * 就是档位名），其余显式 null。
 */
export function thinkingLevelMap(
  reasoning: ChannelReasoning | undefined,
  catalog: Model<Api> | undefined,
): ThinkingLevelMap | undefined {
  const catalogMap = catalog?.thinkingLevelMap
  if (reasoning === undefined && catalogMap === undefined) return undefined
  const map: ThinkingLevelMap = {}
  for (const level of ALL_THINKING_LEVELS) {
    if (catalogMap !== undefined && level in catalogMap) {
      const declared = catalogMap[level]
      // 目录说什么就是什么：null=禁用、''=不发思考参数、字符串=wire 值
      map[level] = declared === undefined ? null : declared
      continue
    }
    if (reasoning?.efforts.some((effort) => effort.id === level)) {
      // 渠道声明的档位：wire 值就是档位名；off 也允许（'off' = 这一档可用）
      map[level] = level
      continue
    }
    map[level] = null
  }
  return map
}

/** 渠道声明的档位预算 → `ThinkingBudgets`（未声明预算的档位用旧兜底值）。 */
export function thinkingBudgets(reasoning: ChannelReasoning | undefined): ThinkingBudgets | undefined {
  if (reasoning === undefined) return undefined
  const budgets: ThinkingBudgets = {}
  let any = false
  for (const effort of reasoning.efforts) {
    if (!isBudgetLevel(effort.id)) continue
    budgets[effort.id] = effort.budgetTokens ?? LEGACY_THINKING_BUDGET
    any = true
  }
  return any ? budgets : undefined
}

/** 渠道默认档位 → profile 级 reasoning（pi 等级）。 */
function defaultThinkingLevel(reasoning: ChannelReasoning | undefined): ModelThinkingLevel | undefined {
  const effort = reasoning?.defaultEffort
  return effort !== undefined && (ALL_THINKING_LEVELS as readonly string[]).includes(effort)
    ? effort as ModelThinkingLevel
    : undefined
}

/**
 * 一个渠道模型条目 → pi-ai `Model`：用户列表优先，目录只补它自己的 metadata。
 *
 * 目录条目里除 id/name/contextWindow 以外的字段（`compat`、`inputLimits`、
 * `headers`、`promptCache`、`samplingParams`…）必须原样保留：丢了 `compat`
 * 里的 `forceAdaptiveThinking`，自适应 Claude 会退化成预算式思考。
 * `contextWindow` 严格按「条目 → defaultContextWindow」，不拿目录值偷换渠道
 * 解析出来的上下文大小。
 */
export function buildPiModel(
  route: PiAdapterRoute,
  protocol: PiApiId,
  baseUrl: string,
  entry: PiAdapterModel,
  options: PiAdapterRouteOptions,
  catalog: Map<string, Model<Api>>,
): Model<Api> {
  const known = catalog.get(entry.id)
  const levels = thinkingLevelMap(route.reasoning, known)
  return {
    // 目录 metadata 先铺底，下面只覆盖本插件自己拥有的字段
    ...(known ?? {}),
    id: entry.id,
    name: entry.name,
    provider: route.provider,
    api: protocol,
    baseUrl,
    input: known !== undefined ? [...known.input] : [...DEFAULT_INPUT],
    cost: known?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: entry.contextWindow ?? options.defaultContextWindow,
    maxTokens: known?.maxTokens ?? options.maxTokens,
    // 渠道声明了思考档位的模型按“可推理”对待；目录怎么说就怎么算
    reasoning: known?.reasoning ?? route.reasoning !== undefined,
    ...(levels !== undefined ? { thinkingLevelMap: levels } : {}),
  }
}

/** 空只读凭据存储：token 由本插件的 credential 事务持有，SDK 不得旁路存一份。 */
function emptyCredentialStore(): CredentialStore {
  return {
    read: async () => undefined,
    list: async () => [],
    modify: async () => {
      throw new Error('subscription-auth owns credential persistence; pi-ai must not write credentials')
    },
    delete: async () => {
      throw new Error('subscription-auth owns credential persistence; pi-ai must not write credentials')
    },
  }
}

/** 无 ambient 来源的 auth context：不允许环境变量 / 文件旁路。 */
function sealedAuthContext(): AuthContext {
  return {
    env: async () => undefined,
    fileExists: async () => false,
  }
}

/**
 * 按公开类型手工构建一条路由的 profiles：内容相同复用同一个 ReadonlyMap，
 * 变化则连 provider 一起重建（SDK 用身份识别快照）。
 */
export function createProfilesResolver(route: PiAdapterRoute): () => ReadonlyMap<string, ResolvedPiAiProviderProfile> {
  let cached: { key: string; profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile> } | undefined
  return () => {
    const options = route.options()
    const protocol = route.protocol ?? protocolForRoute(route.provider)
    const key = JSON.stringify({
      apiBaseURL: options.apiBaseURL,
      maxTokens: options.maxTokens,
      defaultContextWindow: options.defaultContextWindow,
      models: options.models.map((model) => [model.id, model.name, model.contextWindow ?? null]),
      headers: options.headers ?? null,
      reasoning: route.reasoning ?? null,
      protocol,
    })
    if (cached !== undefined && cached.key === key) return cached.profiles
    cached = { key, profiles: buildProfiles(route, protocol, options) }
    return cached.profiles
  }
}

function buildProfiles(
  route: PiAdapterRoute,
  protocol: PiApiId,
  options: PiAdapterRouteOptions,
): ReadonlyMap<string, ResolvedPiAiProviderProfile> {
  const baseUrl = normalizeBaseUrl(options.apiBaseURL, protocol)
  const catalog = catalogModelsFor(route.provider)
  const models = options.models.map((entry) => buildPiModel(route, protocol, baseUrl, entry, options, catalog))
  const budgets = thinkingBudgets(route.reasoning)
  const defaultLevel = defaultThinkingLevel(route.reasoning)
  const configuredMaxTokens = new Map<string, number>(options.models.map((model) => [model.id, options.maxTokens]))

  let piProvider: Provider | undefined
  let catalogError: string | undefined
  try {
    piProvider = createProvider({
      id: route.provider,
      name: route.displayName,
      baseUrl,
      ...(options.headers !== undefined ? { headers: options.headers } : {}),
      auth: {
        // 当次请求派生 auth；secret 只活在这次解析的返回值里，不进 profile / 快照。
        // Anthropic 系必须走 `Authorization: Bearer <access>`：pi-ai 只在 apiKey 带
        // `sk-ant-oat` 时才自己当 OAuth 处理，Kimi 的 access 不是那个形状，所以这里
        // 直接给出 Bearer 头；Claude 的 OAuth 型 access 额外作为 apiKey 交给 pi-ai，
        // 让它保留 OAuth 分支（Bearer + claude-cli 身份头）且不会退回 x-api-key。
        apiKey: {
          name: route.displayName,
          resolve: async ({ credential }) => {
            if (protocol !== 'anthropic-messages') {
              return { auth: { apiKey: credential?.key }, source: route.displayName }
            }
            const access = (await route.resolveAccessToken()).access
            return {
              auth: {
                headers: { authorization: `Bearer ${access}` },
                ...(access.includes('sk-ant-oat') ? { apiKey: access } : {}),
              },
              source: route.displayName,
            }
          },
        },
      },
      api: protocolApi(protocol),
      models,
    })
  } catch (error) {
    // 构建失败的profile 仍然可读（配置可见、可编辑），请求时报 catalogError
    catalogError = error instanceof Error ? error.message : String(error)
  }

  const profile: ResolvedPiAiProviderProfile = {
    provider: route.provider,
    displayName: route.displayName,
    streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
    maxRequestImageBytes: MAX_REQUEST_IMAGE_BYTES,
    requestImagePixelBudget: REQUEST_IMAGE_PIXEL_BUDGET,
    requestImageMaxBytes: REQUEST_IMAGE_MAX_BYTES,
    retryPolicy: resolveRetryPolicy(undefined, `dsh-subscription-auth/${route.provider}`),
    modelErrors: new Map<string, string>(),
    configuredMaxTokens,
    ...(budgets !== undefined ? { thinkingBudgets: budgets } : {}),
    ...(defaultLevel !== undefined ? { reasoning: defaultLevel } : {}),
    ...(options.headers !== undefined ? { headers: options.headers } : {}),
    // codex 端点只走 SSE：现有代理 / 测试流程都按 SSE 设计
    ...(protocol === 'openai-codex-responses' ? { transport: 'sse' as const } : {}),
    ...(piProvider !== undefined ? { piProvider } : {}),
    ...(catalogError !== undefined ? { catalogError } : {}),
  }
  return new Map([[route.provider, profile]])
}

/** 渠道路由 → PiAiAdapter 构造选项（订阅渠道共用的装配入口）。 */
export function piAdapterOptions(route: PiAdapterRoute): PiAiAdapterOptions {
  const protocol = route.protocol ?? protocolForRoute(route.provider)
  return {
    profiles: createProfilesResolver(route),
    // 每次 stream 调用前解析一次；这就是共享事务里 refresh 的入口。
    // Anthropic 的 token 不从这里给：它的 Bearer 头由 provider auth 在当次请求派生，
    // 走 resolveApiKey 的话 SDK 会把它当成 x-api-key（Kimi 的 access 不是 sk-ant-oat）。
    resolveApiKey: async () => {
      if (protocol === 'anthropic-messages') return undefined
      return (await route.resolveAccessToken()).access
    },
    auth: { credentials: emptyCredentialStore(), authContext: sealedAuthContext() },
    ...(route.attachments !== undefined ? { resolveAttachments: () => route.attachments?.() } : {}),
    ...(route.log !== undefined
      ? {
          onReplayDegrade: (detail: { provider: string; model: string; reason: string }) => {
            route.log?.(`[${detail.provider}] ${detail.model} 的历史 replay 状态不可用，已降级为纯文本：${detail.reason}`)
          },
        }
      : {}),
  }
}

/** 直接构造一个 PiAiAdapter（测试与薄封装共用）。 */
export function createPiAdapter(route: PiAdapterRoute): PiAiAdapter {
  return new PiAiAdapter(piAdapterOptions(route))
}
