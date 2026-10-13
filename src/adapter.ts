/**
 * ChatGPT（codex Responses）/ Grok（OpenAI Responses）适配器：本文件只是宿主
 * 原生 {@link PiAiAdapter} 的薄封装，保留原有构造接口（渠道代码不用改），
 * 消息 / 工具 / 图片 / 思考 / replay 的 wire 转换全部由 SDK 负责。
 * @module dsh-subscription-auth/adapter
 */
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { piAdapterOptions } from './pi-adapter.js'
import type { ChannelReasoning } from './channel.js'

/** 渠道声明的模型描述（id / name / contextWindow，界面与发现结果共用）。 */
export interface AdapterModel {
  id: string
  name: string
  contextWindow?: number
}

export interface AdapterOptions {
  apiBaseURL: string
  maxTokens: number
  models: readonly AdapterModel[]
  defaultContextWindow: number
}

export interface AdapterConfig {
  /** 每次请求前读取最新配置（适配器不缓存配置快照）。 */
  options(): AdapterOptions
  /** 每次请求前解析（必要时刷新）出可用的 access token。 */
  resolveAccessToken(): Promise<{ access: string }>
  /** 思考强度档位（缺省不提供）。 */
  reasoning?: ChannelReasoning
  /** 错误信息与 providerInfo 里的标签（默认 'chatgpt' / 'ChatGPT (订阅)'）。 */
  label?: string
  displayName?: string
  /** 附件服务访问器（缺省时图片以文字占位符发送）。 */
  attachments?: AttachmentStore | (() => AttachmentStore | undefined)
  /** 可选日志（replay 降级等）。 */
  log?(message: string): void
}

/** ChatGPT / Grok 路由的本地适配器：路由 id 取 label（chatgpt / grok）。 */
export class ChatGptAdapter extends PiAiAdapter {
  constructor(cfg: AdapterConfig) {
    super(piAdapterOptions({
      provider: cfg.label ?? 'chatgpt',
      displayName: cfg.displayName ?? 'ChatGPT (订阅)',
      options: () => cfg.options(),
      resolveAccessToken: () => cfg.resolveAccessToken(),
      ...(cfg.reasoning !== undefined ? { reasoning: cfg.reasoning } : {}),
      ...(cfg.attachments !== undefined
        ? {
            attachments: () => (typeof cfg.attachments === 'function' ? cfg.attachments() : cfg.attachments),
          }
        : {}),
      ...(cfg.log !== undefined ? { log: cfg.log } : {}),
    }))
  }
}
