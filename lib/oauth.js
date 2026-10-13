import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_BASE = "https://auth.openai.com";
const REDIRECT_PORT = 1455;
const FALLBACK_REDIRECT_PORT = 1457;
const REQUEST_TIMEOUT_MS = 30 * 1e3;
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
function callbackRedirectUri(port) {
  return `http://localhost:${port}/auth/callback`;
}
function buildAuthorizeUrl(port, challenge, state) {
  const redirectUri = callbackRedirectUri(port);
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
function boundedSignal(signal, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  };
}
async function exchangeAuthorizationCode(code, redirectUri, verifier, signal) {
  const request = boundedSignal(signal);
  try {
    const res = await fetch(`${AUTH_BASE}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: CLIENT_ID,
        code_verifier: verifier
      }).toString(),
      signal: request.signal
    });
    if (!res.ok) throw new Error(`token exchange failed (HTTP ${res.status})`);
    return toStoredToken(await res.json(), void 0);
  } finally {
    request.cleanup();
  }
}
function exchangeCode(code, port, verifier) {
  return exchangeAuthorizationCode(code, callbackRedirectUri(port), verifier);
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
function startCallbackListener(port, state, signal, timeoutMs = 10 * 60 * 1e3, path = "/auth/callback") {
  return new Promise((resolveReady, rejectReady) => {
    const server = createServer();
    let readySettled = false;
    let closing = false;
    let codeSettled = false;
    let timer;
    let resolveCode = () => {
    };
    let rejectCode = () => {
    };
    const code = new Promise((resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
    });
    code.catch(() => {
    });
    const listener = { port, code, close };
    function settleReady(error) {
      if (readySettled) return;
      readySettled = true;
      if (error === void 0) resolveReady(listener);
      else rejectReady(error);
    }
    function close() {
      if (closing) return;
      closing = true;
      if (timer !== void 0) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      server.close();
    }
    function fail(error) {
      settleReady(error);
      if (codeSettled) return;
      codeSettled = true;
      close();
      rejectCode(error);
    }
    function done(received) {
      if (codeSettled) return;
      codeSettled = true;
      close();
      resolveCode(received);
    }
    function onAbort() {
      fail(new Error("aborted"));
    }
    server.on("request", (req, res) => {
      const u = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
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
      const received = u.searchParams.get("code");
      if (!received) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<h1>\u7F3A\u5C11\u6388\u6743\u7801</h1>");
        return;
      }
      if (u.searchParams.get("state") !== state) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<h1>state \u4E0D\u5339\u914D</h1>");
        fail(new Error("oauth state mismatch"));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<h1>\u767B\u5F55\u6210\u529F</h1><p>\u53EF\u4EE5\u5173\u95ED\u6B64\u9875\u9762\uFF0C\u56DE\u5230 dsh \u7EE7\u7EED\u3002</p>");
      done(received);
    });
    server.on("error", (err) => {
      const failure = new Error(
        `localhost:${port} \u542F\u52A8\u5931\u8D25\uFF1A${err.message}\uFF08\u7AEF\u53E3\u88AB\u5360\u7528\uFF1F\uFF09`
      );
      failure.code = err.code;
      fail(failure);
    });
    if (signal?.aborted) {
      fail(new Error("aborted"));
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      fail(new Error("oauth timed out: \u7B49\u5F85\u6388\u6743\u56DE\u8C03\u8D85\u65F6"));
    }, timeoutMs);
    server.listen(port, "127.0.0.1", () => {
      if (closing) {
        server.close();
        return;
      }
      settleReady();
    });
  });
}
async function waitForCallback(port, state, signal, timeoutMs = 10 * 60 * 1e3, path = "/auth/callback") {
  const listener = await startCallbackListener(port, state, signal, timeoutMs, path);
  return listener.code;
}
export {
  AUTH_BASE,
  CLIENT_ID,
  FALLBACK_REDIRECT_PORT,
  REDIRECT_PORT,
  REQUEST_TIMEOUT_MS,
  boundedSignal,
  buildAuthorizeUrl,
  callbackRedirectUri,
  exchangeAuthorizationCode,
  exchangeCode,
  generatePkce,
  openBrowser,
  refreshAccessToken,
  startCallbackListener,
  waitForCallback
};
