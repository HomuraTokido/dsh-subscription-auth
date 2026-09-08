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
 * 发现请求默认携带的 codex 客户端版本（对应 @openai/codex 版本）。
 *
 * 后端按这个版本号决定发哪些模型：0.144.1 拿不到 gpt-6-astra，0.153.4 才有
 * （2026-09-08 同一账号实测）。所以它不能是常量：渠道配置 `clientVersion`
 * 可以覆盖，这里只是默认值，跟着本机 Codex 的版本走即可。
 */
export const CLIENT_VERSION = '0.153.4'

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
