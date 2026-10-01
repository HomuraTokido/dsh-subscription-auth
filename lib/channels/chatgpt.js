import { LlmError } from "@deepseek-ai/dsh-llm";
import { ChatGptAdapter } from "../adapter.js";
import {
  buildAuthorizeUrl,
  exchangeCode,
  generatePkce,
  openBrowser,
  refreshAccessToken,
  waitForCallback
} from "../oauth.js";
import { fetchCodexModels, resolveCodexClientVersion } from "../discovery.js";
const DEFAULT_MODELS = [
  { id: "gpt-5.5", name: "GPT-5.5", contextWindow: 4e5 },
  { id: "gpt-5.4", name: "GPT-5.4", contextWindow: 4e5 },
  { id: "gpt-5.4-mini", name: "GPT-5.4 Mini", contextWindow: 4e5 },
  { id: "gpt-5.3-codex-spark", name: "GPT-5.3 Codex Spark", contextWindow: 4e5 },
  { id: "gpt-5.5-pro", name: "GPT-5.5 Pro", contextWindow: 4e5 }
];
const REASONING = {
  efforts: [
    { id: "minimal", name: "Minimal" },
    { id: "low", name: "Low" },
    { id: "medium", name: "Medium" },
    { id: "high", name: "High" }
  ],
  defaultEffort: "medium"
};
const chatgptChannel = {
  id: "chatgpt",
  displayName: "ChatGPT (\u8BA2\u9605)",
  name: "ChatGPT \u8BA2\u9605",
  description: "\u7528 ChatGPT Plus/Pro \u8BA2\u9605\u989D\u5EA6\u8BBF\u95EE codex \u7CFB\u6A21\u578B\uFF08\u6A21\u578B\u5217\u8868\u767B\u5F55\u540E\u81EA\u52A8\u4ECE\u5B98\u65B9 API \u83B7\u53D6\uFF09",
  tokenRefName: "CHATGPT_SUBSCRIPTION_TOKEN",
  defaultApiBaseURL: "https://chatgpt.com/backend-api/codex/responses",
  defaultRedirectPort: 1455,
  defaultContextWindow: 4e5,
  defaultMaxTokens: 8192,
  defaultModels: DEFAULT_MODELS,
  reasoning: REASONING,
  create(ctx) {
    let controller;
    let pending;
    const freshToken = async () => {
      const token = await ctx.readToken();
      if (!token) return void 0;
      if (token.expires - Date.now() >= 6e4) return token;
      const refreshed = await refreshAccessToken(token.refresh);
      await ctx.writeToken(refreshed);
      return refreshed;
    };
    const adapter = new ChatGptAdapter({
      options: () => ({
        apiBaseURL: ctx.options().apiBaseURL,
        maxTokens: ctx.options().maxTokens,
        models: ctx.options().models,
        defaultContextWindow: ctx.options().defaultContextWindow
      }),
      attachments: ctx.attachments,
      reasoning: REASONING,
      resolveAccessToken: async () => {
        const token = await freshToken();
        if (!token) {
          throw new LlmError("chatgpt: \u672A\u767B\u5F55\u3002\u8BF7\u5728 \u8BBE\u7F6E \u2192 \u8BA2\u9605\u670D\u52A1 \u91CC\u5B8C\u6210\u8BA2\u9605\u8D26\u53F7\u6388\u6743\u3002", "MISSING_CREDENTIAL");
        }
        return { access: token.access };
      },
      label: "chatgpt",
      displayName: "ChatGPT (\u8BA2\u9605)"
    });
    return {
      adapter,
      async login() {
        const existing = await ctx.readToken();
        if (existing && existing.expires > Date.now() + 6e4) {
          return { status: "logged-in", account: existing.accountId };
        }
        this.cancelLogin();
        const port = ctx.options().redirectPort;
        const { verifier, challenge } = generatePkce();
        const state = verifier;
        const url = buildAuthorizeUrl(port, challenge, state);
        controller = new AbortController();
        pending = { url };
        waitForCallback(port, state, controller.signal).then(async (code) => {
          ctx.log("\u6536\u5230\u6388\u6743\u56DE\u8C03\uFF0C\u5F00\u59CB\u6362\u53D6\u4EE4\u724C\u2026");
          const token = await exchangeCode(code, port, verifier);
          await ctx.writeToken(token);
          ctx.log(`\u767B\u5F55\u6210\u529F${token.accountId ? `\uFF08account: ${token.accountId}\uFF09` : ""}\uFF0C\u5F00\u59CB\u53D1\u73B0\u6A21\u578B\u5217\u8868\u2026`);
          ctx.afterLogin();
        }).catch((error) => {
          if (controller && !controller.signal.aborted) ctx.log(`\u767B\u5F55\u5931\u8D25: ${error?.message ?? error}`);
        }).finally(() => {
          pending = void 0;
        });
        openBrowser(url);
        return { status: "pending", url };
      },
      async authStatus() {
        const token = await ctx.readToken();
        if (token) {
          return { provider: ctx.id, status: "logged-in", account: token.accountId, expiresAt: token.expires };
        }
        if (pending && controller && !controller.signal.aborted) {
          return { provider: ctx.id, status: "pending", url: pending.url };
        }
        return { provider: ctx.id, status: "not-logged-in" };
      },
      async logout() {
        this.cancelLogin();
        await ctx.clearToken();
      },
      cancelLogin() {
        if (controller && !controller.signal.aborted) controller.abort();
        controller = void 0;
        pending = void 0;
      },
      async discoverModels() {
        try {
          const token = await freshToken();
          if (!token) return [];
          const clientVersion = ctx.options().clientVersion ?? await resolveCodexClientVersion(ctx.log);
          return await fetchCodexModels(
            token.access,
            token.accountId,
            ctx.options().apiBaseURL.replace(/\/codex\/responses$/, ""),
            void 0,
            clientVersion
          );
        } catch (error) {
          ctx.log(`\u6A21\u578B\u5217\u8868\u53D1\u73B0\u5931\u8D25: ${error?.message ?? error}`);
          return [];
        }
      }
    };
  }
};
export {
  chatgptChannel
};
