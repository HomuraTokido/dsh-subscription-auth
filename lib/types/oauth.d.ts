import type { StoredToken } from './channel.js';
/** 令牌形状统一由 channel.ts 定义（驱动与四个渠道共用一份）。 */
export type { StoredToken };
export declare const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export declare const AUTH_BASE = "https://auth.openai.com";
export declare const REDIRECT_PORT = 1455;
/** OpenAI 注册的第二个 localhost 回调端口：1455 被占用时用它。 */
export declare const FALLBACK_REDIRECT_PORT = 1457;
/** 单次 HTTP 请求的超时上限（换令牌与设备流共用），与调用方取消信号合并。 */
export declare const REQUEST_TIMEOUT_MS: number;
export declare function generatePkce(): {
    verifier: string;
    challenge: string;
};
/** 授权页与换令牌必须用同一个 redirect_uri；端口取实际绑定到的那个。 */
export declare function callbackRedirectUri(port: number): string;
export declare function buildAuthorizeUrl(port: number, challenge: string, state: string): string;
export declare function openBrowser(url: string): void;
/** Parse auth JSON without exposing response fragments in parser errors.
 * Preserve cancellation and body-read/network errors unchanged.
 */
export declare function readAuthJson(response: Pick<Response, 'json'>, failureMessage: string): Promise<any>;
/**
 * 把「调用方取消」与「单请求超时」合成一个 AbortSignal。
 * 请求结束后必须 cleanup()，否则超时计时器会一直挂到点。
 */
export declare function boundedSignal(signal?: AbortSignal, timeoutMs?: number): {
    signal: AbortSignal;
    cleanup: () => void;
};
/**
 * 授权码换令牌（ChatGPT 浏览器回调流与设备流共用，两者只有 redirect_uri 不同）。
 * 请求带 30s 超时，并与 `signal` 上的取消合并；失败只报 HTTP 状态码——
 * 响应体在异常路径上也可能带令牌材料，不写进错误信息。
 */
export declare function exchangeAuthorizationCode(code: string, redirectUri: string, verifier: string, signal?: AbortSignal): Promise<StoredToken>;
/** ChatGPT 浏览器回调流：redirect_uri 落在本机回调端口上。 */
export declare function exchangeCode(code: string, port: number, verifier: string): Promise<StoredToken>;
/**
 * 刷新令牌（ChatGPT）。带 30 秒单请求超时，并与调用方取消信号合并；
 * 失败只报 HTTP 状态码——响应体可能带令牌材料，不写进错误信息。
 */
export declare function refreshAccessToken(refresh: string, signal?: AbortSignal): Promise<StoredToken>;
/** 已绑定并正在监听的本地回调服务器。 */
export interface CallbackListener {
    /** 实际绑定到的端口（只监听 127.0.0.1）。 */
    port: number;
    /** 收到合法授权码时 resolve；错误回调 / state 不匹配 / 超时 / 取消时 reject。 */
    code: Promise<string>;
    /** 关闭服务器并释放端口（幂等）。 */
    close(): void;
}
/**
 * 启动一次性 loopback HTTP 服务器收授权码，只在**真正监听成功之后** resolve。
 * 端口绑定失败（`err.code` 保留原始值）会让返回的 promise reject，方便调用方
 * 判断要不要换下一个端口；服务器一直保留到收到 code、取消或超时。
 * 只绑 127.0.0.1，不监听外部地址。
 */
export declare function startCallbackListener(port: number, state: string, signal?: AbortSignal, timeoutMs?: number, path?: string): Promise<CallbackListener>;
/**
 * 启动一次性 localhost HTTP 服务器，等待浏览器回调返回授权码。
 * 收到 code 且 state 匹配时 resolve；用户取消 / 信号中止 / 端口被占 /
 * 超过 `timeoutMs` 未回调时 reject。claude 渠道与冒烟测试沿用这个包装。
 */
export declare function waitForCallback(port: number, state: string, signal?: AbortSignal, timeoutMs?: number, path?: string): Promise<string>;
