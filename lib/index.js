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
    clientVersion: z.string(),
    discoveredModels: z.array(catalogModel)
  });
}
const Config = z.object(Object.fromEntries(
  CHANNELS.map((def) => [def.id, makeConfigSchema(def).volatile()])
));
function resolveOptions(raw, discovered, def) {
  const [source, modelsSource] = raw.models !== void 0 && raw.models.length > 0 ? [raw.models, "config"] : discovered !== void 0 && discovered.length > 0 ? [discovered, "discovered"] : raw.discoveredModels !== void 0 && raw.discoveredModels.length > 0 ? [raw.discoveredModels, "saved"] : [def.defaultModels, "builtin"];
  const models = source.map((m) => ({
    id: m.id,
    name: m.name ?? m.id,
    ...m.contextWindow !== void 0 ? { contextWindow: m.contextWindow } : {}
  }));
  return {
    apiBaseURL: raw.apiBaseURL ?? def.defaultApiBaseURL,
    redirectPort: raw.redirectPort ?? def.defaultRedirectPort,
    models,
    modelsSource,
    defaultContextWindow: raw.defaultContextWindow ?? def.defaultContextWindow,
    maxTokens: raw.maxTokens ?? def.defaultMaxTokens,
    ...raw.clientVersion !== void 0 && raw.clientVersion.trim() !== "" ? { clientVersion: raw.clientVersion.trim() } : {}
  };
}
function apply(ctx, config = {}) {
  const states = /* @__PURE__ */ new Map();
  const credentials = () => ctx.get("credentials");
  const attachments = () => ctx.get("attachments");
  const gateStopped = /* @__PURE__ */ new Map();
  const entry = ctx.fiber?.entry;
  const settingsNs = entry?.options.id ?? name;
  let saves = Promise.resolve();
  const writeChannelConfig = async (id, patch) => {
    const editor = ctx.get("configEditor");
    if (entry === void 0 || editor === void 0) {
      logLine(`[${id}] \u6CA1\u6709 configEditor \u6216 profile \u6761\u76EE\uFF0C\u914D\u7F6E\u53EA\u5728\u672C\u6B21\u8FD0\u884C\u91CC\u751F\u6548\uFF0C\u91CD\u542F\u540E\u4E0D\u4FDD\u7559`);
      return;
    }
    const saved = saves.then(() => editor.edit(entry, (raw) => {
      const current = raw !== null && typeof raw === "object" ? raw : {};
      const section = current[id] !== null && typeof current[id] === "object" ? current[id] : {};
      return { ...current, [id]: { ...section, ...patch } };
    }));
    saves = saved.catch(() => {
    });
    await saved;
  };
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
    const getRaw = () => config[def.id]?.get() ?? {};
    const channelCtx = {
      id: def.id,
      tokenRefName: def.tokenRefName,
      options: () => resolveOptions(getRaw(), st.discovered?.models, def),
      getConfig: getRaw,
      updateConfig: (patch) => writeChannelConfig(def.id, patch),
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
  function discoverAndStore(st) {
    st.discovering ??= (async () => {
      const token = await st.channelCtx.readToken();
      if (!token) return;
      const found = await st.runtime.discoverModels();
      if (found.length === 0) {
        logLine(`[${st.def.id}] \u6CA1\u53D1\u73B0\u5230\u6A21\u578B\uFF08\u539F\u56E0\u89C1\u4E0A\u4E00\u884C\uFF0C\u6CA1\u6709\u4E0A\u4E00\u884C\u5C31\u662F\u63A5\u53E3\u8FD4\u56DE\u4E86\u7A7A\u5217\u8868\uFF09\uFF0C\u6A21\u578B\u5217\u8868\u5148\u7528${(st.channelCtx.getConfig().discoveredModels?.length ?? 0) > 0 ? "\u4E0A\u6B21\u4FDD\u5B58\u7684" : "\u5185\u7F6E\u515C\u5E95"}\u7684`);
        return;
      }
      st.discovered = { models: found, at: Date.now() };
      try {
        await st.channelCtx.updateConfig({ discoveredModels: found });
      } catch (error) {
        logLine(`[${st.def.id}] \u6A21\u578B\u5217\u8868\u5199\u56DE\u914D\u7F6E\u5931\u8D25\uFF0C\u672C\u6B21\u8FD0\u884C\u7167\u5E38\u7528\u65B0\u5217\u8868\uFF0C\u91CD\u542F\u540E\u4F1A\u9000\u56DE\u65E7\u7684\uFF1A${error?.message ?? error}`);
      }
      st.channelCtx.notifyModelsChanged();
      logLine(`[${st.def.id}] \u5DF2\u53D1\u73B0 ${found.length} \u4E2A\u8BA2\u9605\u6A21\u578B\uFF1A${found.map((m) => m.id).join(", ")}`);
    })().finally(() => {
      st.discovering = void 0;
    });
    return st.discovering;
  }
  async function logoutChannel(st) {
    await st.runtime.logout();
    st.discovered = void 0;
    st.syncRegistration?.(false);
    try {
      await st.channelCtx.updateConfig({ discoveredModels: [] });
    } catch (error) {
      logLine(`\u6E05\u9664\u6A21\u578B\u5217\u8868\u5931\u8D25: ${error?.message ?? error}`);
    }
    logLine(`[${st.def.id}] \u5DF2\u6CE8\u9500\uFF0C\u6E05\u9664\u4EE4\u724C\u4E0E\u6A21\u578B\u5217\u8868`);
  }
  for (const def of CHANNELS) {
    const st = states.get(def.id);
    const entry2 = {
      provider: def.id,
      displayName: def.displayName,
      settingsNs,
      settingsPath: [def.id]
    };
    const providersHandle = ctx.llm.registerConfigurableProviders([entry2]);
    const adapterHandle = ctx.llm.registerAdapter([def.id], st.runtime.adapter);
    let registered = true;
    const sync = (next, announce) => {
      if (next === registered && !announce) return;
      providersHandle.replace(next ? [entry2] : []);
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
  const channelCard = async (st) => {
    let state = await st.runtime.authStatus();
    if (state.status === "logged-in" && st.discovered === void 0) {
      await Promise.race([
        discoverAndStore(st),
        new Promise((resolve) => setTimeout(resolve, 1e4))
      ]);
      state = await st.runtime.authStatus();
    }
    const resolved = resolveOptions(st.channelCtx.getConfig(), st.discovered?.models, st.def);
    return {
      id: st.def.id,
      name: st.def.name,
      description: st.def.description,
      models: resolved.models.map((m) => m.id),
      modelsSource: resolved.modelsSource,
      ...st.discovered !== void 0 ? { discoveredAt: st.discovered.at } : {},
      ...state
    };
  };
  const remoteDeps = {
    providers: async () => {
      const providers = [];
      for (const def of CHANNELS) providers.push(await channelCard(states.get(def.id)));
      return providers;
    },
    login: async (provider) => {
      const st = states.get(provider);
      if (st === void 0) throw new Error(`unknown provider: ${provider}`);
      return await st.runtime.login();
    },
    logout: async (provider) => {
      const st = states.get(provider);
      if (st === void 0) throw new Error(`unknown provider: ${provider}`);
      await logoutChannel(st);
      return { ok: true };
    }
  };
  ctx.effect(() => {
    let disposed = false;
    void import("./remote.js").then(({ createSubscriptionAuthRemote }) => {
      if (!disposed) ctx.plugin(createSubscriptionAuthRemote(remoteDeps));
    }).catch((error) => {
      logLine(`\u8BA2\u9605\u670D\u52A1 RPC \u7AEF\u70B9\u672A\u6302\u8F7D: ${error instanceof Error ? error.message : String(error)}`);
    });
    return () => {
      disposed = true;
    };
  }, "subscription-auth: settings remote");
}
export {
  CHANNELS,
  Config,
  apply,
  inject,
  name
};
