/**
 * ChatGPT codex 官方模型列表发现。
 *
 * 与 omp（pi-catalog/src/discovery/codex.ts）的实现一致：
 *   GET https://chatgpt.com/backend-api/codex/models?client_version=<v>
 *   （备选 /models）
 *   Headers: Authorization: Bearer <access_token> / chatgpt-account-id /
 *            OpenAI-Beta: responses=experimental / originator: pi /
 *            version: <v> / accept: application/json
 * 响应 { models: [...] } 或 { data: [...] }；visibility=hide/hidden 的跳过。
 * @module dsh-subscription-auth/discovery
 */
import type { AdapterModel } from './adapter.js';
export declare const CODEX_BASE_URL = "https://chatgpt.com/backend-api";
/**
 * codex 客户端版本的最后兜底（对应 @openai/codex 版本）。
 *
 * 后端按这个版本号决定发哪些模型：0.144.1 拿不到 gpt-6-astra，0.153.4 才有
 * （2026-09-08 同一账号实测）；0.153.4 拿不到 gpt-6.1-sol / gpt-6-sol /
 * gpt-6-luna，0.159.3 才有（2026-10-01 实测）。所以平时不用它：
 * resolveCodexClientVersion() 每次发现前去 npm 查 @openai/codex 的最新版，
 * 查不到才退回上次查到的版本，再退回这里。渠道配置 `clientVersion` 优先于这一切。
 */
export declare const CLIENT_VERSION = "0.159.3";
/**
 * 当前 codex CLI 的最新版本号，供模型发现请求携带。
 * 6 小时内复用上次结果；npm 查询失败时退回上次查到的版本，再退回 CLIENT_VERSION。
 * 不抛错：版本号拿不到不该挡住模型发现。
 */
export declare function resolveCodexClientVersion(log?: (message: string) => void): Promise<string>;
/**
 * 拉取订阅账号可用的 codex 模型列表。
 * 所有候选路径都失败时返回空数组（调用方回退默认列表）。
 */
export declare function fetchCodexModels(accessToken: string, accountId: string | undefined, baseUrl?: string, signal?: AbortSignal, clientVersion?: string): Promise<AdapterModel[]>;
