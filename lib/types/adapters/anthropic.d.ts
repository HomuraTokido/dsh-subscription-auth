/**
 * Anthropic Messages API 适配器（Claude 订阅 / Kimi Code 共用）：本文件只是宿主
 * 原生 {@link PiAiAdapter} 的薄封装（协议固定 anthropic-messages），保留原有
 * 构造接口，模型 / 工具 / 图片 / 思考 / signature replay 的 wire 转换交给 SDK。
 * @module dsh-subscription-auth/adapters/anthropic
 */
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai';
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment';
import type { AdapterModel } from '../adapter.js';
import type { ChannelReasoning } from '../channel.js';
export interface AnthropicAdapterOptions {
    apiBaseURL: string;
    maxTokens: number;
    models: readonly AdapterModel[];
    defaultContextWindow: number;
    /** 每个请求附带的额外请求头（如 anthropic-version / anthropic-beta / Kimi 头）。 */
    headers?: () => Record<string, string>;
}
export interface AnthropicAdapterConfig {
    /** 每次请求前读取最新配置。 */
    options(): AnthropicAdapterOptions;
    /** 每次请求前解析（必要时刷新）出可用的 access token。 */
    resolveAccessToken(): Promise<{
        access: string;
    }>;
    /** 思考强度档位（缺省不提供）；档位预算经 profile.thinkingBudgets 交给 SDK。 */
    reasoning?: ChannelReasoning;
    /** 附件服务访问器（缺省或返回 undefined 时，图片消息以文字占位符发送）。 */
    attachments?: () => AttachmentStore | undefined;
    /** 错误信息与 providerInfo 里的标签（默认 'anthropic' / 'Claude (订阅)'）。 */
    label?: string;
    displayName?: string;
    /** 可选日志（replay 降级等）。 */
    log?(message: string): void;
}
/** Claude / Kimi 路由的本地适配器：路由 id 取 label（claude / kimi）。 */
export declare class AnthropicMessagesAdapter extends PiAiAdapter {
    constructor(cfg: AnthropicAdapterConfig);
}
