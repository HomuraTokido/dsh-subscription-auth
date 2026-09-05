import z from "@deepseek-ai/schemastery";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { chatgptChannel } from "./channels/chatgpt.js";
import { claudeChannel } from "./channels/claude.js";
import { grokChannel } from "./channels/grok.js";
import { kimiChannel } from "./channels/kimi.js";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
const name = "dsh-subscription-auth";
const inject = ["llm"];
const channelNamespace = (id) => `subscription-auth-${id}`;
const CHANNELS = [
  chatgptChannel,
  claudeChannel,
  grokChannel,
  kimiChannel
];
function logLine(message) {
  const line = `[${(/* @__PURE__ */ new Date()).toISOString()}] ${message}`;
  try {
    console.log(line);
    const dir = join(os.homedir(), ".dsh", "tmp");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "subscription-auth.log"), line + "\n");
  } catch {
  }
}
const catalogModel = z.object({
  id: z.string().required(),
  name: z.string().required(),
  contextWindow: z.number()
});
function makeConfigSchema(def) {
  return z.object({
    apiBaseURL: z.string().default(def.defaultApiBaseURL),
    redirectPort: z.number().default(def.defaultRedirectPort),
    // 注意：models 不能带 .default()——否则 schemastery 总是用默认值填充，
    // 登录发现的模型列表就永远被默认列表压住。默认值由 resolveOptions 统一处理。
    models: z.array(catalogModel),
    defaultContextWindow: z.number().default(def.defaultContextWindow),
    maxTokens: z.number().default(def.defaultMaxTokens),
    discoveredModels: z.array(catalogModel)
  });
}
function resolveOptions(raw, discovered, def) {
  const source = raw.models !== void 0 && raw.models.length > 0 ? raw.models : raw.discoveredModels !== void 0 && raw.discoveredModels.length > 0 ? raw.discoveredModels : discovered !== void 0 && discovered.length > 0 ? discovered : def.defaultModels;
  const models = source.map((m) => ({
    id: m.id,
    name: m.name ?? m.id,
    ...m.contextWindow !== void 0 ? { contextWindow: m.contextWindow } : {}
  }));
  return {
    apiBaseURL: raw.apiBaseURL ?? def.defaultApiBaseURL,
    redirectPort: raw.redirectPort ?? def.defaultRedirectPort,
    models,
    defaultContextWindow: raw.defaultContextWindow ?? def.defaultContextWindow,
    maxTokens: raw.maxTokens ?? def.defaultMaxTokens
  };
}
function apply(ctx, config = {}) {
  const states = /* @__PURE__ */ new Map();
  const credentials = () => ctx.get("credentials");
  const attachments = () => ctx.get("attachments");
  const gateStopped = /* @__PURE__ */ new Map();
  for (const def of CHANNELS) {
    const st = {
      def,
      runtime: void 0,
      channelCtx: void 0
    };
    states.set(def.id, st);
    const ref = credentialRef(def.tokenRefName);
    const readToken = async () => {
      const c = credentials();
      if (!c) return void 0;
      const hit = await c.resolve(ref);
      if (!hit) return void 0;
      try {
        const t = JSON.parse(hit.value);
        if (t && typeof t.refresh === "string" && typeof t.access === "string") return t;
      } catch {
      }
      return void 0;
    };
    const writeToken = async (token) => {
      const c = credentials();
      if (c) await c.set(ref, JSON.stringify(token));
    };
    const clearToken = async () => {
      const c = credentials();
      if (c) await c.unset(ref);
    };
    const getRaw = () => {
      const s = st.settingsScope;
      return s !== void 0 ? s.get() : {};
    };
    const channelCtx = {
      id: def.id,
      tokenRefName: def.tokenRefName,
      options: () => resolveOptions(getRaw(), st.discovered?.models, def),
      getConfig: getRaw,
      updateConfig: async (patch) => {
        const s = st.settingsScope;
        if (s !== void 0) await s.update(patch);
      },
      credentials,
      attachments,
      log: logLine,
      notifyModelsChanged: () => {
        try {
          st.replaceRegistration?.();
        } catch (error) {
          logLine(`\u6A21\u578B\u5217\u8868\u5237\u65B0\u901A\u77E5\u5931\u8D25: ${error?.message ?? error}`);
        }
      },
      readToken,
      writeToken,
      clearToken,
      afterLogin: () => {
        void discoverAndStore(st);
      }
    };
    st.channelCtx = channelCtx;
    st.runtime = def.create(channelCtx);
  }
  async function discoverAndStore(st) {
    const token = await st.channelCtx.readToken();
    if (!token || token.expires - Date.now() < 6e4) return;
    const found = await st.runtime.discoverModels();
    if (found.length > 0) {
      st.discovered = { models: found, at: Date.now() };
      if (st.settingsScope !== void 0) {
        try {
          await st.settingsScope.update({ discoveredModels: found });
        } catch (error) {
          logLine(`\u6A21\u578B\u5217\u8868\u6301\u4E45\u5316\u5931\u8D25: ${error?.message ?? error}`);
        }
      }
      st.channelCtx.notifyModelsChanged();
      logLine(`[${st.def.id}] \u5DF2\u53D1\u73B0 ${found.length} \u4E2A\u8BA2\u9605\u6A21\u578B\uFF1A${found.map((m) => m.id).join(", ")}`);
    }
  }
  async function logoutChannel(st) {
    await st.runtime.logout();
    st.discovered = void 0;
    st.syncRegistration?.(false);
    if (st.settingsScope !== void 0) {
      try {
        await st.settingsScope.update({ discoveredModels: [] });
      } catch (error) {
        logLine(`\u6E05\u9664\u6A21\u578B\u5217\u8868\u5931\u8D25: ${error?.message ?? error}`);
      }
    }
    logLine(`[${st.def.id}] \u5DF2\u6CE8\u9500\uFF0C\u6E05\u9664\u4EE4\u724C\u4E0E\u6A21\u578B\u5217\u8868`);
  }
  ctx.inject(["settings"], (settingsCtx) => {
    settingsCtx.effect(() => {
      const created = [];
      for (const def of CHANNELS) {
        const base = config[def.id];
        const scope = settingsCtx.settings.register(
          channelNamespace(def.id),
          makeConfigSchema(def),
          { base: base !== void 0 && typeof base === "object" ? base : {} }
        );
        created.push({ id: def.id, scope });
      }
      for (const { id, scope } of created) {
        const st = states.get(id);
        if (st !== void 0) st.settingsScope = scope;
      }
      for (const { id } of created) {
        const st = states.get(id);
        if (st === void 0) continue;
        void (async () => {
          if (gateStopped.get(id) === true) return;
          const token = await st.channelCtx.readToken();
          if (gateStopped.get(id) === true || token === void 0) return;
          st.syncRegistration?.(true);
          if (st.discovered === void 0) void discoverAndStore(st);
        })();
      }
      return () => {
        for (const { id } of created) {
          const st = states.get(id);
          if (st !== void 0) st.settingsScope = void 0;
        }
      };
    }, "subscription-auth.settings");
  });
  for (const def of CHANNELS) {
    const st = states.get(def.id);
    const entry = {
      provider: def.id,
      displayName: def.displayName,
      settingsNs: channelNamespace(def.id),
      settingsPath: []
    };
    const providersHandle = ctx.llm.registerConfigurableProviders([entry]);
    const adapterHandle = ctx.llm.registerAdapter([def.id], st.runtime.adapter);
    let registered = true;
    const sync = (next, announce) => {
      if (next === registered && !announce) return;
      providersHandle.replace(next ? [entry] : []);
      adapterHandle.replace(next ? [def.id] : []);
      registered = next;
    };
    st.syncRegistration = (next) => sync(next, false);
    st.replaceRegistration = () => sync(true, true);
    let attempts = 0;
    const gate = async () => {
      if (gateStopped.get(def.id) === true || attempts >= 200) return;
      attempts += 1;
      if (credentials() === void 0) {
        setTimeout(() => {
          void gate();
        }, 300);
        return;
      }
      const token = await st.channelCtx.readToken();
      if (gateStopped.get(def.id) === true) return;
      const loggedIn = token !== void 0;
      sync(loggedIn, false);
      logLine(`[${def.id}] \u767B\u5F55\u72B6\u6001: ${loggedIn ? "\u5DF2\u767B\u5F55\uFF0C\u6CE8\u518C provider" : "\u672A\u767B\u5F55\uFF0C\u4E0D\u6CE8\u518C provider"}`);
      if (loggedIn) void discoverAndStore(st);
    };
    void gate();
  }
  ctx.effect(() => () => {
    for (const def of CHANNELS) gateStopped.set(def.id, true);
    for (const st of states.values()) st.runtime.cancelLogin();
  }, "subscription-auth.auth-cleanup");
  ctx.inject(["webServer"], (webCtx) => {
    const webServer = webCtx.webServer;
    const collectBody = async (req) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      return Buffer.concat(chunks).toString("utf8");
    };
    const send = (res, code, payload) => {
      const body = JSON.stringify(payload);
      res.writeHead(code, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      });
      res.end(body);
    };
    const channelCard = async (st) => {
      const state = await st.runtime.authStatus();
      if (state.status === "logged-in" && st.discovered === void 0) {
        void discoverAndStore(st);
      }
      const models = resolveOptions(st.channelCtx.getConfig(), st.discovered?.models, st.def).models.map((m) => m.id);
      return {
        id: st.def.id,
        name: st.def.name,
        description: st.def.description,
        models,
        ...st.discovered !== void 0 ? { discoveredAt: st.discovered.at } : {},
        ...state
      };
    };
    webCtx.effect(() => webServer.register({
      kind: "exact",
      path: "/subscription-auth/providers",
      handler: async (req, res) => {
        try {
          if (req.method !== "GET") {
            send(res, 405, { error: "method not allowed" });
            return;
          }
          const providers = [];
          for (const def of CHANNELS) {
            providers.push(await channelCard(states.get(def.id)));
          }
          send(res, 200, { providers });
        } catch (error) {
          send(res, 500, { error: error instanceof Error ? error.message : String(error) });
        }
      }
    }), "subscription-auth.providers-route");
    webCtx.effect(() => webServer.register({
      kind: "exact",
      path: "/subscription-auth/auth/login",
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") {
            send(res, 405, { error: "method not allowed" });
            return;
          }
          let body = {};
          try {
            body = JSON.parse(await collectBody(req) || "{}");
          } catch {
          }
          const id = typeof body.provider === "string" ? body.provider : "";
          const st = states.get(id);
          if (st === void 0) {
            send(res, 404, { error: `unknown provider: ${id}` });
            return;
          }
          const result = await st.runtime.login();
          send(res, 200, result);
        } catch (error) {
          send(res, 500, { error: error instanceof Error ? error.message : String(error) });
        }
      }
    }), "subscription-auth.login-route");
    webCtx.effect(() => webServer.register({
      kind: "exact",
      path: "/subscription-auth/auth/logout",
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") {
            send(res, 405, { error: "method not allowed" });
            return;
          }
          let body = {};
          try {
            body = JSON.parse(await collectBody(req) || "{}");
          } catch {
          }
          const id = typeof body.provider === "string" ? body.provider : "";
          const st = states.get(id);
          if (st === void 0) {
            send(res, 404, { error: `unknown provider: ${id}` });
            return;
          }
          await logoutChannel(st);
          send(res, 200, { ok: true });
        } catch (error) {
          send(res, 500, { error: error instanceof Error ? error.message : String(error) });
        }
      }
    }), "subscription-auth.logout-route");
  });
}
export {
  CHANNELS,
  apply,
  inject,
  name
};
