import type { CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials';
import type { RefreshToken, StoredToken } from './channel.js';
/** 剩余寿命低于这个值就在请求前刷新。 */
export declare const REFRESH_THRESHOLD_MS = 60000;
export interface TokenStoreOptions {
    /** 当前 credential 服务（可能尚未就绪）。 */
    provider(): CredentialProvider | undefined;
    /** 渠道 id（credential key 的 id 段，小写连字符标识符）。 */
    channelId: string;
    /** 旧的环境变量引用名（迁移来源）。 */
    legacyRefName: string;
    /** 只用于无值的安全提示。 */
    log?(message: string): void;
}
/** 严格校验一个令牌：access / refresh 非空，expires 是有限数字。 */
export declare function parseStoredToken(value: unknown): StoredToken | undefined;
/** 解析我们自己写下的记录；不是我们的（kind / 版本 / 字段不对）返回 undefined。 */
export declare function parseGrantRecord(record: CredentialRecord | undefined): StoredToken | undefined;
/** 包装成 grant record。 */
export declare function grantRecord(token: StoredToken): CredentialRecord;
/** 刷新响应缺字段时沿用旧令牌的非旋转字段（refresh / accountId / email）。 */
export declare function mergeRefreshedToken(previous: StoredToken, refreshed: StoredToken): StoredToken;
export declare class TokenStore {
    private readonly options;
    /** 注销会把它推进：过期代号不再落库、也不再返回新令牌。 */
    private generation;
    /** 本地串行：read / write / clear / fresh 依次执行（跨进程串行靠 modifyRecord）。 */
    private queue;
    /** 本地 singleflight：并发的 freshToken 共用一次刷新。 */
    private refreshing;
    private refreshController;
    constructor(options: TokenStoreOptions);
    private get key();
    private get legacyRef();
    private log;
    private serialize;
    /** 读当前令牌：记录优先，记录缺失时才从旧引用迁移。 */
    read(): Promise<StoredToken | undefined>;
    private readLocked;
    private readLegacy;
    /** 清旧引用；失败只留安全日志（不带任何值），旧引用保留不动。 */
    private clearLegacy;
    /**
     * 写入令牌；`isCurrent` 在真正落库前再校验。落库期间被取消 / 被更新的尝试
     * 接管时，在**同一次串行任务内**回滚这次写入——回滚必然排在后续写入之前，
     * 且只删「还是我们刚写的那条」，不会清掉更新 / 外部的记录。
     */
    write(token: StoredToken, isCurrent?: () => boolean): Promise<boolean>;
    private writeLocked;
    /**
     * 清空：先同步递增 generation 并 abort 在途刷新（迟到的刷新不落库），
     * 再串行删旧引用、撤销记录——先删旧引用，避免删掉记录后旧引用复活旧令牌。
     */
    clear(): Promise<void>;
    /**
     * 读当前令牌，快过期就刷新并替换：整个「读-判断-刷新-替换」在 modifyRecord
     * 的跨进程事务里完成（锁跨网络 roundtrip），本地并发共用同一次刷新。
     * 注销后（generation 变了）不写、不返回新令牌。
     */
    /** 卸载只作废在途请求，保留已保存的登录。 */
    invalidate(): void;
    fresh(refresh: RefreshToken): Promise<StoredToken | undefined>;
    private freshOnce;
}
