/**
 * AuthSession 单元测试（node 直接跑 lib/auth-session.js，main 负责构建）。
 * 覆盖四渠道共享的 attempt 生命周期：作废、identity 复检、pending、错误归属、
 * 成功写入 + afterLogin、取消（含持久化中取消）。
 * 运行：node tests/auth-session.mjs
 */
import assert from 'node:assert/strict'
import { AuthSession } from '../lib/auth-session.js'

const token = (access, extra = {}) => ({ refresh: `r-${access}`, access, expires: Date.now() + 3600_000, ...extra })

/** 记录写入 / afterLogin 的 session。写入默认成功（等价 TokenStore 落库）。 */
function harness(write) {
  const state = { writes: [], afterLogin: 0, logs: [] }
  const session = new AuthSession({
    log: (message) => state.logs.push(message),
    write: write ?? (async (value, isCurrent) => {
      if (!isCurrent()) return false
      state.writes.push(value.access)
      return true
    }),
    afterLogin: () => { state.afterLogin += 1 },
  })
  return { state, session }
}

// ---------- 身份：begin 立刻作废旧 attempt ----------
{
  const { session } = harness()
  const first = session.begin()
  assert.equal(first.isCurrent(), true, '新 attempt 是当前的')
  first.publish({ url: 'first' })
  const second = session.begin()
  assert.equal(first.isCurrent(), false, '新尝试开始后旧 attempt 立即失效')
  assert.equal(first.signal.aborted, true, '旧 attempt 的 signal 被 abort')
  assert.equal(second.isCurrent(), true)
  assert.equal(session.pending(), undefined, 'begin 清掉旧 pending')
  console.log('✓ 1. begin：同步作废旧 attempt（abort + 清 pending）')
}

// ---------- pending / cancel ----------
{
  const { session } = harness()
  const attempt = session.begin()
  attempt.publish({ url: 'https://example.test/auth' })
  assert.deepEqual(session.pending(), { url: 'https://example.test/auth' })
  session.cancel()
  assert.equal(attempt.isCurrent(), false)
  assert.equal(session.pending(), undefined, 'cancel 清 pending')
  assert.equal(session.lastError(), undefined, 'cancel 清错误')
  assert.equal(attempt.signal.aborted, true, 'cancel 立即 abort')
  console.log('✓ 2. publish / pending / cancel（取消不算失败，也不动既有令牌）')
}

// ---------- 错误归属：旧失败不覆盖新错误 ----------
{
  const { session, state } = harness()
  const first = session.begin()
  const second = session.begin()
  session.fail(first, new Error('旧失败'))
  assert.equal(session.lastError(), undefined, '旧 attempt 的失败不得写入错误')
  session.fail(second, new Error('新失败'))
  assert.equal(session.lastError(), '新失败')
  assert.ok(state.logs.some((line) => line.includes('新失败')), '失败要留日志')
  assert.equal(second.isCurrent(), false, '失败即结束这次 attempt')
  session.begin()
  assert.equal(session.lastError(), undefined, '重试清掉上次的失败')
  console.log('✓ 3. fail：只有当前 attempt 能记错误，重试清空')
}

// ---------- settle：只清自己的 attempt ----------
{
  const { session } = harness()
  const first = session.begin()
  first.publish({ url: 'first' })
  const second = session.begin()
  second.publish({ url: 'second' })
  session.settle(first)
  assert.deepEqual(session.pending(), { url: 'second' }, '旧 attempt 迟到的 settle 不得清新尝试')
  assert.equal(second.isCurrent(), true)
  session.settle(second)
  assert.equal(session.pending(), undefined)
  console.log('✓ 4. settle：旧 attempt 清不掉新 attempt 的 pending')
}

// ---------- 成功路径 ----------
{
  const { session, state } = harness()
  const attempt = session.begin()
  attempt.publish({ url: 'u' })
  assert.equal(await session.succeed(attempt, token('a1', { accountId: 'acct-1' })), true)
  assert.deepEqual(state.writes, ['a1'])
  assert.equal(state.afterLogin, 1, '落库成功后 afterLogin 一次')
  assert.equal(session.pending(), undefined)
  assert.ok(state.logs.some((line) => line.includes('acct-1')), '日志带上账号')
  console.log('✓ 5. succeed：带 guard 落库 → afterLogin 一次')
}

{
  const { session, state } = harness()
  const attempt = session.begin()
  session.cancel()
  assert.equal(await session.succeed(attempt, token('a2')), false)
  assert.deepEqual(state.writes, [], '已取消的 attempt 不写凭据')
  assert.equal(state.afterLogin, 0)
  console.log('✓ 6. succeed：已取消的 attempt 不写、不 afterLogin')
}

{
  // 落库中取消：guard 在落库后被复检 → 不 afterLogin（写入由 TokenStore 回滚）
  const state = { afterLogin: 0 }
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const session = new AuthSession({
    log: () => {},
    write: async (_value, isCurrent) => { await gate; return isCurrent() },
    afterLogin: () => { state.afterLogin += 1 },
  })
  const attempt = session.begin()
  const pending = session.succeed(attempt, token('a3'))
  await Promise.resolve()
  session.cancel()
  release()
  assert.equal(await pending, false, '落库完成时已经不是当前 attempt → 视为未落库')
  assert.equal(state.afterLogin, 0, '取消后不得 afterLogin')
  console.log('✓ 7. succeed：持久化进行中取消 → 不 afterLogin')
}

{
  // 写入自报失败（TokenStore 取消回滚）→ 不 afterLogin
  const { session, state } = harness(async () => false)
  const attempt = session.begin()
  assert.equal(await session.succeed(attempt, token('a4')), false)
  assert.equal(state.afterLogin, 0)
  console.log('✓ 8. succeed：写入未落库（false）→ 不 afterLogin')
}

console.log('\n✓ auth-session 全部通过')
