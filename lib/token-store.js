import { randomUUID } from "node:crypto";
import { credentialKey, credentialRef } from "@deepseek-ai/dsh-credentials";
const SCOPE = "dsh-subscription-auth";
const FORMAT_VERSION = 1;
const REFRESH_THRESHOLD_MS = 6e4;
function isNonEmptyString(value) {
  return typeof value === "string" && value !== "";
}
function parseStoredToken(value) {
  if (value === null || typeof value !== "object") return void 0;
  const token = value;
  if (!isNonEmptyString(token.access) || !isNonEmptyString(token.refresh)) return void 0;
  if (typeof token.expires !== "number" || !Number.isFinite(token.expires)) return void 0;
  return value;
}
function parseGrantRecord(record) {
  if (record === void 0 || record.kind !== "grant") return void 0;
  const payload = record.payload;
  if (payload === null || typeof payload !== "object") return void 0;
  const shaped = payload;
  if (shaped.formatVersion !== FORMAT_VERSION) return void 0;
  return parseStoredToken(shaped.token);
}
function grantRecord(token) {
  const payload = { formatVersion: FORMAT_VERSION, token };
  return { kind: "grant", payload };
}
function mergeRefreshedToken(previous, refreshed) {
  return {
    ...refreshed,
    ...refreshed.refresh === "" ? { refresh: previous.refresh } : {},
    ...refreshed.accountId === void 0 && previous.accountId !== void 0 ? { accountId: previous.accountId } : {},
    ...refreshed.email === void 0 && previous.email !== void 0 ? { email: previous.email } : {}
  };
}
class TokenStore {
  constructor(options) {
    this.options = options;
  }
  options;
  /** 注销会把它推进：过期代号不再落库、也不再返回新令牌。 */
  generation = 0;
  /** 本地串行：read / write / clear / fresh 依次执行（跨进程串行靠 modifyRecord）。 */
  queue = Promise.resolve();
  /** 本地 singleflight：并发的 freshToken 共用一次刷新。 */
  refreshing;
  refreshController;
  get key() {
    return credentialKey(SCOPE, this.options.channelId);
  }
  get legacyRef() {
    return credentialRef(this.options.legacyRefName);
  }
  log(message) {
    this.options.log?.(message);
  }
  serialize(task) {
    const run = this.queue.then(task, task);
    this.queue = run.then(() => void 0, () => void 0);
    return run;
  }
  /** 读当前令牌：记录优先，记录缺失时才从旧引用迁移。 */
  read() {
    return this.serialize(() => this.readLocked());
  }
  async readLocked() {
    const provider = this.options.provider();
    if (provider === void 0) return void 0;
    const key = this.key;
    const existing = await provider.readRecord(key);
    if (existing !== void 0) return parseGrantRecord(existing);
    const legacy = await this.readLegacy(provider);
    if (legacy === void 0) return void 0;
    const migrated = await provider.modifyRecord(key, async (current) => current === void 0 ? grantRecord(legacy) : void 0);
    const token = parseGrantRecord(migrated);
    if (token === void 0) {
      this.log("\u51ED\u636E\u8FC1\u79FB\u88AB\u62D2\u7EDD\uFF1A\u5DF2\u5B58\u5728\u8BB0\u5F55\uFF0C\u65E7\u5F15\u7528\u4FDD\u7559\u4E0D\u52A8");
      return void 0;
    }
    await this.clearLegacy(provider);
    return token;
  }
  async readLegacy(provider) {
    const hit = await provider.resolve(this.legacyRef);
    if (hit === void 0) return void 0;
    let parsed;
    try {
      parsed = JSON.parse(hit.value);
    } catch {
      return void 0;
    }
    return parseStoredToken(parsed);
  }
  /** 清旧引用；失败只留安全日志（不带任何值），旧引用保留不动。 */
  async clearLegacy(provider) {
    try {
      await provider.unset(this.legacyRef);
    } catch {
      this.log("\u65E7\u51ED\u636E\u5F15\u7528\u6E05\u7406\u5931\u8D25\uFF0C\u5DF2\u4FDD\u7559\u65E7\u5F15\u7528\uFF08\u65B0\u8BB0\u5F55\u4ECD\u4E3A\u6743\u5A01\u6765\u6E90\uFF09");
    }
  }
  /**
   * 写入令牌；`isCurrent` 在真正落库前再校验。落库期间被取消 / 被更新的尝试
   * 接管时，在**同一次串行任务内**回滚这次写入——回滚必然排在后续写入之前，
   * 且只删「还是我们刚写的那条」，不会清掉更新 / 外部的记录。
   */
  write(token, isCurrent = () => true) {
    return this.serialize(() => this.writeLocked(token, isCurrent));
  }
  async writeLocked(token, isCurrent) {
    const provider = this.options.provider();
    if (provider === void 0 || !isCurrent()) return false;
    const key = this.key;
    let landed = false;
    let previous;
    const writeId = randomUUID();
    await provider.modifyRecord(key, async (current) => {
      if (!isCurrent()) return void 0;
      landed = true;
      previous = current;
      return { kind: "grant", payload: { formatVersion: FORMAT_VERSION, token, writeId } };
    });
    if (!landed) return false;
    if (isCurrent()) return true;
    await provider.modifyRecord(key, async (current) => {
      if (current?.kind !== "grant" || current.payload === null || typeof current.payload !== "object") return void 0;
      if (current.payload.writeId !== writeId) return void 0;
      return previous ?? { kind: "grant", payload: { formatVersion: FORMAT_VERSION, revoked: true } };
    });
    return false;
  }
  /**
   * 清空：先同步递增 generation 并 abort 在途刷新（迟到的刷新不落库），
   * 再串行删旧引用、撤销记录——先删旧引用，避免删掉记录后旧引用复活旧令牌。
   */
  clear() {
    this.invalidate();
    return this.serialize(async () => {
      const provider = this.options.provider();
      if (provider === void 0) return;
      try {
        await provider.unset(this.legacyRef);
      } catch {
        throw new Error("\u6CE8\u9500\u5931\u8D25\uFF1A\u65E7\u51ED\u636E\u5F15\u7528\u65E0\u6CD5\u79FB\u9664\uFF0C\u5DF2\u4FDD\u7559\u8BB0\u5F55\u4EE5\u907F\u514D\u65E7\u767B\u5F55\u590D\u6D3B");
      }
      await provider.modifyRecord(this.key, async () => ({
        kind: "grant",
        payload: { formatVersion: FORMAT_VERSION, revoked: true }
      }));
    });
  }
  /**
   * 读当前令牌，快过期就刷新并替换：整个「读-判断-刷新-替换」在 modifyRecord
   * 的跨进程事务里完成（锁跨网络 roundtrip），本地并发共用同一次刷新。
   * 注销后（generation 变了）不写、不返回新令牌。
   */
  /** 卸载只作废在途请求，保留已保存的登录。 */
  invalidate() {
    this.generation += 1;
    this.refreshController?.abort();
    this.refreshController = void 0;
    this.refreshing = void 0;
  }
  fresh(refresh) {
    if (this.refreshing !== void 0) return this.refreshing;
    const generation = this.generation;
    const run = this.serialize(() => this.freshOnce(refresh, generation)).finally(() => {
      if (this.refreshing === run) this.refreshing = void 0;
    });
    this.refreshing = run;
    return run;
  }
  async freshOnce(refresh, generation) {
    if (generation !== this.generation) return void 0;
    const provider = this.options.provider();
    if (provider === void 0) return void 0;
    if (await this.readLocked() === void 0) return void 0;
    if (generation !== this.generation) return void 0;
    const controller = new AbortController();
    this.refreshController = controller;
    const key = this.key;
    try {
      const after = await provider.modifyRecord(key, async (current) => {
        const token = parseGrantRecord(current);
        if (token === void 0) return void 0;
        if (token.expires - Date.now() >= REFRESH_THRESHOLD_MS) return void 0;
        const refreshed = await refresh(token, controller.signal);
        if (generation !== this.generation) return void 0;
        return grantRecord(mergeRefreshedToken(token, refreshed));
      });
      if (generation !== this.generation) return void 0;
      return parseGrantRecord(after);
    } catch (error) {
      if (generation !== this.generation) return void 0;
      throw error;
    } finally {
      if (this.refreshController === controller) this.refreshController = void 0;
    }
  }
}
export {
  REFRESH_THRESHOLD_MS,
  TokenStore,
  grantRecord,
  mergeRefreshedToken,
  parseGrantRecord,
  parseStoredToken
};
