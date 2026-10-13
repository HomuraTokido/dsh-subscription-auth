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
    let controller;
    let pending;
    let lastError;
    const freshToken = async () => {
      const token = await ctx.readToken();
      if (!token) return void 0;
      if (token.expires - Date.now() >= 6e4) return token;
      const refreshed = await refreshAccessToken(token.refresh);
      await ctx.writeToken(refreshed);
      return refreshed;
    };
    const isCurrent = (attempt) => controller === attempt && !attempt.signal.aborted;
    const settle = (attempt) => {
      if (controller === attempt) {
        controller = void 0;
        pending = void 0;
      }
    };
    const failAttempt = (attempt, error) => {
      if (controller !== attempt) return;
      if (!attempt.signal.aborted) {
        lastError = messageOf(error);
        ctx.log(`\u767B\u5F55\u5931\u8D25: ${lastError}`);
      }
      settle(attempt);
    };
    let credentialQueue = Promise.resolve();
    const runCredentialTask = (task) => {
      const next = credentialQueue.then(task, task);
      credentialQueue = next.catch(() => {
      });
      return next;
    };
    const clearTokenQuietly = async (context) => {
      try {
        await ctx.clearToken();
      } catch (error) {
        ctx.log(`${context}: ${messageOf(error)}`);
      }
    };
    const finishLogin = (attempt, token) => runCredentialTask(async () => {
      if (!isCurrent(attempt)) return;
      try {
        await ctx.writeToken(token);
      } catch (error) {
        await clearTokenQuietly("\u5199\u51ED\u636E\u5931\u8D25\u540E\u7684\u6E05\u7406\u4E5F\u5931\u8D25");
        throw error;
      }
      if (!isCurrent(attempt)) {
        await clearTokenQuietly("\u56DE\u6EDA\u88AB\u53D6\u6D88\u7684\u51ED\u636E\u5199\u5165\u5931\u8D25");
        return;
      }
      ctx.log(`\u767B\u5F55\u6210\u529F${token.accountId ? `\uFF08account: ${token.accountId}\uFF09` : ""}\uFF0C\u5F00\u59CB\u53D1\u73B0\u6A21\u578B\u5217\u8868\u2026`);
      settle(attempt);
      ctx.afterLogin();
    });
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
        lastError = void 0;
        const existing = await ctx.readToken();
        if (existing && existing.expires > Date.now() + 6e4) {
          return { status: "logged-in", account: existing.accountId };
        }
        this.cancelLogin();
        const attempt = new AbortController();
        controller = attempt;
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
            if (controller === attempt) {
              if (!attempt.signal.aborted) lastError = messageOf(error);
              settle(attempt);
            }
            throw error;
          }
        }
        if (listener !== void 0 && !isCurrent(attempt)) {
          listener.close();
          throw new Error("aborted");
        }
        if (listener !== void 0) {
          const port = listener.port;
          const url = buildAuthorizeUrl(port, challenge, state);
          pending = { url };
          void listener.code.then((code) => {
            if (!isCurrent(attempt)) return void 0;
            ctx.log("\u6536\u5230\u6388\u6743\u56DE\u8C03\uFF0C\u5F00\u59CB\u6362\u53D6\u4EE4\u724C\u2026");
            return exchangeAuthorizationCode(code, callbackRedirectUri(port), verifier, attempt.signal).then((token) => finishLogin(attempt, token));
          }).catch((error) => {
            failAttempt(attempt, error);
          });
          openBrowser(url);
          return { status: "pending", url };
        }
        if (!isCurrent(attempt)) throw new Error("aborted");
        ctx.log(`localhost:${candidates.join("\u3001")} \u90FD\u4E0D\u53EF\u7528\uFF0C\u6539\u7528 ChatGPT \u8BBE\u5907\u6388\u6743\u767B\u5F55`);
        const start = await requestDeviceAuthorization(attempt.signal).catch((error) => {
          if (controller === attempt) {
            if (!attempt.signal.aborted) lastError = messageOf(error);
            settle(attempt);
          }
          ctx.log(`\u8BBE\u5907\u6388\u6743\u521D\u59CB\u5316\u5931\u8D25: ${messageOf(error)}`);
          throw error;
        });
        if (!isCurrent(attempt)) throw new Error("aborted");
        pending = { url: start.verificationUrl, userCode: start.userCode };
        void waitForDeviceAuthorization(start, attempt.signal).then((authorized) => {
          if (!isCurrent(attempt)) return void 0;
          return exchangeDeviceAuthorization(authorized, attempt.signal).then((token) => finishLogin(attempt, token));
        }).catch((error) => {
          failAttempt(attempt, error);
        });
        openBrowser(start.verificationUrl);
        return { status: "pending", url: start.verificationUrl, userCode: start.userCode };
      },
      async authStatus() {
        const token = await ctx.readToken();
        if (token) {
          return { provider: ctx.id, status: "logged-in", account: token.accountId, expiresAt: token.expires };
        }
        if (pending && controller && !controller.signal.aborted) {
          return {
            provider: ctx.id,
            status: "pending",
            url: pending.url,
            ...pending.userCode !== void 0 ? { userCode: pending.userCode } : {}
          };
        }
        if (lastError !== void 0) {
          return { provider: ctx.id, status: "not-logged-in", error: lastError };
        }
        return { provider: ctx.id, status: "not-logged-in" };
      },
      async logout() {
        this.cancelLogin();
        lastError = void 0;
        await runCredentialTask(async () => {
          await ctx.clearToken();
        });
      },
      cancelLogin() {
        const attempt = controller;
        controller = void 0;
        pending = void 0;
        if (attempt && !attempt.signal.aborted) attempt.abort();
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
  callbackPortCandidates,
  chatgptChannel
};
