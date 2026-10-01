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
import type { AdapterModel } from './adapter.js'

export const CODEX_BASE_URL = 'https://chatgpt.com/backend-api'
/**
 * codex 客户端版本的最后兜底（对应 @openai/codex 版本）。
 *
 * 后端按这个版本号决定发哪些模型：0.144.1 拿不到 gpt-6-astra，0.153.4 才有
 * （2026-09-08 同一账号实测）；0.153.4 拿不到 gpt-6.1-sol / gpt-6-sol /
 * gpt-6-luna，0.159.3 才有（2026-10-01 实测）。所以平时不用它：
 * resolveCodexClientVersion() 每次发现前去 npm 查 @openai/codex 的最新版，
 * 查不到才退回上次查到的版本，再退回这里。渠道配置 `clientVersion` 优先于这一切。
 */
export const CLIENT_VERSION = '0.159.3'

const CODEX_LATEST_URL = 'https://registry.npmjs.org/@openai/codex/latest'
const VERSION_TTL_MS = 6 * 60 * 60 * 1000
let cachedVersion: { version: string; at: number } | undefined

/**
 * 当前 codex CLI 的最新版本号，供模型发现请求携带。
 * 6 小时内复用上次结果；npm 查询失败时退回上次查到的版本，再退回 CLIENT_VERSION。
 * 不抛错：版本号拿不到不该挡住模型发现。
 */
export async function resolveCodexClientVersion(log?: (message: string) => void): Promise<string> {
  if (cachedVersion !== undefined && Date.now() - cachedVersion.at < VERSION_TTL_MS) return cachedVersion.version
  try {
    const response = await fetch(CODEX_LATEST_URL, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const version = (await response.json() as { version?: unknown }).version
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
      throw new Error(`返回的版本号不像 x.y.z：${String(version)}`)
    }
    cachedVersion = { version, at: Date.now() }
    return version
  } catch (error) {
    const fallback = cachedVersion?.version ?? CLIENT_VERSION
    log?.(`查 @openai/codex 最新版本失败（${(error as Error)?.message ?? error}），这次用 ${fallback} 发现模型；新模型可能缺几个，下次发现会再查`)
    return fallback
  }
}

const MODEL_PATHS = ['/codex/models', '/models'] as const

/**
 * 拉取订阅账号可用的 codex 模型列表。
 * 所有候选路径都失败时返回空数组（调用方回退默认列表）。
 */
export async function fetchCodexModels(
  accessToken: string,
  accountId: string | undefined,
  baseUrl?: string,
  signal?: AbortSignal,
  clientVersion?: string,
): Promise<AdapterModel[]> {
  const base = (baseUrl ?? CODEX_BASE_URL).trim().replace(/\/+$/, '')
  const version = clientVersion !== undefined && clientVersion.trim() !== '' ? clientVersion.trim() : CLIENT_VERSION
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'OpenAI-Beta': 'responses=experimental',
    originator: 'pi',
    version,
    accept: 'application/json',
  }
  if (accountId !== undefined && accountId.trim() !== '') {
    headers['chatgpt-account-id'] = accountId.trim()
  }

  for (const path of MODEL_PATHS) {
    const url = `${base}${path}?client_version=${encodeURIComponent(version)}`
    let response: Response
    try {
      response = await fetch(url, { method: 'GET', headers, signal })
    } catch {
      continue
    }
    if (!response.ok) continue
    let payload: any
    try {
      payload = await response.json()
    } catch {
      continue
    }
    const entries = Array.isArray(payload?.models)
      ? payload.models
      : Array.isArray(payload?.data)
        ? payload.data
        : null
    if (!entries) continue

    const models: AdapterModel[] = []
    for (const entry of entries) {
      const id = typeof entry?.slug === 'string' && entry.slug.trim() !== ''
        ? entry.slug.trim()
        : typeof entry?.id === 'string' && entry.id.trim() !== ''
          ? entry.id.trim()
          : ''
      if (id === '') continue
      const visibility = typeof entry?.visibility === 'string' ? entry.visibility.toLowerCase() : ''
      if (visibility === 'hide' || visibility === 'hidden') continue
      models.push({
        id,
        name: typeof entry?.display_name === 'string' && entry.display_name.trim() !== ''
          ? entry.display_name.trim()
          : id,
        ...(typeof entry?.context_window === 'number' && entry.context_window > 0
          ? { contextWindow: Math.trunc(entry.context_window) }
          : {}),
      })
    }
    if (models.length > 0) return models
  }
  return []
}
