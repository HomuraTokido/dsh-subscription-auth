/**
 * 四个订阅渠道共享的一次性登录会话：attempt 身份、pending（url / userCode）、
 * 最近一次错误，以及「成功才写凭据 + afterLogin」这条路径。
 *
 * 规则：`begin()` 在任何 await 之前同步作废旧 attempt；每一步 await 之后调用方
 * 用 `attempt.isCurrent()` 复检；写凭据时把同一个 guard 交给驱动（TokenStore
 * 会在真正落库前和落库后再校验一次，取消时回滚自己刚写的那条）；`cancel()`
 * 立即 abort 并清 pending / 错误，但**不**删除已有令牌；`logout` = cancel + clear。
 * 旧 attempt 的失败不会覆盖新 attempt 的错误。
 * @module dsh-subscription-auth/auth-session
 */
import type { StoredToken } from './channel.js'

export interface AuthSessionDeps {
  log(message: string): void
  /** 持久化令牌（驱动侧 TokenStore）；isCurrent 为 false 时不得落库。返回是否落库。 */
  write(token: StoredToken, isCurrent: () => boolean): Promise<boolean>
  /** 凭据落库成功后的后续动作（模型发现 + 重新注册 provider）。 */
  afterLogin(): void
}

/** 一次登录尝试。只有 isCurrent() 为 true 时才有权改状态 / 写凭据。 */
export interface AuthAttempt<T> {
  /** 这次尝试的取消信号：回调服务器 / 设备轮询 / 换令牌 / userinfo 都要带上它。 */
  readonly signal: AbortSignal
  /** 是否仍是当前尝试（未被取消、未被更新的尝试替换）。 */
  isCurrent(): boolean
  /** 记录这次尝试的 pending（授权 URL / 设备码），供 authStatus 上报。 */
  publish(pending: T): void
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class AuthSession<T> {
  private controller: AbortController | undefined
  private pendingState: T | undefined
  private error: string | undefined

  constructor(private readonly deps: AuthSessionDeps) {}

  /** 开始新尝试：同步作废旧 attempt（abort + 清 pending / 错误），再建新的。 */
  begin(): AuthAttempt<T> {
    this.cancel()
    const controller = new AbortController()
    this.controller = controller
    return {
      signal: controller.signal,
      isCurrent: () => this.controller === controller && !controller.signal.aborted,
      publish: (pending: T) => {
        if (this.controller === controller) this.pendingState = pending
      },
    }
  }

  /** 进行中尝试的信号（没有则 undefined）。 */
  signal(): AbortSignal | undefined {
    return this.controller?.signal
  }

  /** 进行中尝试的 pending（没有进行中的尝试返回 undefined）。 */
  pending(): T | undefined {
    return this.controller === undefined ? undefined : this.pendingState
  }

  /** 最近一次失败原因（重试 / 注销后清空）。 */
  lastError(): string | undefined {
    return this.error
  }

  /** 重试 / 注销时清掉错误。 */
  clearError(): void {
    this.error = undefined
  }

  /** 会话结束（成功 / 失败）：只清属于这次尝试的状态。 */
  settle(attempt: AuthAttempt<T>): void {
    if (!attempt.isCurrent()) return
    this.controller = undefined
    this.pendingState = undefined
  }

  /** 失败：只有仍属当前尝试时才记错误（旧失败不覆盖新错误），并记录日志。 */
  fail(attempt: AuthAttempt<T>, error: unknown): void {
    if (!attempt.isCurrent()) return
    this.error = messageOf(error)
    this.deps.log(`登录失败: ${this.error}`)
    this.settle(attempt)
  }

  /** 取消：立即 abort、清 pending / 错误；不动已经存好的令牌。 */
  cancel(): void {
    const controller = this.controller
    this.controller = undefined
    this.pendingState = undefined
    this.error = undefined
    if (controller !== undefined && !controller.signal.aborted) controller.abort()
  }

  /**
   * 成功路径：带 guard 落库 → 只有仍属当前尝试且确实落库了才 afterLogin。
   * 落库期间被取消的，写入由 TokenStore 在自己的串行任务里回滚。
   */
  async succeed(attempt: AuthAttempt<T>, token: StoredToken, label = '登录成功'): Promise<boolean> {
    if (!attempt.isCurrent()) return false
    const stored = await this.deps.write(token, () => attempt.isCurrent())
    if (!stored || !attempt.isCurrent()) return false
    const account = token.accountId !== undefined ? `（account: ${token.accountId}）` : ''
    this.deps.log(`${label}${account}，开始发现模型列表…`)
    this.settle(attempt)
    this.deps.afterLogin()
    return true
  }
}
