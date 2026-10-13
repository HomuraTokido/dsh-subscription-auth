/**
 * RFC 8628 OAuth 设备授权流程的共享轮询逻辑（Grok / Kimi 共用）。
 * @module dsh-subscription-auth/device-flow
 */
export type DevicePollResult<T> = {
    status: 'complete';
    value: T;
} | {
    status: 'pending';
} | {
    status: 'slow_down';
} | {
    status: 'failed';
    message: string;
};
export interface DeviceFlowOptions<T> {
    poll(): DevicePollResult<T> | Promise<DevicePollResult<T>>;
    intervalSeconds?: number;
    expiresInSeconds?: number;
    signal?: AbortSignal;
}
/** 可中止的 sleep。 */
export declare function sleep(ms: number, signal?: AbortSignal): Promise<void>;
/** 轮询设备授权令牌直到完成 / 失败 / 超时 / 取消。 */
export declare function pollDeviceFlow<T>(options: DeviceFlowOptions<T>): Promise<T>;
