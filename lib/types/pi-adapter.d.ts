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
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai';
import type { PiAiAdapterOptions, ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai';
import type { Api, Model, ProviderStreams, ThinkingBudgets, ThinkingLevelMap } from '@earendil-works/pi-ai';
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment';
import type { ChannelReasoning } from './channel.js';
/** 本插件用到的三条 pi-ai wire 协议。 */
export type PiApiId = 'openai-codex-responses' | 'openai-responses' | 'anthropic-messages';
/** 模型描述（与 adapter.ts 的 AdapterModel 同形；本文件不反向依赖，避免循环导入）。 */
export interface PiAdapterModel {
    id: string;
    name: string;
    contextWindow?: number;
}
/** 一次快照读到的渠道配置。 */
export interface PiAdapterRouteOptions {
    apiBaseURL: string;
    maxTokens: number;
    models: readonly PiAdapterModel[];
    defaultContextWindow: number;
    /** 渠道要求的额外请求头（Anthropic 系：oauth / Kimi 头）。 */
    headers?: Record<string, string>;
}
/** 一个渠道路由交给适配器装配的全部信息。 */
export interface PiAdapterRoute {
    /** 路由 id，同时是 provider id 与 `models.provider`（chatgpt / claude / grok / kimi）。 */
    provider: string;
    displayName: string;
    /** 覆盖协议推断（缺省按路由名推断）。 */
    protocol?: PiApiId;
    options(): PiAdapterRouteOptions;
    /** 共享事务的 refresh 入口：每次 stream 调用前解析一次可用 access token。 */
    resolveAccessToken(): Promise<{
        access: string;
    }>;
    reasoning?: ChannelReasoning;
    attachments?: () => AttachmentStore | undefined;
    log?(message: string): void;
}
/** 协议推断（未声明的路由按 Responses 处理，保持自包含可用）。 */
export declare function protocolForRoute(provider: string): PiApiId;
/** 协议对应的公开 lazy 工厂。SDK 负责协议细节，这里只挑工厂。 */
export declare function protocolApi(protocol: PiApiId): ProviderStreams;
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
export declare function normalizeBaseUrl(apiBaseURL: string, protocol: PiApiId): string;
/** 内置目录里这个路由的 model metadata，按 id 索引；目录没有就空表。 */
export declare function catalogModelsFor(provider: string): Map<string, Model<Api>>;
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
export declare function thinkingLevelMap(reasoning: ChannelReasoning | undefined, catalog: Model<Api> | undefined): ThinkingLevelMap | undefined;
/** 渠道声明的档位预算 → `ThinkingBudgets`（未声明预算的档位用旧兜底值）。 */
export declare function thinkingBudgets(reasoning: ChannelReasoning | undefined): ThinkingBudgets | undefined;
/**
 * 一个渠道模型条目 → pi-ai `Model`：用户列表优先，目录只补它自己的 metadata。
 *
 * 目录条目里除 id/name/contextWindow 以外的字段（`compat`、`inputLimits`、
 * `headers`、`promptCache`、`samplingParams`…）必须原样保留：丢了 `compat`
 * 里的 `forceAdaptiveThinking`，自适应 Claude 会退化成预算式思考。
 * `contextWindow` 严格按「条目 → defaultContextWindow」，不拿目录值偷换渠道
 * 解析出来的上下文大小。
 */
export declare function buildPiModel(route: PiAdapterRoute, protocol: PiApiId, baseUrl: string, entry: PiAdapterModel, options: PiAdapterRouteOptions, catalog: Map<string, Model<Api>>): Model<Api>;
/**
 * 按公开类型手工构建一条路由的 profiles：内容相同复用同一个 ReadonlyMap，
 * 变化则连 provider 一起重建（SDK 用身份识别快照）。
 */
export declare function createProfilesResolver(route: PiAdapterRoute): () => ReadonlyMap<string, ResolvedPiAiProviderProfile>;
/** 渠道路由 → PiAiAdapter 构造选项（订阅渠道共用的装配入口）。 */
export declare function piAdapterOptions(route: PiAdapterRoute): PiAiAdapterOptions;
/** 直接构造一个 PiAiAdapter（测试与薄封装共用）。 */
export declare function createPiAdapter(route: PiAdapterRoute): PiAiAdapter;
