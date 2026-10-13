import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { piAdapterOptions } from "../pi-adapter.js";
class AnthropicMessagesAdapter extends PiAiAdapter {
  constructor(cfg) {
    super(piAdapterOptions({
      provider: cfg.label ?? "anthropic",
      displayName: cfg.displayName ?? "Claude (\u8BA2\u9605)",
      protocol: "anthropic-messages",
      // 渠道的 headers 函数是每次操作现取的：这里立刻求值成快照的一部分
      options: () => {
        const o = cfg.options();
        const headers = o.headers?.();
        return {
          apiBaseURL: o.apiBaseURL,
          maxTokens: o.maxTokens,
          models: o.models,
          defaultContextWindow: o.defaultContextWindow,
          ...headers !== void 0 ? { headers } : {}
        };
      },
      resolveAccessToken: () => cfg.resolveAccessToken(),
      ...cfg.reasoning !== void 0 ? { reasoning: cfg.reasoning } : {},
      ...cfg.attachments !== void 0 ? { attachments: () => cfg.attachments?.() } : {},
      ...cfg.log !== void 0 ? { log: cfg.log } : {}
    }));
  }
}
export {
  AnthropicMessagesAdapter
};
