import type { ChannelDefinition } from '../channel.js';
/**
 * ChatGPT 的回调只允许 OpenAI 注册过的 1455 / 1457：配置里指定其中之一则优先，
 * 否则按 1455 → 1457。两个都占不到才会退回设备授权，不静默换任意端口。
 */
export declare function callbackPortCandidates(configured: number): number[];
export declare const chatgptChannel: ChannelDefinition;
