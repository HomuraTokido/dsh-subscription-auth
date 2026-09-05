import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_BASE = "https://auth.openai.com";
const REDIRECT_PORT = 1455;
const SCOPES = "openid profile email offline_access api.connectors.read api.connectors.invoke";
const ORIGINATOR = "pi";
function base64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function generatePkce() {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
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
function accountIdFromClaims(payload) {
  return payload?.chatgpt_account_id ?? payload?.["https://api.openai.com/auth"]?.chatgpt_account_id ?? payload?.organizations?.[0]?.id;
}
function accountIdFromTokens(idToken, access) {
  if (idToken) {
    const fromId = accountIdFromClaims(decodeJwt(idToken));
    if (fromId) return fromId;
  }
  if (access) return accountIdFromClaims(decodeJwt(access));
  return void 0;
}
function buildAuthorizeUrl(port, challenge, state) {
  const redirectUri = `http://localhost:${port}/auth/callback`;
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: ORIGINATOR
  });
  return `${AUTH_BASE}/oauth/authorize?${params.toString()}`;
}
function openBrowser(url) {
  try {
    const platform = process.platform;
    if (platform === "win32") {
      const child2 = spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], { stdio: "ignore", detached: true });
      child2.on("error", () => {
      });
      child2.unref();
      return;
    }
    const cmd = platform === "darwin" ? "open" : "xdg-open";
    const child = spawn(cmd, [url], { stdio: "ignore", detached: true });
    child.on("error", () => {
    });
    child.unref();
  } catch {
  }
}
function toStoredToken(json, fallbackRefresh) {
  const access = typeof json.access_token === "string" ? json.access_token : "";
  if (access === "") throw new Error("token response missing access_token");
  const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 600;
  const idToken = typeof json.id_token === "string" ? json.id_token : void 0;
  const refresh = typeof json.refresh_token === "string" ? json.refresh_token : fallbackRefresh ?? "";
  return {
    refresh,
    access,
    expires: Date.now() + expiresIn * 1e3,
    accountId: accountIdFromTokens(idToken, access)
  };
}
async function exchangeCode(code, port, verifier) {
  const redirectUri = `http://localhost:${port}/auth/callback`;
  const res = await fetch(`${AUTH_BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: CLIENT_ID,
      code_verifier: verifier
    }).toString()
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`token exchange failed (HTTP ${res.status}): ${text.slice(0, 240)}`);
  }
  return toStoredToken(await res.json(), void 0);
}
async function refreshAccessToken(refresh) {
  const res = await fetch(`${AUTH_BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: CLIENT_ID
    }).toString()
  });
  if (!res.ok) throw new Error(`token refresh failed (HTTP ${res.status})`);
  return toStoredToken(await res.json(), refresh);
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function waitForCallback(port, state, signal, timeoutMs = 10 * 60 * 1e3, path = "/auth/callback") {
  return new Promise((resolve, reject) => {
    const server = createServer();
    let settled = false;
    const timer = setTimeout(() => {
      fail(new Error("oauth timed out: \u7B49\u5F85\u6388\u6743\u56DE\u8C03\u8D85\u65F6"));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      server.close();
      reject(err);
    };
    const done = (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      server.close();
      resolve(code);
    };
    const onAbort = () => fail(new Error("aborted"));
    if (signal) {
      if (signal.aborted) {
        fail(new Error("aborted"));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    server.on("request", (req, res) => {
      const u = new URL(req.url ?? "/", `http://localhost:${port}`);
      if (u.pathname !== path) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      const error = u.searchParams.get("error");
      if (error) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<h1>\u767B\u5F55\u5931\u8D25</h1><p>${escapeHtml(error)}</p>`);
        fail(new Error(`oauth error: ${error}`));
        return;
      }
      const code = u.searchParams.get("code");
      const st = u.searchParams.get("state");
      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<h1>\u7F3A\u5C11\u6388\u6743\u7801</h1>");
        return;
      }
      if (st !== state) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<h1>state \u4E0D\u5339\u914D</h1>");
        fail(new Error("oauth state mismatch"));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<h1>\u767B\u5F55\u6210\u529F</h1><p>\u53EF\u4EE5\u5173\u95ED\u6B64\u9875\u9762\uFF0C\u56DE\u5230 dsh \u7EE7\u7EED\u3002</p>");
      done(code);
    });
    server.on("error", (err) => {
      fail(new Error(`localhost:${port} \u542F\u52A8\u5931\u8D25\uFF1A${err.message}\uFF08\u7AEF\u53E3\u88AB\u5360\u7528\uFF1F\uFF09`));
    });
    server.listen(port, "127.0.0.1");
  });
}
export {
  AUTH_BASE,
  CLIENT_ID,
  REDIRECT_PORT,
  buildAuthorizeUrl,
  exchangeCode,
  generatePkce,
  openBrowser,
  refreshAccessToken,
  waitForCallback
};
