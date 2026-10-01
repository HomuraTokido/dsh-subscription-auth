const CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const CLIENT_VERSION = "0.159.3";
const CODEX_LATEST_URL = "https://registry.npmjs.org/@openai/codex/latest";
const VERSION_TTL_MS = 6 * 60 * 60 * 1e3;
let cachedVersion;
async function resolveCodexClientVersion(log) {
  if (cachedVersion !== void 0 && Date.now() - cachedVersion.at < VERSION_TTL_MS) return cachedVersion.version;
  try {
    const response = await fetch(CODEX_LATEST_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(8e3)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const version = (await response.json()).version;
    if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
      throw new Error(`\u8FD4\u56DE\u7684\u7248\u672C\u53F7\u4E0D\u50CF x.y.z\uFF1A${String(version)}`);
    }
    cachedVersion = { version, at: Date.now() };
    return version;
  } catch (error) {
    const fallback = cachedVersion?.version ?? CLIENT_VERSION;
    log?.(`\u67E5 @openai/codex \u6700\u65B0\u7248\u672C\u5931\u8D25\uFF08${error?.message ?? error}\uFF09\uFF0C\u8FD9\u6B21\u7528 ${fallback} \u53D1\u73B0\u6A21\u578B\uFF1B\u65B0\u6A21\u578B\u53EF\u80FD\u7F3A\u51E0\u4E2A\uFF0C\u4E0B\u6B21\u53D1\u73B0\u4F1A\u518D\u67E5`);
    return fallback;
  }
}
const MODEL_PATHS = ["/codex/models", "/models"];
async function fetchCodexModels(accessToken, accountId, baseUrl, signal, clientVersion) {
  const base = (baseUrl ?? CODEX_BASE_URL).trim().replace(/\/+$/, "");
  const version = clientVersion !== void 0 && clientVersion.trim() !== "" ? clientVersion.trim() : CLIENT_VERSION;
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "OpenAI-Beta": "responses=experimental",
    originator: "pi",
    version,
    accept: "application/json"
  };
  if (accountId !== void 0 && accountId.trim() !== "") {
    headers["chatgpt-account-id"] = accountId.trim();
  }
  for (const path of MODEL_PATHS) {
    const url = `${base}${path}?client_version=${encodeURIComponent(version)}`;
    let response;
    try {
      response = await fetch(url, { method: "GET", headers, signal });
    } catch {
      continue;
    }
    if (!response.ok) continue;
    let payload;
    try {
      payload = await response.json();
    } catch {
      continue;
    }
    const entries = Array.isArray(payload?.models) ? payload.models : Array.isArray(payload?.data) ? payload.data : null;
    if (!entries) continue;
    const models = [];
    for (const entry of entries) {
      const id = typeof entry?.slug === "string" && entry.slug.trim() !== "" ? entry.slug.trim() : typeof entry?.id === "string" && entry.id.trim() !== "" ? entry.id.trim() : "";
      if (id === "") continue;
      const visibility = typeof entry?.visibility === "string" ? entry.visibility.toLowerCase() : "";
      if (visibility === "hide" || visibility === "hidden") continue;
      models.push({
        id,
        name: typeof entry?.display_name === "string" && entry.display_name.trim() !== "" ? entry.display_name.trim() : id,
        ...typeof entry?.context_window === "number" && entry.context_window > 0 ? { contextWindow: Math.trunc(entry.context_window) } : {}
      });
    }
    if (models.length > 0) return models;
  }
  return [];
}
export {
  CLIENT_VERSION,
  CODEX_BASE_URL,
  fetchCodexModels,
  resolveCodexClientVersion
};
