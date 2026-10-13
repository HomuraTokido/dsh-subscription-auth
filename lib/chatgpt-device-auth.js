import { AUTH_BASE, CLIENT_ID, boundedSignal, exchangeAuthorizationCode } from "./oauth.js";
import { pollDeviceFlow } from "./device-flow.js";
const DEVICE_CODE_ENDPOINT = `${AUTH_BASE}/api/accounts/deviceauth/usercode`;
const DEVICE_TOKEN_ENDPOINT = `${AUTH_BASE}/api/accounts/deviceauth/token`;
const DEVICE_VERIFICATION_URL = `${AUTH_BASE}/codex/device`;
const DEVICE_REDIRECT_URI = `${AUTH_BASE}/deviceauth/callback`;
const DEVICE_EXPIRES_IN_SECONDS = 15 * 60;
const DEFAULT_INTERVAL_SECONDS = 5;
function parseInterval(raw) {
  const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number.parseFloat(raw) : Number.NaN;
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_INTERVAL_SECONDS;
}
async function requestDeviceAuthorization(signal) {
  const request = boundedSignal(signal);
  try {
    const res = await fetch(DEVICE_CODE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", accept: "application/json" },
      body: JSON.stringify({ client_id: CLIENT_ID }),
      signal: request.signal
    });
    if (!res.ok) throw new Error(`\u8BBE\u5907\u6388\u6743\u8BF7\u6C42\u5931\u8D25 (HTTP ${res.status})`);
    const body = await res.json();
    const deviceAuthId = typeof body?.device_auth_id === "string" ? body.device_auth_id : "";
    const userCode = typeof body?.user_code === "string" && body.user_code !== "" ? body.user_code : typeof body?.usercode === "string" ? body.usercode : "";
    if (deviceAuthId === "" || userCode === "") {
      throw new Error("\u8BBE\u5907\u6388\u6743\u54CD\u5E94\u7F3A\u5C11 device_auth_id / user_code");
    }
    return {
      deviceAuthId,
      userCode,
      verificationUrl: DEVICE_VERIFICATION_URL,
      intervalSeconds: parseInterval(body?.interval),
      expiresInSeconds: DEVICE_EXPIRES_IN_SECONDS
    };
  } finally {
    request.cleanup();
  }
}
async function pollDeviceAuthorization(deviceAuthId, userCode, signal) {
  const request = boundedSignal(signal);
  try {
    const res = await fetch(DEVICE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", accept: "application/json" },
      body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
      signal: request.signal
    });
    if (res.status === 403 || res.status === 404) return { status: "pending" };
    if (!res.ok) return { status: "failed", message: `\u8BBE\u5907\u6388\u6743\u5931\u8D25 (HTTP ${res.status})` };
    const body = await res.json();
    const authorizationCode = typeof body?.authorization_code === "string" ? body.authorization_code : "";
    const codeVerifier = typeof body?.code_verifier === "string" ? body.code_verifier : "";
    if (authorizationCode === "" || codeVerifier === "") {
      return { status: "failed", message: "\u8BBE\u5907\u6388\u6743\u54CD\u5E94\u7F3A\u5C11 authorization_code / code_verifier" };
    }
    return {
      status: "complete",
      value: {
        authorizationCode,
        codeVerifier,
        codeChallenge: typeof body?.code_challenge === "string" ? body.code_challenge : ""
      }
    };
  } finally {
    request.cleanup();
  }
}
function waitForDeviceAuthorization(start, signal) {
  return pollDeviceFlow({
    signal,
    intervalSeconds: start.intervalSeconds,
    expiresInSeconds: start.expiresInSeconds,
    poll: () => pollDeviceAuthorization(start.deviceAuthId, start.userCode, signal)
  });
}
function exchangeDeviceAuthorization(authorized, signal) {
  return exchangeAuthorizationCode(
    authorized.authorizationCode,
    DEVICE_REDIRECT_URI,
    authorized.codeVerifier,
    signal
  );
}
export {
  DEVICE_EXPIRES_IN_SECONDS,
  DEVICE_REDIRECT_URI,
  DEVICE_VERIFICATION_URL,
  exchangeDeviceAuthorization,
  pollDeviceAuthorization,
  requestDeviceAuthorization,
  waitForDeviceAuthorization
};
