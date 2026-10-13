import { LlmError } from "@deepseek-ai/dsh-llm";
import { ChatGptAdapter } from "../adapter.js";
import {
  buildAuthorizeUrl,
  callbackRedirectUri,
  exchangeAuthorizationCode,
  FALLBACK_REDIRECT_PORT,
  generatePkce,
  openBrowser,
  REDIRECT_PORT,
  refreshAccessToken,
  startCallbackListener
} from "../oauth.js";
import {
  exchangeDeviceAuthorization,
  requestDeviceAuthorization,
  waitForDeviceAuthorization
} from "../chatgpt-device-auth.js";
import { fetchCodexModels, resolveCodexClientVersion } from "../discovery.js";
import { AuthSession } from "../auth-session.js";
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
const LOGIN_TIMEOUT_MS = 10 * 60 * 1e3;
function callbackPortCandidates(configured) {
  const registered = [REDIRECT_PORT, FALLBACK_REDIRECT_PORT];
  return registered.includes(configured) ? [configured, ...registered.filter((port) => port !== configured)] : registered;
}
function isPortUnavailable(error) {
  const code = error?.code;
  return code === "EACCES" || code === "EADDRINUSE";
}
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
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
    const session = new AuthSession({
      log: ctx.log,
      write: (token, isCurrent) => ctx.writeToken(token, isCurrent),
      afterLogin: ctx.afterLogin
    });
    const freshToken = () => ctx.freshToken((token, signal) => refreshAccessToken(token.refresh, signal));
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
        const attempt = session.begin();
        const existing = await ctx.readToken();
        if (!attempt.isCurrent()) throw new Error("aborted");
        if (existing && existing.expires > Date.now() + 6e4) {
          session.settle(attempt);
          return { status: "logged-in", account: existing.accountId };
        }
        const { verifier, challenge } = generatePkce();
        const state = verifier;
        const candidates = callbackPortCandidates(ctx.options().redirectPort);
        let listener = void 0;
        for (const port of candidates) {
          try {
            listener = await startCallbackListener(port, state, attempt.signal, LOGIN_TIMEOUT_MS);
            break;
          } catch (error) {
            if (isPortUnavailable(error)) continue;
            session.fail(attempt, error);
            throw error;
          }
        }
        if (listener !== void 0 && !attempt.isCurrent()) {
          listener.close();
          throw new Error("aborted");
        }
        if (listener !== void 0) {
          const port = listener.port;
          const url = buildAuthorizeUrl(port, challenge, state);
          attempt.publish({ url });
          void listener.code.then((code) => {
            if (!attempt.isCurrent()) return void 0;
            ctx.log("\u6536\u5230\u6388\u6743\u56DE\u8C03\uFF0C\u5F00\u59CB\u6362\u53D6\u4EE4\u724C\u2026");
            return exchangeAuthorizationCode(code, callbackRedirectUri(port), verifier, attempt.signal).then((token) => session.succeed(attempt, token));
          }).catch((error) => {
            session.fail(attempt, error);
          });
          openBrowser(url);
          return { status: "pending", url };
        }
        if (!attempt.isCurrent()) throw new Error("aborted");
        ctx.log(`localhost:${candidates.join("\u3001")} \u90FD\u4E0D\u53EF\u7528\uFF0C\u6539\u7528 ChatGPT \u8BBE\u5907\u6388\u6743\u767B\u5F55`);
        const start = await requestDeviceAuthorization(attempt.signal).catch((error) => {
          session.fail(attempt, error);
          ctx.log(`\u8BBE\u5907\u6388\u6743\u521D\u59CB\u5316\u5931\u8D25: ${messageOf(error)}`);
          throw error;
        });
        if (!attempt.isCurrent()) throw new Error("aborted");
        attempt.publish({ url: start.verificationUrl, userCode: start.userCode });
        void waitForDeviceAuthorization(start, attempt.signal).then((authorized) => {
          if (!attempt.isCurrent()) return void 0;
          return exchangeDeviceAuthorization(authorized, attempt.signal).then((token) => session.succeed(attempt, token));
        }).catch((error) => {
          session.fail(attempt, error);
        });
        openBrowser(start.verificationUrl);
        return { status: "pending", url: start.verificationUrl, userCode: start.userCode };
      },
      async authStatus() {
        const token = await ctx.readToken();
        if (token) {
          return { provider: ctx.id, status: "logged-in", account: token.accountId, expiresAt: token.expires };
        }
        const pending = session.pending();
        if (pending !== void 0) {
          return {
            provider: ctx.id,
            status: "pending",
            url: pending.url,
            ...pending.userCode !== void 0 ? { userCode: pending.userCode } : {}
          };
        }
        const error = session.lastError();
        if (error !== void 0) {
          return { provider: ctx.id, status: "not-logged-in", error };
        }
        return { provider: ctx.id, status: "not-logged-in" };
      },
      async logout() {
        session.cancel();
        await ctx.clearToken();
      },
      cancelLogin() {
        session.cancel();
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
          ctx.log(`\u6A21\u578B\u5217\u8868\u53D1\u73B0\u5931\u8D25: ${messageOf(error)}`);
          return [];
        }
      }
    };
  }
};
export {
  callbackPortCandidates,
  chatgptChannel
};
