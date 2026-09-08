const CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const CLIENT_VERSION = "0.153.4";
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
  fetchCodexModels
};
