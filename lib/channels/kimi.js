import os from "node:os";
import { randomUUID } from "node:crypto";
import { LlmError } from "@deepseek-ai/dsh-llm";
import { AnthropicMessagesAdapter } from "../adapters/anthropic.js";
import { pollDeviceFlow } from "../device-flow.js";
import { openBrowser } from "../oauth.js";
const AUTH_BASE = "https://auth.kimi.com";
const DEVICE_AUTHORIZATION_URL = "https://auth.kimi.com/api/oauth/device_authorization";
const TOKEN_URL = "https://auth.kimi.com/api/oauth/token";
const MODELS_URL = "https://api.kimi.com/coding/v1/models";
const CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const DEFAULT_MODELS = [
  { id: "kimi-for-coding", name: "Kimi For Coding", contextWindow: 128e3 },
  { id: "kimi-for-coding-highspeed", name: "Kimi For Coding Highspeed", contextWindow: 128e3 },
  { id: "k3", name: "Kimi K3", contextWindow: 1048576 },
  { id: "k3-256k", name: "Kimi K3 256K", contextWindow: 262144 },
  { id: "kimi-k2.7-code", name: "Kimi K2.7 Code", contextWindow: 262144 },
  { id: "kimi-k2.6", name: "Kimi K2.6", contextWindow: 262144 },
  { id: "kimi-k2.5", name: "Kimi K2.5", contextWindow: 262144 }
];
const REASONING = {
  efforts: [
    { id: "low", name: "Low", budgetTokens: 4096 },
    { id: "medium", name: "Medium", budgetTokens: 16384 },
    { id: "high", name: "High", budgetTokens: 32768 }
  ]
};
let deviceId;
function kimiCommonHeaders() {
  if (deviceId === void 0) {
    deviceId = randomUUID().replace(/-/g, "");
  }
  return {
    "User-Agent": "KimiCLI/1.5",
    "anthropic-version": "2023-06-01",
    "X-Msh-Platform": "kimi_cli",
    "X-Msh-Version": "1.0",
    "X-Msh-Device-Name": os.hostname(),
    "X-Msh-Device-Model": `${os.platform()} ${os.release()} ${os.arch()}`,
    "X-Msh-Os-Version": os.release(),
    "X-Msh-Device-Id": deviceId
  };
}
async function postForm(url, body, headers = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...headers
    },
    body: new URLSearchParams(body).toString()
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 240)}`);
  }
  return res.json();
}
function toStoredToken(json, fallbackRefresh) {
  const access = typeof json.access_token === "string" ? json.access_token : "";
  if (access === "") throw new Error("token response missing access_token");
  const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 600;
  const refresh = typeof json.refresh_token === "string" ? json.refresh_token : fallbackRefresh ?? "";
  return {
    refresh,
    access,
    expires: Date.now() + expiresIn * 1e3
  };
}
async function requestDeviceAuthorization() {
  const json = await postForm(DEVICE_AUTHORIZATION_URL, { client_id: CLIENT_ID }, kimiCommonHeaders());
  return {
    user_code: String(json.user_code ?? ""),
    device_code: String(json.device_code ?? ""),
    verification_uri: String(json.verification_uri ?? ""),
    verification_uri_complete: String(json.verification_uri_complete ?? json.verification_uri ?? ""),
    expires_in: typeof json.expires_in === "number" ? json.expires_in : 600,
    interval: typeof json.interval === "number" ? json.interval : 5
  };
}
async function pollToken(device, signal) {
  return pollDeviceFlow({
    signal,
    expiresInSeconds: device.expires_in,
    intervalSeconds: device.interval,
    poll: async () => {
      let json;
      try {
        json = await postForm(
          TOKEN_URL,
          {
            client_id: CLIENT_ID,
            device_code: device.device_code,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code"
          },
          kimiCommonHeaders()
        );
      } catch (error) {
        return { status: "pending" };
      }
      if (json.access_token) {
        return { status: "complete", value: toStoredToken(json, void 0) };
      }
      if (json.error === "authorization_pending") return { status: "pending" };
      if (json.error === "slow_down") return { status: "slow_down" };
      if (json.error === "expired_token" || json.error === "access_denied") {
        return { status: "failed", message: `device authorization ${json.error}` };
      }
      return { status: "failed", message: `device authorization error: ${String(json.error)}` };
    }
  });
}
async function refreshAccessTokenInternal(refresh) {
  const json = await postForm(
    TOKEN_URL,
    { grant_type: "refresh_token", refresh_token: refresh, client_id: CLIENT_ID },
    kimiCommonHeaders()
  );
  return toStoredToken(json, refresh);
}
async function fetchModels(access) {
  const res = await fetch(MODELS_URL, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${access}`,
      ...kimiCommonHeaders()
    }
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`models fetch failed (HTTP ${res.status}): ${text.slice(0, 240)}`);
  }
  const json = await res.json();
  const data = Array.isArray(json?.data) ? json.data : [];
  return data.map((m) => {
    const id = typeof m?.id === "string" ? m.id : "";
    if (id === "") return void 0;
    const base = {
      id,
      name: typeof m?.display_name === "string" && m.display_name !== "" ? m.display_name : id
    };
    if (typeof m?.context_length === "number") base.contextWindow = m.context_length;
    return base;
  }).filter((m) => m !== void 0);
}
const kimiChannel = {
  id: "kimi",
  displayName: "Kimi (\u8BA2\u9605)",
  name: "Kimi \u8BA2\u9605",
  description: "\u7528 Kimi Code \u8BA2\u9605\u989D\u5EA6\u8BBF\u95EE Kimi \u6A21\u578B\uFF08\u8BBE\u5907\u6388\u6743\u767B\u5F55\uFF0C\u6A21\u578B\u5217\u8868\u767B\u5F55\u540E\u81EA\u52A8\u4ECE\u5B98\u65B9 API \u83B7\u53D6\uFF09",
  tokenRefName: "KIMI_SUBSCRIPTION_TOKEN",
  defaultApiBaseURL: "https://api.kimi.com/coding/v1/messages",
  defaultRedirectPort: 0,
  defaultContextWindow: 262144,
  defaultMaxTokens: 32768,
  defaultModels: DEFAULT_MODELS,
  reasoning: REASONING,
  create(ctx) {
    let controller;
    let pending;
    const freshToken = async () => {
      const token = await ctx.readToken();
      if (!token) return void 0;
      if (token.expires - Date.now() >= 6e4) return token;
      const refreshed = await refreshAccessTokenInternal(token.refresh);
      await ctx.writeToken(refreshed);
      return refreshed;
    };
    const adapter = new AnthropicMessagesAdapter({
      options: () => ({
        apiBaseURL: ctx.options().apiBaseURL,
        maxTokens: ctx.options().maxTokens,
        models: ctx.options().models,
        defaultContextWindow: ctx.options().defaultContextWindow,
        headers: () => kimiCommonHeaders()
      }),
      attachments: ctx.attachments,
      reasoning: REASONING,
      resolveAccessToken: async () => {
        const token = await freshToken();
        if (!token) {
          throw new LlmError("kimi: \u672A\u767B\u5F55\u3002\u8BF7\u5728 \u8BBE\u7F6E \u2192 \u8BA2\u9605\u670D\u52A1 \u91CC\u5B8C\u6210\u8BA2\u9605\u8D26\u53F7\u6388\u6743\u3002", "MISSING_CREDENTIAL");
        }
        return { access: token.access };
      },
      label: "kimi",
      displayName: "Kimi (\u8BA2\u9605)"
    });
    return {
      adapter,
      async login() {
        const existing = await ctx.readToken();
        if (existing && existing.expires > Date.now() + 6e4) {
          return { status: "logged-in", account: existing.accountId };
        }
        this.cancelLogin();
        const device = await requestDeviceAuthorization();
        controller = new AbortController();
        pending = { url: device.verification_uri_complete, userCode: device.user_code };
        if (device.verification_uri_complete) openBrowser(device.verification_uri_complete);
        pollToken(device, controller.signal).then(async (token) => {
          await ctx.writeToken(token);
          ctx.log(`Kimi \u767B\u5F55\u6210\u529F\uFF0C\u5F00\u59CB\u53D1\u73B0\u6A21\u578B\u5217\u8868\u2026`);
          ctx.afterLogin();
        }).catch((error) => {
          if (controller && !controller.signal.aborted) {
            ctx.log(`Kimi \u767B\u5F55\u5931\u8D25: ${error?.message ?? error}`);
          }
        }).finally(() => {
          pending = void 0;
        });
        return {
          status: "pending",
          url: device.verification_uri_complete,
          userCode: device.user_code
        };
      },
      async authStatus() {
        const token = await ctx.readToken();
        if (token) {
          return { provider: ctx.id, status: "logged-in", account: token.accountId, expiresAt: token.expires };
        }
        if (pending && controller && !controller.signal.aborted) {
          return { provider: ctx.id, status: "pending", url: pending.url, userCode: pending.userCode };
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
          return await fetchModels(token.access);
        } catch (error) {
          ctx.log(`Kimi \u6A21\u578B\u5217\u8868\u53D1\u73B0\u5931\u8D25: ${error?.message ?? error}`);
          return [];
        }
      }
    };
  }
};
export {
  kimiChannel
};
