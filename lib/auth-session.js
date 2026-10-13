function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
class AuthSession {
  constructor(deps) {
    this.deps = deps;
  }
  deps;
  controller;
  pendingState;
  error;
  /** 开始新尝试：同步作废旧 attempt（abort + 清 pending / 错误），再建新的。 */
  begin() {
    this.cancel();
    const controller = new AbortController();
    this.controller = controller;
    return {
      signal: controller.signal,
      isCurrent: () => this.controller === controller && !controller.signal.aborted,
      publish: (pending) => {
        if (this.controller === controller) this.pendingState = pending;
      }
    };
  }
  /** 进行中尝试的信号（没有则 undefined）。 */
  signal() {
    return this.controller?.signal;
  }
  /** 进行中尝试的 pending（没有进行中的尝试返回 undefined）。 */
  pending() {
    return this.controller === void 0 ? void 0 : this.pendingState;
  }
  /** 最近一次失败原因（重试 / 注销后清空）。 */
  lastError() {
    return this.error;
  }
  /** 重试 / 注销时清掉错误。 */
  clearError() {
    this.error = void 0;
  }
  /** 会话结束（成功 / 失败）：只清属于这次尝试的状态。 */
  settle(attempt) {
    if (!attempt.isCurrent()) return;
    this.controller = void 0;
    this.pendingState = void 0;
  }
  /** 失败：只有仍属当前尝试时才记错误（旧失败不覆盖新错误），并记录日志。 */
  fail(attempt, error) {
    if (!attempt.isCurrent()) return;
    this.error = messageOf(error);
    this.deps.log(`\u767B\u5F55\u5931\u8D25: ${this.error}`);
    this.settle(attempt);
  }
  /** 取消：立即 abort、清 pending / 错误；不动已经存好的令牌。 */
  cancel() {
    const controller = this.controller;
    this.controller = void 0;
    this.pendingState = void 0;
    this.error = void 0;
    if (controller !== void 0 && !controller.signal.aborted) controller.abort();
  }
  /**
   * 成功路径：带 guard 落库 → 只有仍属当前尝试且确实落库了才 afterLogin。
   * 落库期间被取消的，写入由 TokenStore 在自己的串行任务里回滚。
   */
  async succeed(attempt, token, label = "\u767B\u5F55\u6210\u529F") {
    if (!attempt.isCurrent()) return false;
    const stored = await this.deps.write(token, () => attempt.isCurrent());
    if (!stored || !attempt.isCurrent()) return false;
    const account = token.accountId !== void 0 ? `\uFF08account: ${token.accountId}\uFF09` : "";
    this.deps.log(`${label}${account}\uFF0C\u5F00\u59CB\u53D1\u73B0\u6A21\u578B\u5217\u8868\u2026`);
    this.settle(attempt);
    this.deps.afterLogin();
    return true;
  }
}
export {
  AuthSession
};
