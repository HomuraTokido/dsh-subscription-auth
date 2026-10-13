import { LlmError } from "@deepseek-ai/dsh-llm";
import { ChatGptAdapter } from "../adapter.js";
import { boundedSignal, openBrowser, readAuthJson } from "../oauth.js";
import { pollDeviceFlow } from "../device-flow.js";
import { AuthSession } from "../auth-session.js";
const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
const SCOPE = "openid profile email offline_access grok-cli:access api:access";
const DEFAULT_MODELS = [
  { id: "grok-4.6", name: "Grok 4.6", contextWindow: 5e5 },
  { id: "grok-4.3", name: "Grok 4.3", contextWindow: 1e6 },
  { id: "grok-build", name: "Grok Build", contextWindow: 512e3 },
  { id: "grok-build-0.1", name: "Grok Build 0.1", contextWindow: 256e3 },
  { id: "grok-4.5", name: "Grok 4.5", contextWindow: 5e5 },
  { id: "grok-4.20-multi-agent-0309", name: "Grok 4.20 (Multi-Agent)", contextWindow: 2e6 },
  { id: "grok-4.20-0309-reasoning", name: "Grok 4.20 (Reasoning)", contextWindow: 2e6 },
  { id: "grok-4.20-0309-non-reasoning", name: "Grok 4.20 (Non-Reasoning)", contextWindow: 2e6 },
  { id: "grok-composer-2.5-fast", name: "Grok Composer 2.5 Fast", contextWindow: 2e5 }
];
const REASONING = {
  efforts: [
    { id: "low", name: "Low" },
    { id: "medium", name: "Medium" },
    { id: "high", name: "High" }
  ]
};
async function discoverTokenEndpoint(signal) {
  const request = boundedSignal(signal);
  try {
    const res = await fetch("https://auth.x.ai/.well-known/openid-configuration", {
      headers: { accept: "application/json" },
      signal: request.signal
    });
    if (!res.ok) throw new Error(`OIDC \u53D1\u73B0\u5931\u8D25 (HTTP ${res.status})`);
    const meta = await readAuthJson(res, "OIDC \u53D1\u73B0\u54CD\u5E94\u4E0D\u662F\u5408\u6CD5 JSON");
    const endpoint = typeof meta?.token_endpoint === "string" ? meta.token_endpoint : void 0;
    if (!endpoint) throw new Error("OIDC \u53D1\u73B0\u54CD\u5E94\u7F3A\u5C11 token_endpoint");
    return endpoint;
  } finally {
    request.cleanup();
  }
}
function decodeJwt(token) {
  const parts = token.split(".");
  if (parts.length !== 3) return void 0;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString());
  } catch {
    return void 0;
  }
}
function accountIdFromAccessToken(access) {
  const claims = decodeJwt(access);
  const sub = typeof claims?.sub === "string" && claims.sub !== "" ? claims.sub : void 0;
  return sub ?? (typeof claims?.preferred_username === "string" ? claims.preferred_username : void 0);
}
async function fetchUserinfo(access, signal) {
  const request = boundedSignal(signal);
  try {
    const res = await fetch("https://auth.x.ai/oauth2/userinfo", {
      headers: { authorization: `Bearer ${access}`, accept: "application/json" },
      signal: request.signal
    });
    if (!res.ok) return { accountId: accountIdFromAccessToken(access) };
    const info = await readAuthJson(res, "userinfo \u54CD\u5E94\u4E0D\u662F\u5408\u6CD5 JSON");
    const accountId = typeof info?.sub === "string" && info.sub !== "" ? info.sub : accountIdFromAccessToken(access);
    const email = typeof info?.email === "string" ? info.email : void 0;
    return { accountId, email };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { accountId: accountIdFromAccessToken(access) };
  } finally {
    request.cleanup();
  }
}
function toStoredToken(json, fallbackRefresh = void 0) {
  const access = typeof json.access_token === "string" ? json.access_token : "";
  if (access === "") throw new Error("\u4EE4\u724C\u54CD\u5E94\u7F3A\u5C11 access_token");
  const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 600;
  const refresh = typeof json.refresh_token === "string" ? json.refresh_token : fallbackRefresh ?? "";
  return { refresh, access, expires: Date.now() + expiresIn * 1e3 };
}
async function exchangeDeviceCode(tokenEndpoint, deviceCode, signal) {
  const request = boundedSignal(signal);
  try {
    const res = await fetch(tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: CLIENT_ID,
        device_code: deviceCode
      }).toString(),
      signal: request.signal
    });
    const body = await readAuthJson(res, "\u8BBE\u5907\u6388\u6743\u54CD\u5E94\u4E0D\u662F\u5408\u6CD5 JSON").catch(() => ({}));
    if (res.ok && typeof body?.access_token === "string" && body.access_token !== "") {
      return { status: "complete", value: body };
    }
    const code = typeof body?.error === "string" ? body.error : "";
    switch (code) {
      case "authorization_pending":
        return { status: "pending" };
      case "slow_down":
        return { status: "slow_down" };
      case "access_denied":
        return { status: "failed", message: "\u7528\u6237\u62D2\u7EDD\u4E86\u6388\u6743" };
      case "expired_token":
        return { status: "failed", message: "\u8BBE\u5907\u6388\u6743\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u53D1\u8D77\u767B\u5F55" };
      default:
        return { status: "failed", message: `\u8BBE\u5907\u6388\u6743\u5931\u8D25${code !== "" ? `: ${code}` : ""}` };
    }
  } finally {
    request.cleanup();
  }
}
async function startDeviceFlow(signal) {
  const request = boundedSignal(signal);
  try {
    const res = await fetch("https://auth.x.ai/oauth2/device/code", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: CLIENT_ID, scope: SCOPE }).toString(),
      signal: request.signal
    });
    if (!res.ok) throw new Error(`\u8BBE\u5907\u7801\u8BF7\u6C42\u5931\u8D25 (HTTP ${res.status})`);
    const body = await readAuthJson(res, "\u8BBE\u5907\u7801\u54CD\u5E94\u4E0D\u662F\u5408\u6CD5 JSON");
    const deviceCode = typeof body?.device_code === "string" ? body.device_code : "";
    const userCode = typeof body?.user_code === "string" ? body.user_code : "";
    if (!deviceCode || !userCode) throw new Error("\u8BBE\u5907\u7801\u54CD\u5E94\u7F3A\u5C11 device_code/user_code");
    return {
      deviceCode,
      intervalSeconds: typeof body?.interval === "number" ? body.interval : 5,
      expiresInSeconds: typeof body?.expires_in === "number" ? body.expires_in : 600,
      verificationUriComplete: typeof body?.verification_uri_complete === "string" ? body.verification_uri_complete : typeof body?.verification_uri === "string" ? body.verification_uri : "",
      userCode
    };
  } finally {
    request.cleanup();
  }
}
async function refreshToken(refresh, signal) {
  const tokenEndpoint = await discoverTokenEndpoint(signal);
  const request = boundedSignal(signal);
  try {
    const res = await fetch(tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: CLIENT_ID,
        refresh_token: refresh
      }).toString(),
      signal: request.signal
    });
    if (!res.ok) throw new Error(`\u4EE4\u724C\u7EED\u671F\u5931\u8D25 (HTTP ${res.status})`);
    return toStoredToken(await readAuthJson(res, "\u4EE4\u724C\u7EED\u671F\u54CD\u5E94\u4E0D\u662F\u5408\u6CD5 JSON"), refresh);
  } finally {
    request.cleanup();
  }
}
async function fetchGrokModels(access) {
  const res = await fetch("https://api.x.ai/v1/models", {
    headers: { authorization: `Bearer ${access}`, accept: "application/json" }
  });
  if (!res.ok) throw new Error(`\u6A21\u578B\u5217\u8868\u8BF7\u6C42\u5931\u8D25 (HTTP ${res.status})`);
  const body = await res.json();
  const list = Array.isArray(body?.data) ? body.data : [];
  return list.filter((m) => {
    const id = typeof m?.id === "string" ? m.id : "";
    return id !== "" && !id.startsWith("grok-imagine-") && !id.startsWith("grok-stt-") && !id.startsWith("grok-voice-");
  }).map((m) => ({ id: String(m.id), name: String(m.id) }));
}
const grokChannel = {
  id: "grok",
  displayName: "Grok (\u8BA2\u9605)",
  name: "Grok \u8BA2\u9605",
  description: "\u7528 SuperGrok / X Premium+ \u8BA2\u9605\u989D\u5EA6\u8BBF\u95EE Grok \u6A21\u578B\uFF08\u8BBE\u5907\u6388\u6743\u767B\u5F55\uFF0C\u6A21\u578B\u5217\u8868\u767B\u5F55\u540E\u81EA\u52A8\u4ECE\u5B98\u65B9 API \u83B7\u53D6\uFF09",
  tokenRefName: "GROK_SUBSCRIPTION_TOKEN",
  defaultApiBaseURL: "https://api.x.ai/v1/responses",
  defaultRedirectPort: 0,
  defaultContextWindow: 5e5,
  defaultMaxTokens: 8192,
  defaultModels: DEFAULT_MODELS,
  reasoning: REASONING,
  create(ctx) {
    const session = new AuthSession({
      log: ctx.log,
      write: (token, isCurrent) => ctx.writeToken(token, isCurrent),
      afterLogin: ctx.afterLogin
    });
    const freshToken = () => ctx.freshToken((token, signal) => refreshToken(token.refresh, signal));
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
          throw new LlmError("grok: \u672A\u767B\u5F55\u3002\u8BF7\u5728 \u8BBE\u7F6E \u2192 \u8BA2\u9605\u670D\u52A1 \u91CC\u5B8C\u6210\u8BA2\u9605\u8D26\u53F7\u6388\u6743\u3002", "MISSING_CREDENTIAL");
        }
        return { access: token.access };
      },
      label: "grok",
      displayName: "Grok (\u8BA2\u9605)"
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
        try {
          const flow = await startDeviceFlow(attempt.signal);
          if (!attempt.isCurrent()) throw new Error("aborted");
          const tokenEndpoint = await discoverTokenEndpoint(attempt.signal);
          if (!attempt.isCurrent()) throw new Error("aborted");
          attempt.publish({ url: flow.verificationUriComplete, userCode: flow.userCode });
          void pollDeviceFlow({
            signal: attempt.signal,
            intervalSeconds: flow.intervalSeconds,
            expiresInSeconds: flow.expiresInSeconds,
            poll: () => exchangeDeviceCode(tokenEndpoint, flow.deviceCode, attempt.signal)
          }).then(async (body) => {
            if (!attempt.isCurrent()) return;
            const base = toStoredToken(body);
            const user = await fetchUserinfo(base.access, attempt.signal);
            if (!attempt.isCurrent()) return;
            const stored = {
              ...base,
              ...user.accountId !== void 0 ? { accountId: user.accountId } : {},
              ...user.email !== void 0 ? { email: user.email } : {}
            };
            await session.succeed(attempt, stored);
          }).catch((error) => {
            session.fail(attempt, error);
          });
          if (flow.verificationUriComplete) openBrowser(flow.verificationUriComplete);
          return { status: "pending", url: flow.verificationUriComplete, userCode: flow.userCode };
        } catch (error) {
          session.fail(attempt, error);
          throw error;
        }
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
          return await fetchGrokModels(token.access);
        } catch (error) {
          ctx.log(`\u6A21\u578B\u5217\u8868\u53D1\u73B0\u5931\u8D25: ${messageOf(error)}`);
          return [];
        }
      }
    };
  }
};
export {
  grokChannel
};
