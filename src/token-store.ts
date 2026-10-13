/**
 * 订阅令牌的事务存储：真实凭据放在 dsh-credentials 的 grant record 里
 * （`credentialKey('dsh-subscription-auth', <渠道 id>)`），旧的环境变量引用
 * （`<渠道>_SUBSCRIPTION_TOKEN`）只作为一次性迁移来源。
 *
 * 为什么用 record 而不是环境变量引用：刷新令牌是「读-决定-替换」，必须和
 * 别的进程互斥。`modifyRecord` 提供跨进程串行，回调里能带着锁发网络请求，
 * 所以「判断 60 秒 + 刷新 + 替换」是原子的；本地再用一条队列和一次
 * singleflight 收窄并发。注销（clear）会立即递增 generation 并 abort 在途
 * 刷新，迟到的刷新/写入不可能把已注销的凭据复活。
 *
 * 记录格式：`{ kind: 'grant', payload: { formatVersion: 1, token } }`。
 * 只认自己写下的版本；无效 / 陌生记录一律当作「不是我们的凭据」，绝不从旧
 * 引用覆盖它，也绝不把它的内容写进日志或错误。
 * @module dsh-subscription-auth/token-store
 */
import { randomUUID } from 'node:crypto'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import type {
  CredentialKey,
  CredentialProvider,
  CredentialRecord,
  CredentialRef,
} from '@deepseek-ai/dsh-credentials'
import type { RefreshToken, StoredToken } from './channel.js'

/** credential key 的 scope 段：必须等于实际注册的插件名（否则记录会变成孤儿）。 */
const SCOPE = 'dsh-subscription-auth'
/** payload 版本；不认识的版本当作「不是我们的凭据」。 */
const FORMAT_VERSION = 1
/** 剩余寿命低于这个值就在请求前刷新。 */
export const REFRESH_THRESHOLD_MS = 60_000

/** record payload 形状。 */
interface GrantPayload {
  formatVersion: number
  token: StoredToken
}

export interface TokenStoreOptions {
  /** 当前 credential 服务（可能尚未就绪）。 */
  provider(): CredentialProvider | undefined
  /** 渠道 id（credential key 的 id 段，小写连字符标识符）。 */
  channelId: string
  /** 旧的环境变量引用名（迁移来源）。 */
  legacyRefName: string
  /** 只用于无值的安全提示。 */
  log?(message: string): void
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

/** 严格校验一个令牌：access / refresh 非空，expires 是有限数字。 */
export function parseStoredToken(value: unknown): StoredToken | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const token = value as Record<string, unknown>
  if (!isNonEmptyString(token.access) || !isNonEmptyString(token.refresh)) return undefined
  if (typeof token.expires !== 'number' || !Number.isFinite(token.expires)) return undefined
  return value as StoredToken
}

/** 解析我们自己写下的记录；不是我们的（kind / 版本 / 字段不对）返回 undefined。 */
export function parseGrantRecord(record: CredentialRecord | undefined): StoredToken | undefined {
  if (record === undefined || record.kind !== 'grant') return undefined
  const payload = record.payload
  if (payload === null || typeof payload !== 'object') return undefined
  const shaped = payload as { formatVersion?: unknown; token?: unknown }
  if (shaped.formatVersion !== FORMAT_VERSION) return undefined
  return parseStoredToken(shaped.token)
}

/** 包装成 grant record。 */
export function grantRecord(token: StoredToken): CredentialRecord {
  const payload: GrantPayload = { formatVersion: FORMAT_VERSION, token }
  return { kind: 'grant', payload }
}

/** 刷新响应缺字段时沿用旧令牌的非旋转字段（refresh / accountId / email）。 */
export function mergeRefreshedToken(previous: StoredToken, refreshed: StoredToken): StoredToken {
  return {
    ...refreshed,
    ...(refreshed.refresh === '' ? { refresh: previous.refresh } : {}),
    ...(refreshed.accountId === undefined && previous.accountId !== undefined
      ? { accountId: previous.accountId }
      : {}),
    ...(refreshed.email === undefined && previous.email !== undefined ? { email: previous.email } : {}),
  }
}

export class TokenStore {
  /** 注销会把它推进：过期代号不再落库、也不再返回新令牌。 */
  private generation = 0
  /** 本地串行：read / write / clear / fresh 依次执行（跨进程串行靠 modifyRecord）。 */
  private queue: Promise<unknown> = Promise.resolve()
  /** 本地 singleflight：并发的 freshToken 共用一次刷新。 */
  private refreshing: Promise<StoredToken | undefined> | undefined
  private refreshController: AbortController | undefined

  constructor(private readonly options: TokenStoreOptions) {}

  private get key(): CredentialKey {
    return credentialKey(SCOPE, this.options.channelId)
  }

  private get legacyRef(): CredentialRef {
    return credentialRef(this.options.legacyRefName)
  }

  private log(message: string): void {
    this.options.log?.(message)
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task)
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  /** 读当前令牌：记录优先，记录缺失时才从旧引用迁移。 */
  read(): Promise<StoredToken | undefined> {
    return this.serialize(() => this.readLocked())
  }

  private async readLocked(): Promise<StoredToken | undefined> {
    const provider = this.options.provider()
    if (provider === undefined) return undefined
    const key = this.key
    const existing = await provider.readRecord(key)
    if (existing !== undefined) return parseGrantRecord(existing)

    const legacy = await this.readLegacy(provider)
    if (legacy === undefined) return undefined

    // 迁移：modifyRecord 里再确认「记录仍然不存在」——期间出现的记录（哪怕是
    // 无效 / 陌生的）优先，不被旧引用覆盖。
    const migrated = await provider.modifyRecord(key, async (current) => (
      current === undefined ? grantRecord(legacy) : undefined
    ))
    const token = parseGrantRecord(migrated)
    if (token === undefined) {
      this.log('凭据迁移被拒绝：已存在记录，旧引用保留不动')
      return undefined
    }
    // 新记录落库成功之后再清旧引用；清不掉只保留它并留安全日志（下次读取再试）。
    await this.clearLegacy(provider)
    return token
  }

  private async readLegacy(provider: CredentialProvider): Promise<StoredToken | undefined> {
    const hit = await provider.resolve(this.legacyRef)
    if (hit === undefined) return undefined
    let parsed: unknown
    try {
      parsed = JSON.parse(hit.value)
    } catch {
      return undefined
    }
    return parseStoredToken(parsed)
  }

  /** 清旧引用；失败只留安全日志（不带任何值），旧引用保留不动。 */
  private async clearLegacy(provider: CredentialProvider): Promise<void> {
    try {
      await provider.unset(this.legacyRef)
    } catch {
      this.log('旧凭据引用清理失败，已保留旧引用（新记录仍为权威来源）')
    }
  }

  /**
   * 写入令牌；`isCurrent` 在真正落库前再校验。落库期间被取消 / 被更新的尝试
   * 接管时，在**同一次串行任务内**回滚这次写入——回滚必然排在后续写入之前，
   * 且只删「还是我们刚写的那条」，不会清掉更新 / 外部的记录。
   */
  write(token: StoredToken, isCurrent: () => boolean = () => true): Promise<boolean> {
    return this.serialize(() => this.writeLocked(token, isCurrent))
  }

  private async writeLocked(token: StoredToken, isCurrent: () => boolean): Promise<boolean> {
    const provider = this.options.provider()
    if (provider === undefined || !isCurrent()) return false
    const key = this.key
    let landed = false
    let previous: CredentialRecord | undefined
    const writeId = randomUUID()
    await provider.modifyRecord(key, async (current) => {
      if (!isCurrent()) return undefined
      landed = true
      previous = current
      return { kind: 'grant', payload: { formatVersion: FORMAT_VERSION, token, writeId } }
    })
    if (!landed) return false
    if (isCurrent()) return true
    // 在同一原生事务里比较写入身份并恢复旧记录，不能 read-then-delete，
    // 否则另一进程刚写下的新登录可能被误删。无旧记录时留下已撤销标记，
    // 使遗留引用也不能重新迁移这次已取消的登录。
    await provider.modifyRecord(key, async (current) => {
      if (current?.kind !== 'grant' || current.payload === null || typeof current.payload !== 'object') return undefined
      if ((current.payload as { writeId?: unknown }).writeId !== writeId) return undefined
      return previous ?? { kind: 'grant', payload: { formatVersion: FORMAT_VERSION, revoked: true } }
    })
    return false
  }

  /**
   * 清空：先同步递增 generation 并 abort 在途刷新（迟到的刷新不落库），
   * 再串行删旧引用、撤销记录——先删旧引用，避免删掉记录后旧引用复活旧令牌。
   */
  clear(): Promise<void> {
    this.invalidate()
    return this.serialize(async () => {
      const provider = this.options.provider()
      if (provider === undefined) return
      try {
        await provider.unset(this.legacyRef)
      } catch {
        throw new Error('注销失败：旧凭据引用无法移除，已保留记录以避免旧登录复活')
      }
      // 撤销标记也参与事务排序：另一进程已读取的旧引用不能在注销后重新迁移。
      await provider.modifyRecord(this.key, async () => ({
        kind: 'grant', payload: { formatVersion: FORMAT_VERSION, revoked: true },
      }))
    })
  }

  /**
   * 读当前令牌，快过期就刷新并替换：整个「读-判断-刷新-替换」在 modifyRecord
   * 的跨进程事务里完成（锁跨网络 roundtrip），本地并发共用同一次刷新。
   * 注销后（generation 变了）不写、不返回新令牌。
   */
  /** 卸载只作废在途请求，保留已保存的登录。 */
  invalidate(): void {
    this.generation += 1
    this.refreshController?.abort()
    this.refreshController = undefined
    this.refreshing = undefined
  }

  fresh(refresh: RefreshToken): Promise<StoredToken | undefined> {
    if (this.refreshing !== undefined) return this.refreshing
    const generation = this.generation
    const run = this.serialize(() => this.freshOnce(refresh, generation)).finally(() => {
      if (this.refreshing === run) this.refreshing = undefined
    })
    this.refreshing = run
    return run
  }

  private async freshOnce(refresh: RefreshToken, generation: number): Promise<StoredToken | undefined> {
    if (generation !== this.generation) return undefined
    const provider = this.options.provider()
    if (provider === undefined) return undefined
    // 先读一次（记录缺失时把旧引用迁进来；我们已经在串行队列里，直接走 locked 版）
    if (await this.readLocked() === undefined) return undefined
    if (generation !== this.generation) return undefined

    const controller = new AbortController()
    this.refreshController = controller
    const key = this.key
    try {
      const after = await provider.modifyRecord(key, async (current) => {
        const token = parseGrantRecord(current)
        if (token === undefined) return undefined
        if (token.expires - Date.now() >= REFRESH_THRESHOLD_MS) return undefined
        // 锁在这里跨过网络：刷新失败会抛错，记录原样保留（不删）
        const refreshed = await refresh(token, controller.signal)
        if (generation !== this.generation) return undefined
        return grantRecord(mergeRefreshedToken(token, refreshed))
      })
      if (generation !== this.generation) return undefined
      return parseGrantRecord(after)
    } catch (error) {
      // 注销 / 取消导致的失败按「未登录」处理；真实 HTTP 失败照原样上报
      if (generation !== this.generation) return undefined
      throw error
    } finally {
      if (this.refreshController === controller) this.refreshController = undefined
    }
  }
}
