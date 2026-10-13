import type { StoredToken } from './oauth.js';
import type { DevicePollResult } from './device-flow.js';
/** 官方设备授权验证页（固定地址，用户在这里输入 user_code）。 */
export declare const DEVICE_VERIFICATION_URL = "https://auth.openai.com/codex/device";
/** 设备流换令牌时固定使用的 redirect_uri（与浏览器回调流不同）。 */
export declare const DEVICE_REDIRECT_URI = "https://auth.openai.com/deviceauth/callback";
/** 官方设备码 15 分钟过期。 */
export declare const DEVICE_EXPIRES_IN_SECONDS: number;
/** 已开始的设备授权会话（authStatus 上报 url + userCode）。 */
export interface DeviceAuthorization {
    deviceAuthId: string;
    userCode: string;
    /** 验证页地址（官方固定值）。 */
    verificationUrl: string;
    /** 轮询间隔（秒）；pollDeviceFlow 会把 <1s 抬到 1s。 */
    intervalSeconds: number;
    /** 过期秒数（官方 15 分钟）。 */
    expiresInSeconds: number;
}
/** 用户确认后拿到的换码材料。 */
export interface DeviceAuthorizationResult {
    authorizationCode: string;
    codeVerifier: string;
    codeChallenge: string;
}
/**
 * 第一步：请求设备码。失败（网络错误 / 非 2xx / 响应缺字段）直接抛错，
 * 由 login() 交给设置页显示。
 */
export declare function requestDeviceAuthorization(signal?: AbortSignal): Promise<DeviceAuthorization>;
/**
 * 第二步：单次轮询。403 / 404 表示用户还没确认；其他非 2xx 是失败；
 * 2xx 但缺字段也算失败（响应内容不进错误信息）。
 */
export declare function pollDeviceAuthorization(deviceAuthId: string, userCode: string, signal?: AbortSignal): Promise<DevicePollResult<DeviceAuthorizationResult>>;
/**
 * 轮询直到用户确认 / 设备码过期（15 分钟）/ 取消。
 * 间隔下限 1s，且每轮请求返回后才 sleep——不会重叠轮询。
 */
export declare function waitForDeviceAuthorization(start: DeviceAuthorization, signal?: AbortSignal): Promise<DeviceAuthorizationResult>;
/** 第三步：用设备流拿到的 code 换令牌（复用浏览器流的换码与令牌转换）。 */
export declare function exchangeDeviceAuthorization(authorized: DeviceAuthorizationResult, signal?: AbortSignal): Promise<StoredToken>;
