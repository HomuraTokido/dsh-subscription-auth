import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { createProvider } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/api/openai-codex-responses.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
const PROTOCOL_BY_ROUTE = {
  chatgpt: "openai-codex-responses",
  grok: "openai-responses",
  claude: "anthropic-messages",
  kimi: "anthropic-messages"
};
const CATALOG_BY_ROUTE = {
  chatgpt: "openai-codex",
  claude: "anthropic",
  grok: "xai",
  kimi: "kimi-coding"
};
const ALL_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const BUDGET_LEVELS = ["minimal", "low", "medium", "high"];
function isBudgetLevel(value) {
  return BUDGET_LEVELS.includes(value);
}
const LEGACY_THINKING_BUDGET = 16384;
const DEFAULT_INPUT = ["text", "image"];
const STREAM_IDLE_TIMEOUT_MS = 3e5;
const MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024;
const REQUEST_IMAGE_PIXEL_BUDGET = 2048 * 2048;
const REQUEST_IMAGE_MAX_BYTES = 1024 * 1024;
function protocolForRoute(provider) {
  return PROTOCOL_BY_ROUTE[provider] ?? "openai-codex-responses";
}
function protocolApi(protocol) {
  switch (protocol) {
    case "openai-codex-responses":
      return openAICodexResponsesApi();
    case "openai-responses":
      return openAIResponsesApi();
    case "anthropic-messages":
      return anthropicMessagesApi();
  }
}
function normalizeBaseUrl(apiBaseURL, protocol) {
  const trimmed = apiBaseURL.trim().replace(/\/+$/, "");
  if (protocol === "anthropic-messages") {
    for (const suffix2 of ["/v1/messages", "/messages", "/v1"]) {
      if (trimmed.endsWith(suffix2)) return trimmed.slice(0, -suffix2.length);
    }
    return trimmed;
  }
  const suffix = "/responses";
  return trimmed.endsWith(suffix) ? trimmed.slice(0, -suffix.length) : trimmed;
}
function catalogModelsFor(provider) {
  const catalogId = CATALOG_BY_ROUTE[provider];
  if (catalogId === void 0) return /* @__PURE__ */ new Map();
  try {
    const models = getBuiltinModels(catalogId);
    return new Map(models.map((model) => [model.id, model]));
  } catch {
    return /* @__PURE__ */ new Map();
  }
}
function thinkingLevelMap(reasoning, catalog) {
  const catalogMap = catalog?.thinkingLevelMap;
  if (reasoning === void 0 && catalogMap === void 0) return void 0;
  const map = {};
  for (const level of ALL_THINKING_LEVELS) {
    if (catalogMap !== void 0 && level in catalogMap) {
      const declared = catalogMap[level];
      map[level] = declared === void 0 ? null : declared;
      continue;
    }
    if (reasoning?.efforts.some((effort) => effort.id === level)) {
      map[level] = level;
      continue;
    }
    map[level] = null;
  }
  return map;
}
function thinkingBudgets(reasoning) {
  if (reasoning === void 0) return void 0;
  const budgets = {};
  let any = false;
  for (const effort of reasoning.efforts) {
    if (!isBudgetLevel(effort.id)) continue;
    budgets[effort.id] = effort.budgetTokens ?? LEGACY_THINKING_BUDGET;
    any = true;
  }
  return any ? budgets : void 0;
}
function defaultThinkingLevel(reasoning) {
  const effort = reasoning?.defaultEffort;
  return effort !== void 0 && ALL_THINKING_LEVELS.includes(effort) ? effort : void 0;
}
function buildPiModel(route, protocol, baseUrl, entry, options, catalog) {
  const known = catalog.get(entry.id);
  const levels = thinkingLevelMap(route.reasoning, known);
  return {
    // 目录 metadata 先铺底，下面只覆盖本插件自己拥有的字段
    ...known ?? {},
    id: entry.id,
    name: entry.name,
    provider: route.provider,
    api: protocol,
    baseUrl,
    input: known !== void 0 ? [...known.input] : [...DEFAULT_INPUT],
    cost: known?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: entry.contextWindow ?? options.defaultContextWindow,
    maxTokens: known?.maxTokens ?? options.maxTokens,
    // 渠道声明了思考档位的模型按“可推理”对待；目录怎么说就怎么算
    reasoning: known?.reasoning ?? route.reasoning !== void 0,
    ...levels !== void 0 ? { thinkingLevelMap: levels } : {}
  };
}
function emptyCredentialStore() {
  return {
    read: async () => void 0,
    list: async () => [],
    modify: async () => {
      throw new Error("subscription-auth owns credential persistence; pi-ai must not write credentials");
    },
    delete: async () => {
      throw new Error("subscription-auth owns credential persistence; pi-ai must not write credentials");
    }
  };
}
function sealedAuthContext() {
  return {
    env: async () => void 0,
    fileExists: async () => false
  };
}
function createProfilesResolver(route) {
  let cached;
  return () => {
    const options = route.options();
    const protocol = route.protocol ?? protocolForRoute(route.provider);
    const key = JSON.stringify({
      apiBaseURL: options.apiBaseURL,
      maxTokens: options.maxTokens,
      defaultContextWindow: options.defaultContextWindow,
      models: options.models.map((model) => [model.id, model.name, model.contextWindow ?? null]),
      headers: options.headers ?? null,
      reasoning: route.reasoning ?? null,
      protocol
    });
    if (cached !== void 0 && cached.key === key) return cached.profiles;
    cached = { key, profiles: buildProfiles(route, protocol, options) };
    return cached.profiles;
  };
}
function buildProfiles(route, protocol, options) {
  const baseUrl = normalizeBaseUrl(options.apiBaseURL, protocol);
  const catalog = catalogModelsFor(route.provider);
  const models = options.models.map((entry) => buildPiModel(route, protocol, baseUrl, entry, options, catalog));
  const budgets = thinkingBudgets(route.reasoning);
  const defaultLevel = defaultThinkingLevel(route.reasoning);
  const configuredMaxTokens = new Map(options.models.map((model) => [model.id, options.maxTokens]));
  let piProvider;
  let catalogError;
  try {
    piProvider = createProvider({
      id: route.provider,
      name: route.displayName,
      baseUrl,
      ...options.headers !== void 0 ? { headers: options.headers } : {},
      auth: {
        // 当次请求派生 auth；secret 只活在这次解析的返回值里，不进 profile / 快照。
        // Anthropic 系必须走 `Authorization: Bearer <access>`：pi-ai 只在 apiKey 带
        // `sk-ant-oat` 时才自己当 OAuth 处理，Kimi 的 access 不是那个形状，所以这里
        // 直接给出 Bearer 头；Claude 的 OAuth 型 access 额外作为 apiKey 交给 pi-ai，
        // 让它保留 OAuth 分支（Bearer + claude-cli 身份头）且不会退回 x-api-key。
        apiKey: {
          name: route.displayName,
          resolve: async ({ credential }) => {
            if (protocol !== "anthropic-messages") {
              return { auth: { apiKey: credential?.key }, source: route.displayName };
            }
            const access = (await route.resolveAccessToken()).access;
            return {
              auth: {
                headers: { authorization: `Bearer ${access}` },
                ...access.includes("sk-ant-oat") ? { apiKey: access } : {}
              },
              source: route.displayName
            };
          }
        }
      },
      api: protocolApi(protocol),
      models
    });
  } catch (error) {
    catalogError = error instanceof Error ? error.message : String(error);
  }
  const profile = {
    provider: route.provider,
    displayName: route.displayName,
    streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
    maxRequestImageBytes: MAX_REQUEST_IMAGE_BYTES,
    requestImagePixelBudget: REQUEST_IMAGE_PIXEL_BUDGET,
    requestImageMaxBytes: REQUEST_IMAGE_MAX_BYTES,
    retryPolicy: resolveRetryPolicy(void 0, `dsh-subscription-auth/${route.provider}`),
    modelErrors: /* @__PURE__ */ new Map(),
    configuredMaxTokens,
    ...budgets !== void 0 ? { thinkingBudgets: budgets } : {},
    ...defaultLevel !== void 0 ? { reasoning: defaultLevel } : {},
    ...options.headers !== void 0 ? { headers: options.headers } : {},
    // codex 端点只走 SSE：现有代理 / 测试流程都按 SSE 设计
    ...protocol === "openai-codex-responses" ? { transport: "sse" } : {},
    ...piProvider !== void 0 ? { piProvider } : {},
    ...catalogError !== void 0 ? { catalogError } : {}
  };
  return /* @__PURE__ */ new Map([[route.provider, profile]]);
}
function piAdapterOptions(route) {
  const protocol = route.protocol ?? protocolForRoute(route.provider);
  return {
    profiles: createProfilesResolver(route),
    // 每次 stream 调用前解析一次；这就是共享事务里 refresh 的入口。
    // Anthropic 的 token 不从这里给：它的 Bearer 头由 provider auth 在当次请求派生，
    // 走 resolveApiKey 的话 SDK 会把它当成 x-api-key（Kimi 的 access 不是 sk-ant-oat）。
    resolveApiKey: async () => {
      if (protocol === "anthropic-messages") return void 0;
      return (await route.resolveAccessToken()).access;
    },
    auth: { credentials: emptyCredentialStore(), authContext: sealedAuthContext() },
    ...route.attachments !== void 0 ? { resolveAttachments: () => route.attachments?.() } : {},
    ...route.log !== void 0 ? {
      onReplayDegrade: (detail) => {
        route.log?.(`[${detail.provider}] ${detail.model} \u7684\u5386\u53F2 replay \u72B6\u6001\u4E0D\u53EF\u7528\uFF0C\u5DF2\u964D\u7EA7\u4E3A\u7EAF\u6587\u672C\uFF1A${detail.reason}`);
      }
    } : {}
  };
}
function createPiAdapter(route) {
  return new PiAiAdapter(piAdapterOptions(route));
}
export {
  buildPiModel,
  catalogModelsFor,
  createPiAdapter,
  createProfilesResolver,
  normalizeBaseUrl,
  piAdapterOptions,
  protocolApi,
  protocolForRoute,
  thinkingBudgets,
  thinkingLevelMap
};
