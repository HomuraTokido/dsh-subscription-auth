import { LlmError } from "@deepseek-ai/dsh-llm";
import { AnthropicMessagesAdapter } from "../adapters/anthropic.js";
import { generatePkce, openBrowser, waitForCallback } from "../oauth.js";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE = "https://claude.ai/oauth/authorize";
const TOKEN_ENDPOINT = "https://api.anthropic.com/v1/oauth/token";
const MODELS_ENDPOINT = "https://api.anthropic.com/v1/models";
const CALLBACK_PATH = "/callback";
const SCOPES = "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
const RESOLVE_THRESHOLD_MS = 6e4;
const defaultModels = [
  { id: "claude-opus-4-8", name: "Claude Opus 4.8", contextWindow: 4e5 },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", contextWindow: 1e6 },
  { id: "claude-fable-5", name: "Claude Fable 5", contextWindow: 1e6 },
  { id: "claude-mythos-5", name: "Claude Mythos 5", contextWindow: 1e6 }
];
const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_BETA = "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,advanced-tool-use-2025-11-20,effort-2025-11-24,extended-cache-ttl-2025-04-11";
const REASONING = {
  efforts: [
    { id: "low", name: "Low", budgetTokens: 8192 },
    { id: "medium", name: "Medium", budgetTokens: 16384 },
    { id: "high", name: "High", budgetTokens: 32e3 }
  ],
  defaultEffort: "medium"
};
function redirectUri(port) {
  return "http://localhost:" + port + CALLBACK_PATH;
}
function toStoredToken(json, fallbackRefresh) {
  const access = typeof json.access_token === "string" ? json.access_token : "";
  if (access === "") throw new Error("token response missing access_token");
  const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 600;
  const refresh = typeof json.refresh_token === "string" ? json.refresh_token : fallbackRefresh ?? "";
  return {
    refresh,
    access,
    expires: Date.now() + expiresIn * 1e3,
    accountId: json?.account?.uuid,
    email: json?.account?.email_address
  };
}
function buildAuthorizeUrl(port, challenge, state) {
  const params = new URLSearchParams({
    code: "true",
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: redirectUri(port),
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state
  });
  return AUTHORIZE + "?" + params.toString();
}
async function exchangeClaudeCode(code, port, verifier) {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      state: verifier,
      redirect_uri: redirectUri(port),
      code_verifier: verifier
    })
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error("token exchange failed (HTTP " + res.status + "): " + text.slice(0, 240));
  }
  return toStoredToken(await res.json(), void 0);
}
async function refreshClaudeToken(refresh) {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "anthropic-beta": "oauth-2025-04-20",
      "User-Agent": "anthropic-sdk-typescript/0.94.0 userOAuthProvider"
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: refresh
    })
  });
  if (!res.ok) throw new Error("token refresh failed (HTTP " + res.status + ")");
  return toStoredToken(await res.json(), refresh);
}
async function fetchClaudeModels(access) {
  const res = await fetch(MODELS_ENDPOINT, {
    method: "GET",
    headers: {
      authorization: "Bearer " + access,
      "anthropic-version": ANTHROPIC_VERSION,
      "anthropic-dangerous-direct-browser-access": "true",
      "anthropic-beta": ANTHROPIC_BETA
    }
  });
  if (!res.ok) throw new Error("model list failed (HTTP " + res.status + ")");
  const json = await res.json();
  const data = Array.isArray(json?.data) ? json.data : [];
  return data.map((m) => {
    const id = String(m?.id ?? "");
    const name = typeof m?.display_name === "string" && m.display_name !== "" ? m.display_name : id;
    return id !== "" ? { id, name } : null;
  }).filter((m) => m !== null);
}
const claudeChannel = {
  id: "claude",
  displayName: "Claude (\u8BA2\u9605)",
  name: "Claude \u8BA2\u9605",
  description: "\u7528 Claude Pro/Max \u8BA2\u9605\u989D\u5EA6\u8BBF\u95EE Claude \u6A21\u578B\uFF08OAuth \u767B\u5F55\uFF0C\u6A21\u578B\u5217\u8868\u767B\u5F55\u540E\u81EA\u52A8\u4ECE\u5B98\u65B9 API \u83B7\u53D6\uFF09",
  tokenRefName: "CLAUDE_SUBSCRIPTION_TOKEN",
  defaultApiBaseURL: "https://api.anthropic.com/v1/messages",
  defaultRedirectPort: 54545,
  defaultContextWindow: 1e6,
  defaultMaxTokens: 64e3,
  defaultModels,
  reasoning: REASONING,
  create(ctx) {
    let controller;
    let pending;
    const adapter = new AnthropicMessagesAdapter({
      options: () => ({
        apiBaseURL: ctx.options().apiBaseURL,
        maxTokens: ctx.options().maxTokens,
        models: ctx.options().models,
        defaultContextWindow: ctx.options().defaultContextWindow,
        headers: () => ({
          "anthropic-version": ANTHROPIC_VERSION,
          "anthropic-beta": ANTHROPIC_BETA
        })
      }),
      attachments: ctx.attachments,
      reasoning: REASONING,
      resolveAccessToken: async () => {
        const token = await ctx.readToken();
        if (!token) {
          throw new LlmError("claude: \u672A\u767B\u5F55\u3002\u8BF7\u5728 \u8BBE\u7F6E \u2192 \u8BA2\u9605\u670D\u52A1 \u91CC\u5B8C\u6210\u8BA2\u9605\u8D26\u53F7\u6388\u6743\u3002", "MISSING_CREDENTIAL");
        }
        if (token.expires - Date.now() < RESOLVE_THRESHOLD_MS) {
          const refreshed = await refreshClaudeToken(token.refresh);
          await ctx.writeToken(refreshed);
          return { access: refreshed.access };
        }
        return { access: token.access };
      },
      label: "claude",
      displayName: "Claude (\u8BA2\u9605)"
    });
    return {
      adapter,
      async login() {
        const existing = await ctx.readToken();
        if (existing && existing.expires > Date.now() + RESOLVE_THRESHOLD_MS) {
          return { status: "logged-in", account: existing.accountId };
        }
        this.cancelLogin();
        const port = ctx.options().redirectPort;
        const { verifier, challenge } = generatePkce();
        const state = verifier;
        const url = buildAuthorizeUrl(port, challenge, state);
        controller = new AbortController();
        pending = { url };
        waitForCallback(port, state, controller.signal, 10 * 60 * 1e3, CALLBACK_PATH).then(async (code) => {
          ctx.log("\u6536\u5230\u6388\u6743\u56DE\u8C03\uFF0C\u5F00\u59CB\u6362\u53D6\u4EE4\u724C\u2026");
          const token = await exchangeClaudeCode(code, port, verifier);
          await ctx.writeToken(token);
          ctx.log("\u767B\u5F55\u6210\u529F" + (token.accountId !== void 0 ? "\uFF08account: " + token.accountId + "\uFF09" : "") + "\uFF0C\u5F00\u59CB\u53D1\u73B0\u6A21\u578B\u5217\u8868\u2026");
          ctx.afterLogin();
        }).catch((error) => {
          if (controller && !controller.signal.aborted) ctx.log("\u767B\u5F55\u5931\u8D25: " + (error?.message ?? error));
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
        const token = await ctx.readToken();
        if (!token || token.expires - Date.now() < RESOLVE_THRESHOLD_MS) return [];
        try {
          return await fetchClaudeModels(token.access);
        } catch (error) {
          ctx.log("\u6A21\u578B\u5217\u8868\u53D1\u73B0\u5931\u8D25: " + (error?.message ?? error));
          return [];
        }
      }
    };
  }
};
export {
  claudeChannel
};
