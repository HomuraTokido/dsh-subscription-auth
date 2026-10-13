/**
 * TokenStore 单元测试（node 直接跑 lib/token-store.js，main 负责构建）。
 * 用带真实事务语义的 credential mock：modifyRecord 串行、mutate 拿到当前记录、
 * 返回 undefined 表示不改；引用半边（resolve/unset）承接旧令牌迁移。
 * 覆盖：旧引用迁移、严格校验、陌生记录不被覆盖、迁移失败保留旧引用、
 * 写入 guard + 取消回滚（不影响更新写入）、注销不复活、刷新 singleflight /
 * 非旋转字段 / 失败不删记录。
 * 运行：node tests/token-store.mjs
 */
import assert from 'node:assert/strict'
import { credentialKey, credentialKeyScope, credentialRef } from '@deepseek-ai/dsh-credentials'
import { REFRESH_THRESHOLD_MS, TokenStore, grantRecord, parseStoredToken } from '../lib/token-store.js'
import { name as pluginName } from '../lib/index.js'

// scope 必须是实际注册的插件名：写错会挂成孤儿记录（谁也不会去读它）
const KEY = String(credentialKey('dsh-subscription-auth', 'chatgpt'))
const REF = String(credentialRef('CHATGPT_SUBSCRIPTION_TOKEN'))
const token = (access, extra = {}) => ({ refresh: `r-${access}`, access, expires: Date.now() + 3600_000, ...extra })
const legacyJson = (value) => JSON.stringify(value)

/**
 * 真实 credential mock。
 * options.commitGate：modifyRecord 在 mutate 返回之后、落库之前 await 它（模拟写入在途）。
 * options.hideRecords：readRecord 一律返回 undefined（模拟记录在 read 之后才出现）。
 */
function createProvider({ legacy = {}, seed = [], commitGate = undefined, hideRecords = false } = {}) {
  const state = { legacy: { ...legacy }, records: new Map(seed), commitGate }
  const calls = { resolves: 0, unsets: 0, reads: 0, modifies: 0, deletes: 0 }
  let queue = Promise.resolve()
  const provider = {
    resolve: async (ref) => {
      calls.resolves += 1
      const raw = state.legacy[String(ref)]
      return raw === undefined ? undefined : { value: raw }
    },
    set: async (ref, value) => { state.legacy[String(ref)] = value },
    unset: async (ref) => {
      calls.unsets += 1
      if (state.failUnset === true) throw new Error('unset failed')
      delete state.legacy[String(ref)]
    },
    readRecord: async (key) => {
      calls.reads += 1
      return hideRecords ? undefined : state.records.get(String(key))
    },
    modifyRecord: async (key, mutate) => {
      calls.modifies += 1
      const run = queue.then(async () => {
        const next = await mutate(state.records.get(String(key)))
        if (state.commitGate !== undefined) {
          const gate = state.commitGate
          state.commitGate = undefined
          await gate
        }
        if (next !== undefined) state.records.set(String(key), next)
        return state.records.get(String(key))
      })
      queue = run.then(() => undefined, () => undefined)
      return run
    },
    deleteRecord: async (key) => { calls.deletes += 1; state.records.delete(String(key)) },
  }
  return { provider, state, calls }
}

function storeFor(provider, logs = []) {
  return new TokenStore({
    provider: () => provider,
    channelId: 'chatgpt',
    legacyRefName: 'CHATGPT_SUBSCRIPTION_TOKEN',
    log: (message) => logs.push(message),
  })
}

// ---------- 0. scope 与实际注册的插件名一致（不是 subscription-auth 孤儿） ----------
assert.equal(pluginName, 'dsh-subscription-auth', '插件注册名')
assert.equal(credentialKeyScope(KEY), pluginName, 'grant record 的 scope 必须等于实际注册的插件名')

// ---------- 1. 旧引用迁移 ----------
{
  const { provider, state, calls } = createProvider({ legacy: { [REF]: legacyJson(token('old')) } })
  const logs = []
  const store = storeFor(provider, logs)
  const read = await store.read()
  assert.equal(read.access, 'old', '旧引用里的令牌要读得到')
  const record = state.records.get(KEY)
  assert.equal(record.kind, 'grant', '落库成 grant record')
  assert.deepEqual(Object.keys(record.payload).sort(), ['formatVersion', 'token'])
  assert.equal(record.payload.formatVersion, 1)
  assert.equal(record.payload.token.access, 'old')
  assert.equal(state.legacy[REF], undefined, '迁移成功后旧引用被清掉')
  assert.equal(calls.unsets, 1)
  // 第二次读：记录优先，不再碰旧引用
  const before = calls.resolves
  assert.equal((await store.read()).access, 'old')
  assert.equal(calls.resolves, before, '有记录时不再读旧引用')
  console.log('✓ 1. 旧引用 → grant record 迁移；迁移后旧引用清理、记录优先')
}

// ---------- 2. 严格校验 ----------
{
  for (const [label, value] of [
    ['access 为空', { refresh: 'r', access: '', expires: Date.now() + 1000 }],
    ['refresh 为空', { refresh: '', access: 'a', expires: Date.now() + 1000 }],
    ['expires 非数字', { refresh: 'r', access: 'a', expires: 'soon' }],
    ['expires 非有限', { refresh: 'r', access: 'a', expires: Number.POSITIVE_INFINITY }],
    ['不是对象', 'not-a-token'],
  ]) {
    assert.equal(parseStoredToken(value), undefined, `${label} 必须判为无效`)
  }
  const { provider, state } = createProvider({ legacy: { [REF]: legacyJson({ refresh: 'r', access: 'a', expires: Number.NaN }) } })
  const store = storeFor(provider)
  assert.equal(await store.read(), undefined, '无效旧令牌不迁移')
  assert.equal(state.records.size, 0, '无效旧令牌不落库')
  assert.notEqual(state.legacy[REF], undefined, '无效旧令牌留在原处')
  console.log('✓ 2. 严格校验（access/refresh 非空、expires 有限），无效旧引用不迁移')
}

// ---------- 3. 已存在的无效 / 陌生记录不被旧引用覆盖 ----------
{
  const foreign = { kind: 'api-key', key: 'other-plugin-key' }
  const { provider, state } = createProvider({
    legacy: { [REF]: legacyJson(token('legacy')) },
    seed: [[KEY, foreign]],
  })
  const store = storeFor(provider)
  assert.equal(await store.read(), undefined, '陌生记录当「不是我们的凭据」')
  assert.deepEqual(state.records.get(KEY), foreign, '陌生记录不得被覆盖')
  assert.notEqual(state.legacy[REF], undefined, '陌生记录在场时不动旧引用')

  const wrongVersion = { kind: 'grant', payload: { formatVersion: 2, token: token('v2') } }
  const second = createProvider({ legacy: { [REF]: legacyJson(token('legacy')) }, seed: [[KEY, wrongVersion]] })
  assert.equal(await storeFor(second.provider).read(), undefined, '不认识的 formatVersion 当无效')
  assert.deepEqual(second.state.records.get(KEY), wrongVersion, '不认识的记录不得被覆盖')
  console.log('✓ 3. 陌生 kind / 不认识的 formatVersion：不覆盖、不回退旧引用')
}

// ---------- 4. 迁移期间出现记录 → 以记录为准 ----------
{
  // 4a. 期间出现的是「不是我们的」记录：放弃迁移、不覆盖、旧引用保留
  const foreign = { kind: 'api-key', key: 'appeared' }
  const { provider, state, calls } = createProvider({
    legacy: { [REF]: legacyJson(token('legacy')) },
    seed: [[KEY, foreign]],
    hideRecords: true,
  })
  const logs = []
  const store = storeFor(provider, logs)
  assert.equal(await store.read(), undefined, '迁移被拒时以记录为准')
  assert.deepEqual(state.records.get(KEY), foreign, '已有记录不被旧引用覆盖')
  assert.notEqual(state.legacy[REF], undefined, '旧引用保留（没迁移成功就不清）')
  assert.equal(calls.unsets, 0)
  assert.ok(logs.some((line) => line.includes('迁移被拒绝')), '留安全日志')

  // 4b. 期间出现的是我们自己的有效记录：记录为准，旧引用作为陈迹清掉
  const appeared = grantRecord(token('appeared'))
  const second = createProvider({
    legacy: { [REF]: legacyJson(token('legacy')) },
    seed: [[KEY, appeared]],
    hideRecords: true,
  })
  const read = await storeFor(second.provider).read()
  assert.equal(read.access, 'appeared', '记录里的令牌优先于旧引用')
  assert.equal(second.state.legacy[REF], undefined, '记录已经是权威来源，清掉旧引用')
  console.log('✓ 4. modifyRecord 内复检：陌生记录处理为拒绝 + 保留；自家记录为准')
}

// ---------- 5. 迁移后清旧引用失败 ----------
{
  const { provider, state } = createProvider({ legacy: { [REF]: legacyJson(token('legacy')) } })
  provider.unset = async () => { throw new Error('unset failed') }
  const logs = []
  const store = storeFor(provider, logs)
  const read = await store.read()
  assert.equal(read.access, 'legacy', '清不掉旧引用也要能用新记录')
  assert.equal(state.records.get(KEY).payload.token.access, 'legacy', '新记录已经落库')
  assert.ok(state.legacy[REF] !== undefined, '旧引用保留不动')
  assert.ok(logs.length > 0, '要留安全日志')
  assert.ok(!logs.join(' ').includes('legacy'), '日志里不能出现令牌值')
  console.log('✓ 5. 迁移后 unset 失败：新记录保留、旧引用保留、日志无值')
}

// ---------- 6. 写入 guard ----------
{
  const { provider, state } = createProvider()
  const store = storeFor(provider)
  assert.equal(await store.write(token('blocked'), () => false), false, 'guard 为 false 不写')
  assert.equal(state.records.size, 0)
  assert.equal(await store.write(token('ok')), true, '默认 guard（true）写入成功')
  assert.equal(state.records.get(KEY).payload.token.access, 'ok')
  assert.equal(await store.write(token('guarded'), () => true), true)
  console.log('✓ 6. write：guard 默认通过；guard 为 false 时不落库且返回 false')
}

// ---------- 7. 写入在途被取消 → 回滚自己那条，不影响后续写入 ----------
{
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const { provider, state, calls } = createProvider({ commitGate: gate })
  const store = storeFor(provider)
  let live = true
  const pending = store.write(token('cancelled'), () => live)
  while (calls.modifies === 0) await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  live = false
  release()
  assert.equal(await pending, false, '落库后复检发现已取消 → false')
  assert.equal(await store.read(), undefined, '撤销记录不再返回被取消的令牌')
  assert.equal(calls.deletes, 0, '回滚必须在modifyRecord内比较身份，不能无条件删除')
  assert.equal(await store.write(token('newer')), true, '后续（更新）写入正常落库')
  assert.equal(state.records.get(KEY).payload.token.access, 'newer', '回滚不得影响更新的写入')
  console.log('✓ 7. write：落库中取消 → 回滚本次写入，且不影响后续更新写入')
}

// ---------- 8. 注销：清引用 + 记录、不复活 ----------
{
  const { provider, state, calls } = createProvider({
    legacy: { [REF]: legacyJson(token('legacy')) },
    seed: [[KEY, grantRecord(token('stored'))]],
  })
  const events = []
  const originalUnset = provider.unset
  const originalModify = provider.modifyRecord
  provider.unset = async (ref) => { events.push('unset'); return await originalUnset(ref) }
  provider.modifyRecord = async (key, mutate) => { events.push('revoke'); return await originalModify(key, mutate) }
  const store = storeFor(provider)
  await store.clear()
  assert.deepEqual(events, ['unset', 'revoke'], '先清旧引用再事务撤销，避免旧令牌复活')
  assert.equal(state.legacy[REF], undefined)
  assert.equal(state.records.get(KEY).payload.revoked, true)
  assert.equal(await store.read(), undefined, '注销后读不到令牌')
  console.log('✓ 8. clear：先 unset 旧引用再删记录；注销后读为空')
}

// ---------- 9. 注销打断在途刷新（generation） ----------
{
  let started
  const startedPromise = new Promise((resolve) => { started = resolve })
  let refreshCalls = 0
  const { provider, state } = createProvider({ seed: [[KEY, grantRecord(token('expired', { expires: Date.now() - 1000 }))]] })
  const store = storeFor(provider)
  const pending = store.fresh(async (current, signal) => {
    refreshCalls += 1
    assert.equal(current.access, 'expired', '刷新拿到的是当前记录')
    assert.ok(signal instanceof AbortSignal, '刷新拿到取消信号')
    started()
    // 真实 fetch 在 signal abort 时会立刻拒绕
    await new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })
    return token('refreshed')
  })
  await startedPromise
  await store.clear()
  assert.equal(await pending, undefined, '注销后不返回新令牌')
  assert.equal(refreshCalls, 1)
  assert.equal(state.records.get(KEY).payload.revoked, true, '注销后只留无令牌撤销标记，迟到刷新不写回')
  assert.equal(await store.read(), undefined)
  console.log('✓ 9. clear 打断在途刷新：迟到的刷新不写、不返回新令牌')
}

// ---------- 10. freshToken：门槛 / 合并 / singleflight / HTTP 失败 ----------
{
  const fresh = token('fresh-access', { accountId: 'acct-1', email: 'a@b.c' })
  const { provider, state } = createProvider({ seed: [[KEY, grantRecord(fresh)]] })
  let refreshCalls = 0
  const store = storeFor(provider)
  const hit = await store.fresh(async () => { refreshCalls += 1; return token('never') })
  assert.equal(hit.access, 'fresh-access', `未过期（>= ${REFRESH_THRESHOLD_MS}ms）不刷新`)
  assert.equal(refreshCalls, 0)

  const expired = { refresh: 'r-old', access: 'old', expires: Date.now() - 1, accountId: 'acct-1' }
  const second = createProvider({ seed: [[KEY, grantRecord(expired)]] })
  const store2 = storeFor(second.provider)
  let calls = 0
  const [a, b] = await Promise.all([
    store2.fresh(async () => { calls += 1; await Promise.resolve(); return { refresh: '', access: 'new', expires: Date.now() + 3600_000 } }),
    store2.fresh(async () => { calls += 1; return { refresh: '', access: 'new', expires: Date.now() + 3600_000 } }),
  ])
  assert.equal(calls, 1, '并发 fresh 只刷新一次（singleflight）')
  assert.equal(a.access, 'new')
  assert.equal(b.access, 'new')
  const stored = second.state.records.get(KEY).payload.token
  assert.equal(stored.refresh, 'r-old', '刷新响应没给 refresh 时沿用旧值（非旋转字段）')
  assert.equal(stored.accountId, 'acct-1', 'accountId 保留')
  console.log('✓ 10. fresh：60 秒门槛、本地 singleflight、保留非旋转字段')

  const failing = createProvider({ seed: [[KEY, grantRecord(expired)]] })
  const store3 = storeFor(failing.provider)
  await assert.rejects(
    () => store3.fresh(async () => { throw new Error('token refresh failed (HTTP 400)') }),
    /token refresh failed \(HTTP 400\)/,
  )
  assert.equal(failing.state.records.get(KEY).payload.token.access, 'old', '真实 HTTP 失败不删除既存记录')
  assert.equal(await store3.fresh(async () => { throw new Error('again') }).catch(() => 'threw'), 'threw', '失败后 singleflight 不粘住')
  console.log('✓ 11. fresh：真实 HTTP 失败原样上报，既存记录保留，失败后不粘住')
}

console.log('\n✓ token-store 全部通过')

// 原生事务回滚必须恢复先前登录，并且保留外部写入。
for (const external of [false, true]) {
  let release, entered
  const gate = new Promise(resolve => { release = resolve })
  const start = new Promise(resolve => { entered = resolve })
  const prior = grantRecord(token('previous'))
  const { provider, state } = createProvider({ seed: [[KEY, prior]] })
  const modify = provider.modifyRecord
  let first = true
  provider.modifyRecord = async (key, mutate) => {
    const result = await modify(key, mutate)
    if (first) {
      first = false
      entered()
      await gate
      if (external) await modify(key, async () => grantRecord(token('external')))
    }
    return result
  }
  const store = storeFor(provider)
  let live = true
  const pending = store.write(token('cancelled'), () => live)
  await start
  live = false
  release()
  assert.equal(await pending, false)
  assert.equal((await store.read()).access, external ? 'external' : 'previous')
}
{
  const { provider, state } = createProvider({ legacy: { [REF]: legacyJson(token('legacy')) }, seed: [[KEY, grantRecord(token('current'))]] })
  state.failUnset = true
  const store = storeFor(provider)
  await assert.rejects(store.clear(), /注销失败/)
  assert.equal(state.records.get(KEY).payload.token.access, 'current', '旧引用删除失败时保留权威记录，不能复活legacy')
}
console.log('✓ 12. 事务回滚保留原登录与外部新登录，注销失败不掩盖')

// 两个store模拟两个进程：旧ref已被读取但迁移尚未提交时，另一个注销。
{
  const { provider, state } = createProvider({ legacy: { [REF]: legacyJson(token('old-ref')) } })
  const migrate = storeFor(provider)
  const logout = storeFor(provider)
  const resolve = provider.resolve
  let release, entered
  const gate = new Promise(r => { release = r })
  const start = new Promise(r => { entered = r })
  let once = true
  provider.resolve = async ref => {
    const result = await resolve(ref)
    if (once) { once = false; entered(); await gate }
    return result
  }
  const reading = migrate.read()
  await start
  await logout.clear()
  release()
  assert.equal(await reading, undefined)
  assert.equal(state.records.get(KEY).payload.revoked, true)
  assert.equal(state.legacy[REF], undefined)
}
console.log('✓ 13. 跨store注销压过已读旧引用的迟到迁移')
