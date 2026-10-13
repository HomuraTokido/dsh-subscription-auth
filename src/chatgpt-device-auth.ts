/**
 * ChatGPT（Codex）官方设备授权登录：1455 / 1457 两个已注册的 localhost 回调
 * 端口都不可用时的兜底路径。
 *
 * wire 格式以 openai/codex 的 `codex-rs/login/src/device_code_auth.rs`（main）为准：
 *   POST /api/accounts/deviceauth/usercode   {"client_id"}
 *     → {"device_auth_id", "user_code" | "usercode", "interval"}
 *     用户在 https://auth.openai.com/codex/device 输入 user_code
 *   POST /api/accounts/deviceauth/token      {"device_auth_id", "user_code"}
 *     → 403 / 404：用户还没确认（继续轮询）；其他非 2xx：失败
 *     → 2xx: {"authorization_code", "code_verifier", "code_challenge"}
 *   换令牌仍是普通授权码换码，只是 redirect_uri 固定为
 *   https://auth.openai.com/deviceauth/callback。
 *
 * 每个请求都带「调用方取消 + 单请求 30s 超时」的组合信号；错误信息只带 HTTP
 * 状态码——设备授权响应里带 authorization_code / code_verifier，不落日志。
 * 轮询间隔与 15 分钟过期复用 device-flow.ts 的 pollDeviceFlow（间隔下限 1s，
 * 且上一轮请求返回后才 sleep，不会重叠轮询）。
 * @module dsh-subscription-auth/chatgpt-device-auth
 */
import { AUTH_BASE, CLIENT_ID, boundedSignal, exchangeAuthorizationCode } from './oauth.js'
import type { StoredToken } from './oauth.js'
import { pollDeviceFlow } from './device-flow.js'
import type { DevicePollResult } from './device-flow.js'

const DEVICE_CODE_ENDPOINT = `${AUTH_BASE}/api/accounts/deviceauth/usercode`
const DEVICE_TOKEN_ENDPOINT = `${AUTH_BASE}/api/accounts/deviceauth/token`

/** 官方设备授权验证页（固定地址，用户在这里输入 user_code）。 */
export const DEVICE_VERIFICATION_URL = `${AUTH_BASE}/codex/device`
/** 设备流换令牌时固定使用的 redirect_uri（与浏览器回调流不同）。 */
export const DEVICE_REDIRECT_URI = `${AUTH_BASE}/deviceauth/callback`
/** 官方设备码 15 分钟过期。 */
export const DEVICE_EXPIRES_IN_SECONDS = 15 * 60
/** 响应没给 interval 时的轮询间隔（秒）。 */
const DEFAULT_INTERVAL_SECONDS = 5

/** 已开始的设备授权会话（authStatus 上报 url + userCode）。 */
export interface DeviceAuthorization {
  deviceAuthId: string
  userCode: string
  /** 验证页地址（官方固定值）。 */
  verificationUrl: string
  /** 轮询间隔（秒）；pollDeviceFlow 会把 <1s 抬到 1s。 */
  intervalSeconds: number
  /** 过期秒数（官方 15 分钟）。 */
  expiresInSeconds: number
}

/** 用户确认后拿到的换码材料。 */
export interface DeviceAuthorizationResult {
  authorizationCode: string
  codeVerifier: string
  codeChallenge: string
}

/** interval 官方可能是 number 或 string；非法值退回默认间隔。 */
function parseInterval(raw: unknown): number {
  const value = typeof raw === 'number'
    ? raw
    : (typeof raw === 'string' ? Number.parseFloat(raw) : Number.NaN)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_INTERVAL_SECONDS
}

/**
 * 第一步：请求设备码。失败（网络错误 / 非 2xx / 响应缺字段）直接抛错，
 * 由 login() 交给设置页显示。
 */
export async function requestDeviceAuthorization(signal?: AbortSignal): Promise<DeviceAuthorization> {
  const request = boundedSignal(signal)
  try {
    const res = await fetch(DEVICE_CODE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ client_id: CLIENT_ID }),
      signal: request.signal,
    })
    if (!res.ok) throw new Error(`设备授权请求失败 (HTTP ${res.status})`)
    const body = (await res.json()) as any
    const deviceAuthId = typeof body?.device_auth_id === 'string' ? body.device_auth_id : ''
    const userCode = typeof body?.user_code === 'string' && body.user_code !== ''
      ? body.user_code
      : (typeof body?.usercode === 'string' ? body.usercode : '')
    if (deviceAuthId === '' || userCode === '') {
      throw new Error('设备授权响应缺少 device_auth_id / user_code')
    }
    return {
      deviceAuthId,
      userCode,
      verificationUrl: DEVICE_VERIFICATION_URL,
      intervalSeconds: parseInterval(body?.interval),
      expiresInSeconds: DEVICE_EXPIRES_IN_SECONDS,
    }
  } finally {
    request.cleanup()
  }
}

/**
 * 第二步：单次轮询。403 / 404 表示用户还没确认；其他非 2xx 是失败；
 * 2xx 但缺字段也算失败（响应内容不进错误信息）。
 */
export async function pollDeviceAuthorization(
  deviceAuthId: string,
  userCode: string,
  signal?: AbortSignal,
): Promise<DevicePollResult<DeviceAuthorizationResult>> {
  const request = boundedSignal(signal)
  try {
    const res = await fetch(DEVICE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
      signal: request.signal,
    })
    if (res.status === 403 || res.status === 404) return { status: 'pending' }
    if (!res.ok) return { status: 'failed', message: `设备授权失败 (HTTP ${res.status})` }
    const body = (await res.json()) as any
    const authorizationCode = typeof body?.authorization_code === 'string' ? body.authorization_code : ''
    const codeVerifier = typeof body?.code_verifier === 'string' ? body.code_verifier : ''
    if (authorizationCode === '' || codeVerifier === '') {
      return { status: 'failed', message: '设备授权响应缺少 authorization_code / code_verifier' }
    }
    return {
      status: 'complete',
      value: {
        authorizationCode,
        codeVerifier,
        codeChallenge: typeof body?.code_challenge === 'string' ? body.code_challenge : '',
      },
    }
  } finally {
    request.cleanup()
  }
}

/**
 * 轮询直到用户确认 / 设备码过期（15 分钟）/ 取消。
 * 间隔下限 1s，且每轮请求返回后才 sleep——不会重叠轮询。
 */
export function waitForDeviceAuthorization(
  start: DeviceAuthorization,
  signal?: AbortSignal,
): Promise<DeviceAuthorizationResult> {
  return pollDeviceFlow<DeviceAuthorizationResult>({
    signal,
    intervalSeconds: start.intervalSeconds,
    expiresInSeconds: start.expiresInSeconds,
    poll: () => pollDeviceAuthorization(start.deviceAuthId, start.userCode, signal),
  })
}

/** 第三步：用设备流拿到的 code 换令牌（复用浏览器流的换码与令牌转换）。 */
export function exchangeDeviceAuthorization(
  authorized: DeviceAuthorizationResult,
  signal?: AbortSignal,
): Promise<StoredToken> {
  return exchangeAuthorizationCode(
    authorized.authorizationCode,
    DEVICE_REDIRECT_URI,
    authorized.codeVerifier,
    signal,
  )
}
