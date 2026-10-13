import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { piAdapterOptions } from "./pi-adapter.js";
class ChatGptAdapter extends PiAiAdapter {
  constructor(cfg) {
    super(piAdapterOptions({
      provider: cfg.label ?? "chatgpt",
      displayName: cfg.displayName ?? "ChatGPT (\u8BA2\u9605)",
      options: () => cfg.options(),
      resolveAccessToken: () => cfg.resolveAccessToken(),
      ...cfg.reasoning !== void 0 ? { reasoning: cfg.reasoning } : {},
      ...cfg.attachments !== void 0 ? {
        attachments: () => typeof cfg.attachments === "function" ? cfg.attachments() : cfg.attachments
      } : {},
      ...cfg.log !== void 0 ? { log: cfg.log } : {}
    }));
  }
}
export {
  ChatGptAdapter
};
