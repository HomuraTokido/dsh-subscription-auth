/**
 * ChatGPT 登录修复的确定性测试（node 运行：`node tests/chatgpt-auth.mjs`）。
 *
 * 覆盖：
 *  1. startCallbackListener：只绑 127.0.0.1、真正 listening 之后才 resolve、
 *     path / 缺 code / state / error 参数 / 超时 / 取消 / 端口被占（保留
 *     err.code）、readiness 在 abort/超时/绑定失败时也必须 settle、close 之后
 *     迟到的 listening 不算成功、未 await 的 code rejection 不得变成
 *     unhandledRejection；waitForCallback 包装行为不变；boundedSignal 上限。
 *  2. 设备授权 wire（mock fetch，无真实凭据、无外部网络）：usercode / poll /
 *     换令牌的请求 URL 与请求体、403/404 视为 pending、字段别名（usercode）、
 *     interval 字符串、15 分钟过期、错误信息不带响应原文、取消立即中止在途
 *     请求、轮询不重叠。
 *  3. ChatGPT 回调端口：1455 优先、只有 EACCES/EADDRINUSE 才换 1457、两个都
 *     不行才走设备流、非端口错误不静默降级、浏览器只在绑定成功后打开、
 *     配置端口只在 1455/1457 之内生效。
 *  4. 登录成功 / 失败链路：换令牌写入 credential、afterLogin 只触发一次、
 *     失败（设备码请求 / 异步轮询 / 换令牌）进 authStatus.error、注销清空。
 *  5. 取消与「旧尝试 / 新尝试」隔离：取消后不再换令牌、不写凭据、不
 *     afterLogin；绑定等待期间取消要关掉监听器；设备码请求在途时取消 / 重试
 *     不覆盖新尝试；被取消的在途凭据写入先回滚、再写新尝试的令牌。
 *  6. 轮询边界（可控时钟，不真等）：expiresInSeconds=0 不轮询；slow_down
 *     逐次 +5s；最后一跳裁到 deadline 且到期后不再请求；间隔中取消清掉计时器；
 *     failed 不重试；interval 非法值退回 5s；畸形 JSON 拒绝、结构错误不回显原文。
 *  7. 两个渠道实例互不干扰（取消 A 不影响 B 完成）+ 回调重复到达 / state 不匹配。
 *
 * 生产代码里没有测试后门：node:http 与 node:child_process 在测试侧用 esbuild
 * 替换（见下面的 stub 源码），设备 wire 用 globalThis.fetch 替换。
 * 临时产物写在 tests/.tmp-chatgpt-auth/，跑完删除。
 */
import assert from 'node:assert'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer as createNetServer, connect as netConnect } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tmp = join(root, 'tests', '.tmp-chatgpt-auth')
const realFetch = globalThis.fetch

const unhandled = []
process.on('unhandledRejection', (reason) => { unhandled.push(reason) })

// 抓一份真实计时器 / 时钟：下面的 fake clock 会临时替换 globalThis.setTimeout 与
// Date.now，测试自己的等待（waitFor / sleep）必须继续走真实实现。
const realSetTimeout = globalThis.setTimeout.bind(globalThis)
const realNow = Date.now.bind(Date)
const sleep = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms))

/** 轮询等待条件成立（只用来等「发生」，不用来断言「没发生」）。 */
async function waitFor(predicate, { timeout = 3000, interval = 10 } = {}) {
  const deadline = realNow() + timeout
  while (realNow() < deadline) {
    if (await predicate()) return
    await sleep(interval)
  }
  throw new Error('waitFor 超时')
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function neverExpected(label) {
  return async () => { throw new Error(`不该发请求：${label}`) }
}

// ---------- 测试侧替换模块 ----------

const HTTP_STUB = `import { EventEmitter } from 'node:events'

// 假的 node:http：listen 成不成由 globalThis.__testHttpStub.failPorts 决定。
// 状态挂在 globalThis 上，测试文件与 bundle 共享同一份。
//   attempts       —— 每次 listen 调用（含失败的），用来断言「试过哪些端口」
//   listening      —— 真正绑定成功的服务器（close 后移出）
//   deferListen    —— true 时先不触发 listening，等测试调 flushStubListen()
globalThis.__testHttpStub = globalThis.__testHttpStub || {
  failPorts: new Map(),
  attempts: [],
  listening: [],
  deferredListen: [],
  deferListen: false,
  closed: 0,
}

export function createServer() {
  const server = new EventEmitter()
  server.listening = false
  server.closed = false
  server.listen = (port, host, callback) => {
    const state = globalThis.__testHttpStub
    state.attempts.push({ port, host })
    const settleListen = () => {
      // close() 先到（abort / 超时）：真实 node 会关掉 handle，listening 不再发出，
      // 也就不会有「绑定成功」的记录。
      if (server.closed) return
      const failure = state.failPorts.get(port)
      if (failure !== undefined) {
        const error = new Error('listen ' + failure + ': address already in use ' + host + ':' + port)
        error.code = failure
        server.emit('error', error)
        return
      }
      server.listening = true
      state.listening.push({ port, host, server })
      if (typeof callback === 'function') callback()
      server.emit('listening')
    }
    queueMicrotask(() => {
      if (state.deferListen) state.deferredListen.push(settleListen)
      else settleListen()
    })
    return server
  }
  server.close = () => {
    server.closed = true
    server.listening = false
    const state = globalThis.__testHttpStub
    state.listening = state.listening.filter((entry) => entry.server !== server)
    state.closed += 1
    return server
  }
  return server
}

export default { createServer }
`

const CHILD_PROCESS_STUB = `// 假的 node:child_process：openBrowser 只记录参数，不真的起浏览器。
globalThis.__testChildProcess = globalThis.__testChildProcess || { spawns: [] }

export function spawn(command, args) {
  globalThis.__testChildProcess.spawns.push({ command, args })
  return { on: () => {}, once: () => {}, unref: () => {} }
}

export default { spawn }
`

function stubPlugin(map) {
  return {
    name: 'chatgpt-auth-test-stubs',
    setup(buildContext) {
      for (const [specifier, path] of Object.entries(map)) {
        const filter = new RegExp('^' + specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$')
        buildContext.onResolve({ filter }, () => ({ path }))
      }
    },
  }
}

async function bundle(entry, outfile, plugins = []) {
  await build({
    stdin: { contents: entry, resolveDir: root, sourcefile: 'entry.ts', loader: 'ts' },
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'es2024',
    packages: 'external',
    plugins,
    logLevel: 'silent',
  })
  return import(pathToFileURL(outfile).href)
}

// ---------- 真实 loopback 辅助 ----------

async function freePort() {
  const server = createNetServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

/** 服务器关掉之后新连接应当被拒（端口真的释放了）。 */
async function assertRefused(port) {
  await sleep(10)
  await assert.rejects(
    new Promise((resolve, reject) => {
      const socket = netConnect(port, '127.0.0.1')
      socket.once('connect', () => { socket.destroy(); resolve() })
      socket.once('error', reject)
      setTimeout(() => { socket.destroy(); reject(new Error('connect 超时')) }, 2000)
    }),
    undefined,
    `127.0.0.1:${port} 仍在监听`,
  )
}

// ---------- 假 http 状态 ----------

function httpStub() {
  return globalThis.__testHttpStub
}

function resetHttpStub(entries = [], { deferListen = false } = {}) {
  const state = httpStub()
  state.failPorts = new Map(entries)
  state.attempts = []
  state.listening = []
  state.deferredListen = []
  state.deferListen = deferListen
  state.closed = 0
  globalThis.__testChildProcess.spawns = []
}

/** 让被 deferListen 挂起的 listen 结果生效（模拟真实 node 的 listening 事件）。 */
function flushStubListen() {
  for (const settle of httpStub().deferredListen.splice(0)) settle()
}

function stubServer(port) {
  const hit = httpStub().listening.find((entry) => entry.port === port)
  return hit && hit.server
}

/** 真正绑定成功的端口。 */
function listenedPorts() {
  return httpStub().listening.map((entry) => entry.port)
}

/** 尝试过绑定的端口（含失败的）：1455→1457 的换端口行为看这个。 */
function attemptedPorts() {
  return httpStub().attempts.map((entry) => entry.port)
}

function deferred() {
  let resolve = () => {}
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

/**
 * 可控时钟：临时替换 globalThis.setTimeout / clearTimeout / Date.now，让轮询里的 sleep
 * 由测试主动击发，不必真等 1s / 15 分钟。测试自身的等待走上面的 realSetTimeout。
 */
function installFakeClock(start = 1_700_000_000_000) {
  const realSet = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  const realDateNow = Date.now
  let now = start
  let nextId = 1
  const timers = new Map()
  Date.now = () => now
  globalThis.setTimeout = (fn, ms = 0) => {
    const id = nextId++
    timers.set(id, { fn, at: now + Math.max(0, ms) })
    return id
  }
  globalThis.clearTimeout = (id) => { timers.delete(id) }
  const ats = () => [...timers.values()].map((timer) => timer.at)
  return {
    pendingDelays: () => ats().map((at) => at - now).sort((a, b) => a - b),
    pendingCount: () => timers.size,
    /** 把时钟推进到最早的计时器并执行它。 */
    fireNext() {
      if (timers.size === 0) return
      now = Math.max(now, Math.min(...ats()))
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id)
          timer.fn()
        }
      }
    },
    restore() {
      Date.now = realDateNow
      globalThis.setTimeout = realSet
      globalThis.clearTimeout = realClear
      timers.clear()
    },
  }
}

function openedBrowsers() {
  return globalThis.__testChildProcess.spawns.map((entry) => entry.args[entry.args.length - 1])
}

/** 把一个假的回调请求交给假 http 服务器（等价于浏览器跳回 localhost）。 */
function deliverCallback(port, params, server = stubServer(port), path = '/auth/callback') {
  assert.ok(server, `没有监听 ${port} 的回调服务器`)
  const res = {
    statusCode: 0,
    body: '',
    writeHead(code) { this.statusCode = code },
    end(body) { this.body = body || '' },
  }
  server.emit('request', { url: `${path}?${new URLSearchParams(params).toString()}` }, res)
  return res
}

// ---------- 渠道 harness ----------

function createHarness(channelModule, { channelId = 'chatgpt', redirectPort = 1455 } = {}) {
  const state = {
    token: undefined,
    written: [],
    cleared: 0,
    afterLoginCalls: 0,
    logs: [],
    /** 凭据操作顺序（write-start/write/clear），用来断言回滚与写入的先后。 */
    events: [],
    /** 一次性写入闸门：设上后第一次 writeToken 会挂在这里，直到 gate.resolve()。 */
    gate: null,
  }
  /** 凭据写入串行（等价 TokenStore 的本地队列）：回滚一定排在后续写入之前。 */
  let credentialQueue = Promise.resolve()
  const serialize = (task) => {
    const run = credentialQueue.then(task, task)
    credentialQueue = run.then(() => undefined, () => undefined)
    return run
  }
  const ctx = {
    id: channelId,
    tokenRefName: `${channelId.toUpperCase()}_SUBSCRIPTION_TOKEN`,
    options: () => ({
      apiBaseURL: 'https://chatgpt.com/backend-api/codex/responses',
      redirectPort,
      models: [],
      defaultContextWindow: 400_000,
      maxTokens: 8192,
      clientVersion: '0.0.0-test',
    }),
    getConfig: () => ({}),
    updateConfig: async () => {},
    credentials: () => undefined,
    attachments: () => undefined,
    log: (message) => state.logs.push(message),
    notifyModelsChanged: () => {},
    readToken: async () => state.token,
    /** 读令牌，60 秒内过期先刷新（等价 TokenStore.fresh 的最小面）。 */
    freshToken: async (refresh) => {
      const token = state.token
      if (!token) return undefined
      if (token.expires - Date.now() >= 60_000) return token
      const refreshed = await refresh(token, new AbortController().signal)
      const merged = { ...refreshed, refresh: refreshed.refresh || token.refresh }
      state.token = merged
      state.written.push(merged)
      state.events.push(`write:${merged.access}`)
      return merged
    },
    /** 写入令牌：isCurrent 在落库前后各校验一次，取消时回滚自己刚写的那条。 */
    writeToken: (next, isCurrent = () => true) => serialize(async () => {
      if (!isCurrent()) return false
      const gate = state.gate
      state.gate = null
      state.events.push(`write-start:${next.access}`)
      if (gate !== null) await gate.promise
      state.token = next
      state.written.push(next)
      state.events.push(`write:${next.access}`)
      if (isCurrent()) return true
      if (state.token === next) {
        state.token = undefined
        state.cleared += 1
        state.events.push('clear')
      }
      return false
    }),
    clearToken: () => serialize(async () => {
      state.token = undefined
      state.cleared += 1
      state.events.push('clear')
    }),
    afterLogin: () => { state.afterLoginCalls += 1 },
  }
  return { state, ctx, runtime: channelModule[`${channelId}Channel`].create(ctx) }
}

// ---------- 1. 回调监听器（真实 loopback，测试专用临时端口） ----------

async function testListenerPrimitive(oauth) {
  {
    const port = await freePort()
    const listener = await oauth.startCallbackListener(port, 'st-1', undefined, 5000)
    assert.equal(listener.port, port)
    const res = await fetch(`http://127.0.0.1:${port}/auth/callback?code=cb-1&state=st-1`)
    assert.equal(res.status, 200)
    assert.equal(await listener.code, 'cb-1')
    await assertRefused(port)
  }
  console.log('✓ 1a. 回调监听器 listening 后才 resolve，拿到 code 后关服务器')

  {
    const port = await freePort()
    const listener = await oauth.startCallbackListener(port, 'st-2', undefined, 5000)
    assert.equal((await fetch(`http://127.0.0.1:${port}/other`)).status, 404)
    assert.equal((await fetch(`http://127.0.0.1:${port}/auth/callback`)).status, 400)
    assert.equal((await fetch(`http://127.0.0.1:${port}/auth/callback?code=x&state=nope`)).status, 400)
    await assert.rejects(listener.code, /state/)
    await assertRefused(port)

    const errorPort = await freePort()
    const errorListener = await oauth.startCallbackListener(errorPort, 'st-2', undefined, 5000)
    assert.equal((await fetch(`http://127.0.0.1:${errorPort}/auth/callback?error=access_denied`)).status, 400)
    await assert.rejects(errorListener.code, /oauth error: access_denied/)
    await assertRefused(errorPort)
  }
  console.log('✓ 1b. path / 缺 code / state 不匹配 / error 参数处理不变')

  {
    const port = await freePort()
    const listener = await oauth.startCallbackListener(port, 'st-3', undefined, 200)
    await assert.rejects(listener.code, /timed out|timeout/)
    await assertRefused(port)
  }
  console.log('✓ 1c. 超时 reject 并释放端口')

  {
    const port = await freePort()
    const controller = new AbortController()
    const listener = await oauth.startCallbackListener(port, 'st-4', controller.signal, 5000)
    controller.abort()
    await assert.rejects(listener.code, /aborted/)
    await assertRefused(port)

    const pre = new AbortController()
    pre.abort()
    await assert.rejects(oauth.startCallbackListener(await freePort(), 'st-4', pre.signal, 5000), /aborted/)
  }
  console.log('✓ 1d. 取消立即关服务器；已取消的信号直接 reject')

  {
    const taken = createNetServer()
    await new Promise((resolve) => taken.listen(0, '127.0.0.1', resolve))
    const port = taken.address().port
    let error
    try {
      await oauth.startCallbackListener(port, 'st-5', undefined, 1000)
    } catch (caught) {
      error = caught
    }
    await new Promise((resolve) => taken.close(resolve))
    assert.ok(error, '绑定占用的端口应当 reject')
    assert.equal(error.code, 'EADDRINUSE')
    assert.match(error.message, /启动失败/)
  }
  console.log('✓ 1e. 绑定失败时保留原始 err.code（EADDRINUSE）')

  {
    const port = await freePort()
    const pending = oauth.waitForCallback(port, 'st-6', undefined, 5000)
    assert.equal((await fetch(`http://127.0.0.1:${port}/auth/callback?code=wrapped&state=st-6`)).status, 200)
    assert.equal(await pending, 'wrapped')

    const timeoutPort = await freePort()
    const timingOut = oauth.waitForCallback(timeoutPort, 'st-6', undefined, 150)
    timingOut.catch(() => {})
    await assert.rejects(timingOut, /timed out|timeout/)
  }
  console.log('✓ 1f. waitForCallback 包装行为不变（Claude / 旧冒烟测试依赖它）')

  {
    const port = await freePort()
    await oauth.startCallbackListener(port, 'st-7', undefined, 150) // 故意不 await code
    await sleep(300)
    assert.equal(unhandled.length, 0, '未 await 的 code rejection 变成了 unhandledRejection')
  }
  console.log('✓ 1g. 未 await 的 code rejection 不冒成 unhandledRejection')

  {
    const { signal, cleanup } = oauth.boundedSignal(undefined, 40)
    assert.equal(signal.aborted, false)
    await waitFor(() => signal.aborted, { timeout: 1000 })
    cleanup()
    assert.equal(oauth.REQUEST_TIMEOUT_MS, 30_000)
  }
  console.log('✓ 1h. boundedSignal：单请求超时上限 30s，可组合取消')
}

// ---------- 2. 设备授权 wire（mock fetch） ----------

function installDeviceWire({
  polls = [],
  interval = 1,
  usercodeBody,
  usercodeStatus = 200,
  exchangeStatus = 200,
} = {}) {
  const calls = { usercode: [], poll: [], exchange: [] }
  globalThis.fetch = async (url, init = {}) => {
    const record = { url, method: init.method, body: init.body, signal: init.signal }
    if (url === 'https://auth.openai.com/api/accounts/deviceauth/usercode') {
      calls.usercode.push(record)
      if (usercodeBody !== undefined) return json(usercodeBody, usercodeStatus)
      return json({ device_auth_id: 'dev-1', user_code: 'ABCD-EFGH', interval })
    }
    if (url === 'https://auth.openai.com/api/accounts/deviceauth/token') {
      calls.poll.push(record)
      const next = polls.length > 0 ? polls.shift() : { status: 500 }
      return json(next.body ?? {}, next.status ?? 200)
    }
    if (url === 'https://auth.openai.com/oauth/token') {
      calls.exchange.push(record)
      if (exchangeStatus !== 200) return json({ error: 'invalid_grant' }, exchangeStatus)
      return json({ access_token: 'device-access', refresh_token: 'device-refresh', expires_in: 600 })
    }
    throw new Error('unexpected fetch: ' + url)
  }
  return calls
}

function deviceStart(overrides = {}) {
  return {
    deviceAuthId: 'dev-1',
    userCode: 'CODE',
    verificationUrl: 'https://auth.openai.com/codex/device',
    intervalSeconds: 1,
    expiresInSeconds: 900,
    ...overrides,
  }
}

async function testDeviceModule(device) {
  {
    const calls = installDeviceWire({ interval: '2.5' })
    const start = await device.requestDeviceAuthorization()
    assert.equal(calls.usercode[0].method, 'POST')
    assert.deepEqual(JSON.parse(calls.usercode[0].body), { client_id: 'app_EMoamEEZ73f0CkXaXp7hrann' })
    assert.equal(start.deviceAuthId, 'dev-1')
    assert.equal(start.userCode, 'ABCD-EFGH')
    assert.equal(start.intervalSeconds, 2.5, 'interval 字符串也要认')
    assert.equal(start.expiresInSeconds, 900, '官方 15 分钟过期')
    assert.equal(start.verificationUrl, 'https://auth.openai.com/codex/device')
  }
  console.log('✓ 2a. 设备码请求：URL / client_id / interval 字符串 / 15 分钟过期 / 验证页')

  {
    installDeviceWire({ usercodeBody: { device_auth_id: 'dev-2', usercode: 'CODE-2' } })
    assert.equal((await device.requestDeviceAuthorization()).userCode, 'CODE-2', 'usercode 别名也要认')

    installDeviceWire({ usercodeBody: { nope: true } })
    await assert.rejects(device.requestDeviceAuthorization(), /缺少 device_auth_id/)
    installDeviceWire({ usercodeBody: { nope: true }, usercodeStatus: 500 })
    await assert.rejects(device.requestDeviceAuthorization(), /HTTP 500/)
  }
  console.log('✓ 2b. usercode 别名 / 缺字段 / 非 2xx 都按预期处理')

  {
    const calls = installDeviceWire({ polls: [{ status: 403 }] })
    assert.deepEqual(await device.pollDeviceAuthorization('dev-1', 'CODE'), { status: 'pending' })
    assert.deepEqual(JSON.parse(calls.poll[0].body), { device_auth_id: 'dev-1', user_code: 'CODE' })
    globalThis.fetch = async () => json({}, 404)
    assert.deepEqual(await device.pollDeviceAuthorization('dev-1', 'CODE'), { status: 'pending' })
  }
  console.log('✓ 2c. 403 / 404 = pending，轮询请求体正确')

  {
    const calls = installDeviceWire({
      polls: [{ status: 200, body: { authorization_code: 'ac-1', code_verifier: 'cv-1', code_challenge: 'cc-1' } }],
    })
    assert.deepEqual(await device.pollDeviceAuthorization('dev-1', 'CODE-1'), {
      status: 'complete',
      value: { authorizationCode: 'ac-1', codeVerifier: 'cv-1', codeChallenge: 'cc-1' },
    })
    assert.equal(calls.poll.length, 1)

    installDeviceWire({ polls: [{ status: 200, body: { authorization_code: 'SECRET-CODE' } }] })
    const malformed = await device.pollDeviceAuthorization('dev-1', 'CODE')
    assert.equal(malformed.status, 'failed')
    assert.ok(!malformed.message.includes('SECRET-CODE'), '错误信息不得包含响应原文')

    installDeviceWire({ polls: [{ status: 500, body: { authorization_code: 'SECRET-CODE' } }] })
    assert.deepEqual(await device.pollDeviceAuthorization('dev-1', 'CODE'), {
      status: 'failed',
      message: '设备授权失败 (HTTP 500)',
    })
  }
  console.log('✓ 2d. 成功字段 / 非 2xx 失败 / 响应原文不进错误信息')

  {
    let form
    globalThis.fetch = async (url, init) => {
      assert.equal(url, 'https://auth.openai.com/oauth/token')
      form = new URLSearchParams(init.body)
      return json({ access_token: 'device-access', expires_in: 600 })
    }
    const token = await device.exchangeDeviceAuthorization({
      authorizationCode: 'ac-9',
      codeVerifier: 'cv-9',
      codeChallenge: 'cc-9',
    })
    assert.equal(form.get('grant_type'), 'authorization_code')
    assert.equal(form.get('code'), 'ac-9')
    assert.equal(form.get('code_verifier'), 'cv-9')
    assert.equal(form.get('client_id'), 'app_EMoamEEZ73f0CkXaXp7hrann')
    assert.equal(form.get('redirect_uri'), 'https://auth.openai.com/deviceauth/callback')
    assert.equal(token.access, 'device-access')
  }
  console.log('✓ 2e. 设备流换令牌：redirect_uri / grant_type / code_verifier 正确')

  {
    let inFlight = 0
    let maxInFlight = 0
    let polls = 0
    globalThis.fetch = async (url) => {
      assert.equal(url, 'https://auth.openai.com/api/accounts/deviceauth/token')
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      polls += 1
      await sleep(20)
      inFlight -= 1
      return polls < 2 ? json({}, 403) : json({ authorization_code: 'ac', code_verifier: 'cv' })
    }
    const done = await device.waitForDeviceAuthorization(deviceStart())
    assert.equal(polls, 2)
    assert.equal(maxInFlight, 1, '轮询不得重叠')
    assert.equal(done.authorizationCode, 'ac')
  }
  console.log('✓ 2f. 复用 pollDeviceFlow：间隔下限 1s、轮询不重叠')

  {
    const controller = new AbortController()
    let sawSignal
    globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
      sawSignal = init.signal
      init.signal.addEventListener('abort', () => reject(new Error('request aborted')), { once: true })
    })
    const pending = device.requestDeviceAuthorization(controller.signal)
    await waitFor(() => sawSignal !== undefined)
    assert.equal(sawSignal.aborted, false)
    controller.abort()
    await assert.rejects(pending)
    assert.equal(sawSignal.aborted, true)
  }
  console.log('✓ 2g. 每个请求都带 AbortSignal —— 取消立即中止在途设备请求')
}

// ---------- 3. 回调端口选择 ----------

async function testCallbackPorts(channel) {
  assert.deepEqual(channel.callbackPortCandidates(1455), [1455, 1457])
  assert.deepEqual(channel.callbackPortCandidates(1457), [1457, 1455])
  assert.deepEqual(channel.callbackPortCandidates(0), [1455, 1457])
  assert.deepEqual(channel.callbackPortCandidates(18655), [1455, 1457])

  {
    resetHttpStub([])
    const { runtime, state } = createHarness(channel)
    globalThis.fetch = neverExpected('回调流登录')
    const result = await runtime.login()
    assert.equal(result.status, 'pending')
    const url = new URL(result.url)
    assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:1455/auth/callback')
    assert.deepEqual(attemptedPorts(), [1455], '1455 可用就不试 1457')
    assert.deepEqual(listenedPorts(), [1455])
    assert.deepEqual(openedBrowsers(), [result.url], '绑定成功后才打开浏览器')
    const pendingStatus = await runtime.authStatus()
    assert.equal(pendingStatus.status, 'pending')
    assert.equal(pendingStatus.url, result.url)

    // 授权 URL 里的 state 是生产代码生成的 PKCE verifier
    globalThis.fetch = async (fetchUrl, init) => {
      assert.equal(fetchUrl, 'https://auth.openai.com/oauth/token')
      const form = new URLSearchParams(init.body)
      assert.equal(form.get('redirect_uri'), 'http://localhost:1455/auth/callback')
      assert.equal(form.get('code'), 'cb-chatgpt')
      return json({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 600 })
    }
    const res = deliverCallback(1455, { code: 'cb-chatgpt', state: url.searchParams.get('state') })
    assert.equal(res.statusCode, 200)
    await waitFor(() => state.written.length === 1)
    assert.equal(state.written[0].access, 'access-1')
    assert.equal(state.afterLoginCalls, 1)
    assert.equal(openedBrowsers().length, 1, '验证页只打开一次')
    assert.equal(httpStub().closed, 1, '拿到 code 后回调服务器应当关闭')
  }
  console.log('✓ 3a. 1455 可用：授权 URL / 换令牌 / 写凭据 / afterLogin 全链路正确')

  {
    resetHttpStub([[1455, 'EADDRINUSE']])
    const { runtime } = createHarness(channel)
    globalThis.fetch = neverExpected('换端口')
    const result = await runtime.login()
    assert.equal(new URL(result.url).searchParams.get('redirect_uri'), 'http://localhost:1457/auth/callback')
    assert.deepEqual(attemptedPorts(), [1455, 1457], '先试 1455，被占才试 1457')
    assert.deepEqual(listenedPorts(), [1457])
    assert.deepEqual(openedBrowsers(), [result.url])
    assert.equal(stubServer(1455), undefined)
    runtime.cancelLogin()
    assert.equal((await runtime.authStatus()).status, 'not-logged-in')
  }
  console.log('✓ 3b. 1455 被占 → 换 1457，且只打开 1457 的授权页')

  {
    resetHttpStub([[1455, 'EACCES']])
    const { runtime } = createHarness(channel)
    globalThis.fetch = neverExpected('EACCES')
    const result = await runtime.login()
    assert.equal(new URL(result.url).searchParams.get('redirect_uri'), 'http://localhost:1457/auth/callback')
    assert.deepEqual(attemptedPorts(), [1455, 1457])
    runtime.cancelLogin()
  }
  console.log('✓ 3c. EACCES 也换下一个注册端口')

  {
    resetHttpStub([[1455, 'EHOSTDOWN']])
    const { runtime } = createHarness(channel)
    globalThis.fetch = neverExpected('非端口错误')
    await assert.rejects(runtime.login(), /启动失败/)
    assert.deepEqual(attemptedPorts(), [1455], '非端口错误不得换端口 / 不得走设备流')
    assert.deepEqual(listenedPorts(), [])
    assert.deepEqual(openedBrowsers(), [], '绑定失败不得打开浏览器')
    const status = await runtime.authStatus()
    assert.equal(status.status, 'not-logged-in')
    assert.ok(status.error !== undefined, '失败原因要进 authStatus.error')
    assert.match(status.error, /启动失败/)
  }
  console.log('✓ 3d. 非端口错误不静默降级，错误进 authStatus.error')

  {
    resetHttpStub([])
    const { runtime } = createHarness(channel, { redirectPort: 1457 })
    globalThis.fetch = neverExpected('配置端口优先')
    const result = await runtime.login()
    assert.deepEqual(attemptedPorts(), [1457], '配置成 1457 时优先试 1457')
    assert.equal(new URL(result.url).searchParams.get('redirect_uri'), 'http://localhost:1457/auth/callback')
    runtime.cancelLogin()
  }
  console.log('✓ 3e. 配置端口只在 1455/1457 之内生效（无任意端口兜底）')
}

// ---------- 3f. readiness 必须在 abort / 超时时也 settle ----------

async function testReadinessSettlement(module_) {
  {
    // listening 之前 abort：readiness 必须 reject；迟到的 listening 不能算成功
    resetHttpStub([], { deferListen: true })
    const controller = new AbortController()
    const outcome = module_
      .startCallbackListener(1455, 'st', controller.signal, 5000)
      .then(() => 'resolved', (error) => 'rejected:' + error.message)
    controller.abort()
    assert.equal(await outcome, 'rejected:aborted')
    flushStubListen()
    assert.deepEqual(listenedPorts(), [], 'close 之后迟到的 listening 不算绑定成功')
    assert.equal(httpStub().closed, 1)
  }
  console.log('✓ 3f. listening 之前 abort：readiness reject，迟到的 listening 不算成功')

  {
    // listening 之前超时：readiness 必须 reject（以前会一直悬着）
    resetHttpStub([], { deferListen: true })
    await assert.rejects(module_.startCallbackListener(1456, 'st', undefined, 60), /timed out|timeout/)
    flushStubListen()
    assert.deepEqual(listenedPorts(), [])
    assert.equal(httpStub().closed, 1)
  }
  console.log('✓ 3g. listening 之前超时：readiness reject')

  {
    // 绑定失败：readiness reject 且保留原始 code
    resetHttpStub([[1455, 'EACCES']])
    let error
    try {
      await module_.startCallbackListener(1455, 'st', undefined, 1000)
    } catch (caught) {
      error = caught
    }
    assert.ok(error, '绑定失败必须 reject')
    assert.equal(error.code, 'EACCES')
  }
  console.log('✓ 3h. 绑定失败：readiness reject 并保留 err.code')
}

// ---------- 3i. 取消发生在「已绑定、还没建 pending」的窗口 ----------

async function testCancelWhileBinding(module_) {
  resetHttpStub([], { deferListen: true })
  const { runtime, state } = createHarness(module_)
  globalThis.fetch = neverExpected('绑定等待期间的取消')
  const outcome = runtime.login().then(() => 'resolved', (error) => 'rejected:' + error.message)
  await sleep(0)            // 让 stub 的 listen 微任务把 listening 挂起
  flushStubListen()         // 绑定成功；login 的 await 继续排在微任务队列里
  runtime.cancelLogin()     // 抢在 login 继续执行之前取消
  assert.equal(await outcome, 'rejected:aborted')
  assert.deepEqual(attemptedPorts(), [1455])
  assert.deepEqual(listenedPorts(), [], '刚拿到的监听器必须关掉（不漏 socket）')
  assert.deepEqual(openedBrowsers(), [], '被取消的尝试不得打开浏览器')
  assert.equal(httpStub().closed, 1)
  const status = await runtime.authStatus()
  assert.equal(status.status, 'not-logged-in')
  assert.equal(status.error, undefined, '取消不算失败')
  assert.equal(state.afterLoginCalls, 0)
  console.log('✓ 3i. 绑定等待期间取消：关掉刚拿到的监听器、reject aborted、不碰状态')
}

// ---------- 4. 设备流回退链路 ----------

async function testDeviceFallback(channel) {
  const bothBusy = [[1455, 'EADDRINUSE'], [1457, 'EADDRINUSE']]

  {
    resetHttpStub(bothBusy)
    const calls = installDeviceWire({
      polls: [{ status: 403 }, { status: 200, body: { authorization_code: 'ac-dev', code_verifier: 'cv-dev' } }],
    })
    const { runtime, state } = createHarness(channel)
    const result = await runtime.login()
    assert.equal(result.status, 'pending')
    assert.equal(result.url, 'https://auth.openai.com/codex/device')
    assert.equal(result.userCode, 'ABCD-EFGH')
    assert.deepEqual(attemptedPorts(), [1455, 1457], '两个注册端口都试过')
    assert.deepEqual(listenedPorts(), [], '两个端口都没绑上')
    assert.deepEqual(openedBrowsers(), ['https://auth.openai.com/codex/device'], '验证页只打开一次')
    const pendingStatus = await runtime.authStatus()
    assert.equal(pendingStatus.status, 'pending')
    assert.equal(pendingStatus.userCode, 'ABCD-EFGH', 'pending 期间 authStatus 要带设备码')

    await waitFor(() => state.written.length === 1)
    assert.equal(calls.exchange.length, 1)
    assert.equal(
      new URLSearchParams(calls.exchange[0].body).get('redirect_uri'),
      'https://auth.openai.com/deviceauth/callback',
    )
    assert.equal(state.written[0].access, 'device-access')
    assert.equal(state.afterLoginCalls, 1)
    assert.equal((await runtime.authStatus()).status, 'logged-in')
  }
  console.log('✓ 4a. 两个端口都不可用 → 设备流 → 换令牌 → 写凭据 → afterLogin')

  {
    resetHttpStub(bothBusy)
    globalThis.fetch = async () => { throw new Error('network down') }
    const { runtime, state } = createHarness(channel)
    await assert.rejects(runtime.login(), /network down/)
    const status = await runtime.authStatus()
    assert.equal(status.status, 'not-logged-in')
    assert.match(status.error, /network down/)
    assert.equal(state.written.length, 0)
  }
  console.log('✓ 4b. 设备码请求失败：抛给 UI 且进 authStatus.error')

  {
    resetHttpStub(bothBusy)
    installDeviceWire({ polls: [{ status: 500 }] })
    const { runtime, state } = createHarness(channel)
    await runtime.login()
    await waitFor(async () => (await runtime.authStatus()).status !== 'pending')
    assert.match((await runtime.authStatus()).error, /设备授权失败 \(HTTP 500\)/)
    assert.equal(state.written.length, 0)
    assert.equal(state.afterLoginCalls, 0)
  }
  console.log('✓ 4c. 异步轮询失败 → authStatus.error（不写凭据、不 afterLogin）')

  {
    resetHttpStub(bothBusy)
    installDeviceWire({
      polls: [{ status: 200, body: { authorization_code: 'ac', code_verifier: 'cv' } }],
      exchangeStatus: 400,
    })
    const { runtime, state } = createHarness(channel)
    await runtime.login()
    await waitFor(async () => (await runtime.authStatus()).status !== 'pending')
    assert.match((await runtime.authStatus()).error, /token exchange failed \(HTTP 400\)/)
    assert.equal(state.written.length, 0)
  }
  console.log('✓ 4d. 换令牌失败 → authStatus.error，不写凭据')

  {
    resetHttpStub(bothBusy)
    installDeviceWire({ polls: [{ status: 500 }] })
    const { runtime, state } = createHarness(channel)
    await runtime.login()
    await waitFor(async () => (await runtime.authStatus()).status !== 'pending')
    await runtime.logout()
    const status = await runtime.authStatus()
    assert.equal(status.status, 'not-logged-in')
    assert.equal(status.error, undefined, '注销要清掉上次的失败信息')
    assert.equal(state.cleared, 1)
  }
  console.log('✓ 4e. 注销清空 authStatus.error 与 pending')
}

// ---------- 5. 取消与尝试隔离 ----------

async function testCancellationAndIsolation(channel) {
  const bothBusy = [[1455, 'EADDRINUSE'], [1457, 'EADDRINUSE']]

  {
    resetHttpStub(bothBusy)
    let releasePoll
    const exchanges = []
    globalThis.fetch = async (url, init) => {
      if (url.endsWith('/deviceauth/usercode')) {
        return json({ device_auth_id: 'dev-1', usercode: 'CODE-1', interval: 1 })
      }
      if (url.endsWith('/deviceauth/token')) {
        return await new Promise((resolve) => {
          releasePoll = () => resolve(json({ authorization_code: 'ac', code_verifier: 'cv' }))
        })
      }
      if (url.endsWith('/oauth/token')) {
        exchanges.push({ aborted: Boolean(init.signal?.aborted) })
        return json({ access_token: 'late-access', expires_in: 600 })
      }
      throw new Error('unexpected ' + url)
    }
    const { runtime, state } = createHarness(channel)
    const result = await runtime.login()
    assert.equal(result.userCode, 'CODE-1')
    await waitFor(() => typeof releasePoll === 'function')
    runtime.cancelLogin()
    releasePoll()
    await sleep(80)
    assert.deepEqual(exchanges, [], '取消之后不得再换令牌')
    assert.equal(state.written.length, 0, '取消后不得写凭据')
    assert.equal(state.afterLoginCalls, 0)
    assert.equal(state.cleared, 0, '取消不需要动已有令牌（注销才清）')
    assert.equal((await runtime.authStatus()).status, 'not-logged-in')
    assert.equal((await runtime.authStatus()).error, undefined, '取消不是失败')
  }
  console.log('✓ 5a. 取消在途设备登录：不换令牌、不写凭据、不 afterLogin、error 不置位')

  {
    resetHttpStub(bothBusy)
    let releaseOld
    const exchanges = []
    globalThis.fetch = async (url, init) => {
      if (url.endsWith('/deviceauth/usercode')) {
        return json({ device_auth_id: 'dev-old', user_code: 'CODE-OLD', interval: 1 })
      }
      if (url.endsWith('/deviceauth/token')) {
        return await new Promise((resolve) => {
          releaseOld = () => resolve(json({ authorization_code: 'ac-old', code_verifier: 'cv-old' }))
        })
      }
      if (url.endsWith('/oauth/token')) {
        exchanges.push({ aborted: Boolean(init.signal?.aborted) })
        return json({ access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 600 })
      }
      throw new Error('unexpected ' + url)
    }
    const { runtime, state } = createHarness(channel)
    const first = await runtime.login()
    assert.equal(first.userCode, 'CODE-OLD')
    await waitFor(() => typeof releaseOld === 'function')

    // 新尝试：1455 现在可用 → 走浏览器流；旧尝试在 login() 开头被 cancelLogin 中止
    resetHttpStub([])
    const second = await runtime.login()
    const secondUrl = new URL(second.url)
    assert.equal(secondUrl.searchParams.get('redirect_uri'), 'http://localhost:1455/auth/callback')
    assert.equal((await runtime.authStatus()).url, second.url, '新尝试的 pending 就位')

    // 旧尝试迟到的成功结果：既不换令牌，也不清掉新尝试的 pending
    releaseOld()
    await sleep(80)
    assert.deepEqual(exchanges, [], '被取消的旧尝试不得换令牌')
    assert.equal(state.written.length, 0)
    assert.equal(state.afterLoginCalls, 0)
    const during = await runtime.authStatus()
    assert.equal(during.status, 'pending')
    assert.equal(during.url, second.url, '旧尝试不得清掉新尝试的 pending')

    // 新尝试正常完成
    globalThis.fetch = async (url, init) => {
      assert.equal(url, 'https://auth.openai.com/oauth/token')
      assert.equal(new URLSearchParams(init.body).get('redirect_uri'), 'http://localhost:1455/auth/callback')
      exchanges.push({ aborted: Boolean(init.signal?.aborted) })
      return json({ access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 600 })
    }
    deliverCallback(1455, { code: 'cb-new', state: secondUrl.searchParams.get('state') })
    await waitFor(() => state.written.length === 1)
    assert.equal(state.written[0].access, 'access-new')
    assert.equal(state.afterLoginCalls, 1, '只有当前成功尝试触发 afterLogin')
    assert.equal(exchanges.length, 1)
    assert.equal(exchanges[0].aborted, false)
    assert.equal((await runtime.authStatus()).status, 'logged-in')
  }
  console.log('✓ 5b. 旧尝试迟到结果不影响新尝试（pending / 凭据 / afterLogin）')

  {
    resetHttpStub([])
    const harness = createHarness(channel)
    harness.state.token = { refresh: 'r', access: 'a', expires: Date.now() + 10 * 60 * 1000 }
    globalThis.fetch = neverExpected('已有令牌')
    assert.deepEqual(await harness.runtime.login(), { status: 'logged-in', account: undefined })
    assert.deepEqual(attemptedPorts(), [], '已登录时不起回调服务器')
  }
  console.log('✓ 5c. 已有有效令牌：直接 logged-in，不起服务器、不发请求')

  {
    // 设备码请求在途时取消：不设 pending、不开验证页、error 不置位
    resetHttpStub(bothBusy)
    let releaseUsercode
    globalThis.fetch = async (url) => {
      if (url.endsWith('/deviceauth/usercode')) {
        return await new Promise((resolve) => {
          releaseUsercode = () => resolve(json({ device_auth_id: 'dev-1', user_code: 'CODE-1', interval: 1 }))
        })
      }
      throw new Error('unexpected ' + url)
    }
    const { runtime, state } = createHarness(channel)
    const stale = runtime.login().then(() => 'resolved', (error) => 'rejected:' + error.message)
    await waitFor(() => typeof releaseUsercode === 'function')
    runtime.cancelLogin()
    releaseUsercode()
    assert.equal(await stale, 'rejected:aborted')
    assert.deepEqual(openedBrowsers(), [], '取消后不得打开验证页')
    const status = await runtime.authStatus()
    assert.equal(status.status, 'not-logged-in')
    assert.equal(status.error, undefined, '取消不算失败')
    assert.equal(state.afterLoginCalls, 0)
  }
  console.log('✓ 5d. 设备码请求在途时取消：不设 pending、不开验证页、error 不置位')

  {
    // 设备码请求在途时重试：旧尝试的结果不得影响新尝试
    resetHttpStub(bothBusy)
    let releaseUsercode
    globalThis.fetch = async (url) => {
      if (url.endsWith('/deviceauth/usercode')) {
        return await new Promise((resolve) => {
          releaseUsercode = () => resolve(json({ device_auth_id: 'dev-old', user_code: 'CODE-OLD', interval: 1 }))
        })
      }
      throw new Error('unexpected ' + url)
    }
    const { runtime, state } = createHarness(channel)
    const stale = runtime.login().then(() => 'resolved', (error) => 'rejected:' + error.message)
    await waitFor(() => typeof releaseUsercode === 'function')

    resetHttpStub([])
    const fresh = await runtime.login()
    assert.equal(new URL(fresh.url).searchParams.get('redirect_uri'), 'http://localhost:1455/auth/callback')
    assert.deepEqual(openedBrowsers(), [fresh.url], '只有当前尝试打开浏览器')

    releaseUsercode()
    assert.equal(await stale, 'rejected:aborted')
    const status = await runtime.authStatus()
    assert.equal(status.status, 'pending')
    assert.equal(status.url, fresh.url, '旧尝试不得覆盖新尝试的 pending')
    assert.deepEqual(openedBrowsers(), [fresh.url], '旧尝试不得再打开浏览器')
    assert.equal(state.afterLoginCalls, 0)
    runtime.cancelLogin()
  }
  console.log('✓ 5e. 设备码请求在途时重试：旧尝试 reject aborted，不覆盖新尝试')

  {
    // 被取消的尝试的写入已经在途 → 先回滚它，再写新尝试的令牌
    resetHttpStub([])
    const { runtime, state } = createHarness(channel)
    const gate = deferred()
    state.gate = gate
    const accessFor = { 'cb-old': 'access-old', 'cb-new': 'access-new' }
    globalThis.fetch = async (url, init) => {
      assert.equal(url, 'https://auth.openai.com/oauth/token')
      const code = new URLSearchParams(init.body).get('code')
      return json({ access_token: accessFor[code], refresh_token: 'refresh-' + code, expires_in: 600 })
    }

    const first = await runtime.login()
    const firstUrl = new URL(first.url)
    deliverCallback(1455, { code: 'cb-old', state: firstUrl.searchParams.get('state') })
    await waitFor(() => state.events.includes('write-start:access-old'))

    // 新尝试：取消旧尝试（旧尝试的写入还挂在 gate 上）
    const second = await runtime.login()
    const secondUrl = new URL(second.url)
    assert.equal(secondUrl.searchParams.get('redirect_uri'), 'http://localhost:1455/auth/callback')
    assert.notEqual(secondUrl.searchParams.get('state'), firstUrl.searchParams.get('state'))

    gate.resolve()
    await waitFor(() => state.events.includes('clear'))
    assert.deepEqual(state.events, ['write-start:access-old', 'write:access-old', 'clear'], '旧写入必须先回滚')
    assert.equal(state.token, undefined)
    assert.equal(state.afterLoginCalls, 0, '被取消的尝试不触发 afterLogin')

    deliverCallback(1455, { code: 'cb-new', state: secondUrl.searchParams.get('state') })
    await waitFor(() => state.written.length === 2)
    assert.equal(state.token.access, 'access-new')
    assert.deepEqual(state.events, [
      'write-start:access-old',
      'write:access-old',
      'clear',
      'write-start:access-new',
      'write:access-new',
    ], '回滚排在新尝试写入之前，新令牌没有被清掉')
    assert.equal(state.afterLoginCalls, 1)
    assert.equal((await runtime.authStatus()).status, 'logged-in')
  }
  console.log('✓ 5f. 被取消的在途写入先回滚、再写新尝试令牌（互不覆盖）')

  {
    // 写凭据抛错：错误进 authStatus.error，不写不 afterLogin（记录事务是原子的，无半截状态）
    resetHttpStub([])
    const harness = createHarness(channel)
    harness.ctx.writeToken = async () => { throw new Error('credential write failed') }
    globalThis.fetch = async () => json({ access_token: 'access-x', refresh_token: 'refresh-x', expires_in: 600 })
    const result = await harness.runtime.login()
    deliverCallback(1455, { code: 'cb-fail', state: new URL(result.url).searchParams.get('state') })
    await waitFor(async () => (await harness.runtime.authStatus()).status !== 'pending')
    const status = await harness.runtime.authStatus()
    assert.match(status.error, /credential write failed/)
    assert.equal(harness.state.written.length, 0)
    assert.equal(harness.state.cleared, 0, '原子写入失败不留半截状态，不需要清理')
    assert.equal(harness.state.afterLoginCalls, 0)
  }
  console.log('✓ 5g. 写入凭据失败：authStatus.error 可见，不写不 afterLogin')
}

// ---------- 6. 设备轮询边界（可控时钟，不真等 15 分钟） ----------

async function testDevicePollBoundaries(device) {
  {
    // expiresInSeconds = 0：deadline 已过 → 一次轮询都不发、不留计时器
    const calls = installDeviceWire({})
    await assert.rejects(
      device.waitForDeviceAuthorization(deviceStart({ expiresInSeconds: 0 })),
      /设备授权超时/,
    )
    assert.equal(calls.poll.length, 0, '过期时间已到就不该发轮询请求')
  }
  console.log('✓ 6a. expiresInSeconds=0：不轮询，直接到时超时')

  {
    // slow_down：间隔 1s → 6s → 11s（每次 +5s），完成后不再轮询
    const clock = installFakeClock()
    try {
      const statuses = ['slow_down', 'slow_down', 'complete']
      let polls = 0
      const promise = device.pollDeviceFlow({
        intervalSeconds: 1,
        expiresInSeconds: 3600,
        poll: () => {
          polls += 1
          const status = statuses.shift() ?? 'complete'
          return status === 'complete' ? { status, value: 'done' } : { status }
        },
      })
      await waitFor(() => clock.pendingDelays().length === 1)
      assert.deepEqual(clock.pendingDelays(), [6000], '第一次 slow_down 后 1s → 6s')
      clock.fireNext()
      await waitFor(() => clock.pendingDelays().length === 1)
      assert.deepEqual(clock.pendingDelays(), [11000], '第二次 slow_down 后 6s → 11s')
      clock.fireNext()
      assert.equal(await promise, 'done')
      assert.equal(polls, 3)
      assert.equal(clock.pendingCount(), 0, '完成后不留计时器')
    } finally {
      clock.restore()
    }
  }
  console.log('✓ 6b. pollDeviceFlow slow_down：间隔逐次 +5s（1s→6s→11s）')

  {
    // 最后一跳被裁到 deadline：1.5s 窗口 + 1s 间隔 → sleep 1s、再 0.5s，然后到时
    const clock = installFakeClock()
    try {
      let polls = 0
      globalThis.fetch = async () => {
        polls += 1
        return json({}, 403)
      }
      const promise = device.waitForDeviceAuthorization(deviceStart({ intervalSeconds: 1, expiresInSeconds: 1.5 }))
      await waitFor(() => clock.pendingDelays().length === 1)
      assert.deepEqual(clock.pendingDelays(), [1000])
      clock.fireNext()
      await waitFor(() => clock.pendingDelays().length === 1)
      assert.deepEqual(clock.pendingDelays(), [500], '最后一跳裁到剩余时间')
      clock.fireNext()
      await assert.rejects(promise, /设备授权超时/)
      assert.equal(polls, 2, '到期后不得再轮询')
      assert.equal(clock.pendingCount(), 0, '不留活计时器')
    } finally {
      clock.restore()
    }
  }
  console.log('✓ 6c. 窗口到期：最后一跳裁到剩余时间，之后不再发请求')

  {
    // 睡在轮询间隔里被取消：不再轮询，且 sleep 的计时器被清掉
    const clock = installFakeClock()
    try {
      const controller = new AbortController()
      let polls = 0
      globalThis.fetch = async () => {
        polls += 1
        return json({}, 403)
      }
      const promise = device.waitForDeviceAuthorization(
        deviceStart({ intervalSeconds: 1, expiresInSeconds: 900 }),
        controller.signal,
      )
      await waitFor(() => clock.pendingDelays().length === 1)
      controller.abort()
      await assert.rejects(promise, /aborted/)
      assert.equal(polls, 1, '取消后不得再轮询')
      assert.equal(clock.pendingCount(), 0, 'sleep 的计时器要被清掉')
    } finally {
      clock.restore()
    }
  }
  console.log('✓ 6d. 间隔中取消：不再轮询，sleep 计时器被清掉')

  {
    // 终止性失败（非 pending）不重试
    const calls = installDeviceWire({ polls: [{ status: 500 }] })
    await assert.rejects(device.waitForDeviceAuthorization(deviceStart()), /设备授权失败 \(HTTP 500\)/)
    assert.equal(calls.poll.length, 1, 'failed 之后不得重试')
  }
  console.log('✓ 6e. 设备授权失败不重试')

  {
    // interval 非法值一律退回默认 5s（合法值保留）
    for (const [label, interval] of [
      ['非数字字符串', 'abc'],
      ['零', 0],
      ['负数', -3],
      ['Infinity', Infinity],
      ['NaN', NaN],
      ['null', null],
      ['缺字段', undefined],
    ]) {
      installDeviceWire({
        usercodeBody: { device_auth_id: 'dev-1', user_code: 'CODE-1', ...(interval === undefined ? {} : { interval }) },
      })
      const start = await device.requestDeviceAuthorization()
      assert.equal(start.intervalSeconds, 5, `${label} 应退回默认 5s`)
    }
    installDeviceWire({ usercodeBody: { device_auth_id: 'dev-1', user_code: 'CODE-1', interval: 7 } })
    assert.equal((await device.requestDeviceAuthorization()).intervalSeconds, 7)
  }
  console.log('✓ 6f. interval 非法值（非数字/0/负/Infinity/NaN/null/缺失）退回 5s')

  {
    // 畸形 JSON 要拒绝；结构错误不回显响应原文。解析错误的原文泄漏由独立 TODO 回归记录。
    const secret = 'SECRET-CODE-XYZ'
    globalThis.fetch = async () => new Response('{ "device_auth_id": "dev-1", ', { status: 200 })
    await assert.rejects(device.requestDeviceAuthorization(), '畸形 JSON 应当 reject')

    for (const [label, body] of [
      ['null', 'null'],
      ['数组', '[]'],
      ['字符串', JSON.stringify(secret)],
      ['空字段带密值', JSON.stringify({ device_auth_id: '', user_code: '', secret })],
    ]) {
      globalThis.fetch = async () => new Response(body, { status: 200 })
      let error
      try {
        await device.requestDeviceAuthorization()
      } catch (caught) {
        error = caught
      }
      assert.ok(error, `${label}：应当 reject`)
      assert.ok(!String(error.message).includes(secret), `${label}：不得回显响应原文（${error.message}）`)
    }

    globalThis.fetch = async () => new Response(JSON.stringify({ authorization_code: '', secret }), { status: 200 })
    const failed = await device.pollDeviceAuthorization('dev-1', 'CODE')
    assert.equal(failed.status, 'failed')
    assert.ok(!failed.message.includes(secret), '轮询失败信息不得回显响应原文')
  }
  console.log('✓ 6g. 畸形 JSON 拒绝，结构错误不回显响应原文')
}

// ---------- 7. 两个本地实例互不干扰 + 回调重复到达 ----------

async function testInstanceIsolationAndCallbackReplay(channel) {
  {
    // 两个渠道实例（两个本地 dsh 实例）：设备码与 controller 各自独立，
    // 取消 A 不影响 B 完成，A 迟到的授权响应也不写 A 的凭据
    resetHttpStub([[1455, 'EADDRINUSE'], [1457, 'EADDRINUSE']])
    let usercodes = 0
    let releaseA
    const exchanges = []
    globalThis.fetch = async (url, init) => {
      if (url.endsWith('/usercode')) {
        usercodes += 1
        return json({ device_auth_id: `dev-${usercodes}`, user_code: `CODE-${usercodes}`, interval: 1 })
      }
      if (url.endsWith('/deviceauth/token')) {
        const body = JSON.parse(init.body)
        if (body.device_auth_id === 'dev-1') {
          return await new Promise((resolve) => {
            releaseA = () => resolve(json({ authorization_code: 'ac-A', code_verifier: 'cv-A' }))
          })
        }
        return json({ authorization_code: 'ac-B', code_verifier: 'cv-B' })
      }
      if (url.endsWith('/oauth/token')) {
        const code = new URLSearchParams(init.body).get('code')
        exchanges.push(code)
        return json({ access_token: 'access-' + code, refresh_token: 'r', expires_in: 600 })
      }
      throw new Error('unexpected ' + url)
    }
    const a = createHarness(channel)
    const b = createHarness(channel)
    const loginA = await a.runtime.login()
    const loginB = await b.runtime.login()
    assert.equal(loginA.userCode, 'CODE-1')
    assert.equal(loginB.userCode, 'CODE-2', '两个实例拿到的设备码必须各自独立')

    a.runtime.cancelLogin()
    await waitFor(() => b.state.written.length === 1)
    assert.deepEqual(exchanges, ['ac-B'], '取消 A 后只有 B 换令牌')
    assert.equal(b.state.written[0].access, 'access-ac-B')
    assert.equal(b.state.afterLoginCalls, 1)
    assert.equal((await b.runtime.authStatus()).status, 'logged-in')
    assert.equal(a.state.written.length, 0)
    assert.equal(a.state.afterLoginCalls, 0)
    assert.equal((await a.runtime.authStatus()).status, 'not-logged-in')

    releaseA()
    await sleep(20)
    assert.equal(a.state.written.length, 0, 'A 被取消后不得写凭据')
    assert.deepEqual(exchanges, ['ac-B'], 'A 被取消后不得换令牌')
    assert.equal((await a.runtime.authStatus()).status, 'not-logged-in')
  }
  console.log('✓ 7a. 两个实例：设备码/controller/凭据独立，取消 A 不影响 B 完成')

  {
    // 重复到达的同一个成功回调：只换码 / 写一次 / afterLogin 一次 / 只开一次页面，端口释放
    resetHttpStub([])
    const { runtime, state } = createHarness(channel)
    let exchanges = 0
    globalThis.fetch = async (url) => {
      assert.equal(url, 'https://auth.openai.com/oauth/token')
      exchanges += 1
      return json({ access_token: 'access-once', refresh_token: 'r', expires_in: 600 })
    }
    const result = await runtime.login()
    const server = stubServer(1455)
    const params = { code: 'cb-once', state: new URL(result.url).searchParams.get('state') }
    const first = deliverCallback(1455, params, server)
    const replay = deliverCallback(1455, params, server) // 浏览器重放 / 用户刷新回调页
    assert.equal(first.statusCode, 200)
    assert.equal(replay.statusCode, 200, '重复请求仍回成功页，但不得产生副作用')
    await waitFor(() => state.written.length === 1)
    await sleep(20)
    assert.equal(exchanges, 1, '重复回调只能换一次令牌')
    assert.equal(state.written.length, 1)
    assert.equal(state.afterLoginCalls, 1)
    assert.deepEqual(openedBrowsers(), [result.url], '不得因为重复回调再打开页面')
    assert.deepEqual(listenedPorts(), [], '拿到 code 后端口要释放')
    assert.equal(httpStub().closed, 1)
  }
  console.log('✓ 7b. 重复成功回调：换码/写入/afterLogin 各一次，端口释放')

  {
    // state 不匹配的回调：不写令牌 / 不开页面 / 进 authStatus.error / 端口释放
    resetHttpStub([])
    const { runtime, state } = createHarness(channel)
    globalThis.fetch = neverExpected('state 不匹配的回调')
    const result = await runtime.login()
    const res = deliverCallback(1455, { code: 'cb-bad', state: 'wrong-state' })
    assert.equal(res.statusCode, 400)
    await waitFor(async () => (await runtime.authStatus()).status !== 'pending')
    assert.equal(state.written.length, 0, 'state 不匹配不得写令牌')
    assert.deepEqual(openedBrowsers(), [result.url], '不得再打开页面')
    assert.match((await runtime.authStatus()).error, /state/)
    assert.deepEqual(listenedPorts(), [], '失败后端口也要释放')
    assert.equal(httpStub().closed, 1)
  }
  console.log('✓ 7c. state 不匹配的回调：不写令牌 / 不开页面 / error 可见 / 端口释放')
}

// ---------- 8. 其它三个渠道：初始化取消 / 换令牌途中取消 / 错误显示 ----------

async function testOtherChannelFlows(module_) {
  {
    // Grok：设备流取消 → 不写凭据；晚到的完成结果也不写、不请求 userinfo
    resetHttpStub([])
    let releasePoll
    const calls = { userinfo: 0 }
    globalThis.fetch = async (url) => {
      const u = String(url)
      if (u.endsWith('/.well-known/openid-configuration')) return json({ token_endpoint: 'https://auth.x.ai/oauth2/token' })
      if (u.endsWith('/oauth2/device/code')) {
        return json({ device_code: 'grok-dev', user_code: 'GROK-CODE', verification_uri_complete: 'https://x.ai/device', interval: 1, expires_in: 600 })
      }
      if (u.endsWith('/oauth2/token')) {
        return await new Promise((resolve) => {
          releasePoll = () => resolve(json({ access_token: 'grok-access', refresh_token: 'grok-refresh', expires_in: 600 }))
        })
      }
      if (u.endsWith('/oauth2/userinfo')) {
        calls.userinfo += 1
        return json({ sub: 'grok-sub' })
      }
      throw new Error('unexpected ' + u)
    }
    const { runtime, state } = createHarness(module_, { channelId: 'grok' })
    const result = await runtime.login()
    assert.equal(result.userCode, 'GROK-CODE')
    assert.equal((await runtime.authStatus()).status, 'pending')
    runtime.cancelLogin()
    assert.equal((await runtime.authStatus()).status, 'not-logged-in')
    assert.equal((await runtime.authStatus()).error, undefined, '取消不算失败')
    await waitFor(() => typeof releasePoll === 'function')
    releasePoll()
    await sleep(20)
    assert.equal(state.written.length, 0, '取消后晚到的完成结果不得写凭据')
    assert.equal(state.afterLoginCalls, 0)
    assert.equal(calls.userinfo, 0, '取消后不再请求 userinfo')
  }
  console.log('✓ 8a. Grok 设备流：取消后晚到的完成结果不写凭据、不 afterLogin')

  {
    // Grok：初始化失败 → login 抛错 + authStatus.error
    resetHttpStub([])
    globalThis.fetch = async (url) => {
      const u = String(url)
      if (u.endsWith('/.well-known/openid-configuration')) return json({ token_endpoint: 'https://auth.x.ai/oauth2/token' })
      if (u.endsWith('/oauth2/device/code')) return json({}, 500)
      throw new Error('unexpected ' + u)
    }
    const { runtime, state } = createHarness(module_, { channelId: 'grok' })
    await assert.rejects(runtime.login(), /设备码请求失败 \(HTTP 500\)/)
    const status = await runtime.authStatus()
    assert.equal(status.status, 'not-logged-in')
    assert.match(status.error, /设备码请求失败 \(HTTP 500\)/)
    assert.equal(state.written.length, 0)
  }
  console.log('✓ 8b. Grok：初始化失败抛给 UI 且进 authStatus.error')

  {
    // Kimi：换令牌在途时取消 → 不写；随后的重试进入新的 pending
    resetHttpStub([])
    let polls = 0
    let releaseExchange
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url)
      if (u.endsWith('/api/oauth/device_authorization')) {
        return json({ user_code: 'KIMI-CODE', device_code: 'kimi-dev', verification_uri_complete: 'https://kimi.test/device', expires_in: 600, interval: 1 })
      }
      if (u.endsWith('/api/oauth/token')) {
        const grant = new URLSearchParams(init.body).get('grant_type') ?? ''
        if (grant.includes('device_code')) {
          polls += 1
          if (polls === 1) return json({ error: 'authorization_pending' })
          return await new Promise((resolve) => {
            releaseExchange = () => resolve(json({ access_token: 'kimi-access', refresh_token: 'kimi-refresh', expires_in: 600 }))
          })
        }
        return json({ access_token: 'kimi-access', refresh_token: 'kimi-refresh', expires_in: 600 })
      }
      throw new Error('unexpected ' + u)
    }
    const { runtime, state } = createHarness(module_, { channelId: 'kimi' })
    const first = await runtime.login()
    assert.equal(first.userCode, 'KIMI-CODE')
    await waitFor(() => typeof releaseExchange === 'function', { timeout: 5000 })
    runtime.cancelLogin()
    releaseExchange()
    await sleep(20)
    assert.equal(state.written.length, 0, '取消后换到的令牌不得写入')
    assert.equal(state.afterLoginCalls, 0)
    const cancelled = await runtime.authStatus()
    assert.equal(cancelled.status, 'not-logged-in')
    assert.equal(cancelled.error, undefined, '取消不算失败')

    const second = await runtime.login()
    assert.equal(second.userCode, 'KIMI-CODE')
    const retried = await runtime.authStatus()
    assert.equal(retried.status, 'pending', '重试进入新的 pending')
    assert.equal(retried.userCode, 'KIMI-CODE')
    runtime.cancelLogin()
  }
  console.log('✓ 8c. Kimi：换令牌途中取消不写凭据，重试进入新的 pending')

  {
    // Claude：初始化取消；换令牌途中取消也不写凭据（回调服务器用假 http 的测试端口）
    resetHttpStub([])
    const port = 18671
    let exchanges = 0
    let releaseExchange
    globalThis.fetch = async (url) => {
      const u = String(url)
      if (u.endsWith('/v1/oauth/token')) {
        exchanges += 1
        return await new Promise((resolve) => {
          releaseExchange = () => resolve(json({ access_token: 'claude-access', refresh_token: 'claude-refresh', expires_in: 3600 }))
        })
      }
      throw new Error('unexpected ' + u)
    }
    const { runtime, state } = createHarness(module_, { channelId: 'claude', redirectPort: port })
    await runtime.login()
    assert.equal((await runtime.authStatus()).status, 'pending')
    runtime.cancelLogin()
    assert.equal((await runtime.authStatus()).status, 'not-logged-in')
    assert.equal(attemptedPorts().includes(port), true, 'Claude 在配置端口上等回调')

    const second = await runtime.login()
    const callbackState = new URL(second.url).searchParams.get('state')
    assert.equal(deliverCallback(port, { code: 'claude-code', state: callbackState }, undefined, '/callback').statusCode, 200)
    await waitFor(() => typeof releaseExchange === 'function')
    runtime.cancelLogin()
    releaseExchange()
    await sleep(20)
    assert.equal(state.written.length, 0, '取消后换到的令牌不得写入')
    assert.equal(state.afterLoginCalls, 0)
    assert.equal(exchanges, 1)
  }
  console.log('✓ 8d. Claude：初始化取消 + 换令牌途中取消都不写凭据')
}

async function main() {
  await rm(tmp, { recursive: true, force: true })
  await mkdir(tmp, { recursive: true })
  const httpStubPath = join(tmp, 'http-stub.mjs')
  const childProcessStubPath = join(tmp, 'child-process-stub.mjs')
  await writeFile(httpStubPath, HTTP_STUB)
  await writeFile(childProcessStubPath, CHILD_PROCESS_STUB)

  const oauth = await bundle("export * from './src/oauth.ts'", join(tmp, 'oauth.mjs'))
  const module_ = await bundle(
    `export * from './src/oauth.ts'
export * from './src/chatgpt-device-auth.ts'
export * from './src/device-flow.ts'
export { chatgptChannel, callbackPortCandidates } from './src/channels/chatgpt.ts'
export { claudeChannel } from './src/channels/claude.ts'
export { grokChannel } from './src/channels/grok.ts'
export { kimiChannel } from './src/channels/kimi.ts'`,
    join(tmp, 'chatgpt.mjs'),
    [stubPlugin({ 'node:http': httpStubPath, 'node:child_process': childProcessStubPath })],
  )

  try {
    await testListenerPrimitive(oauth)
    await testDeviceModule(module_)
    await testReadinessSettlement(module_)
    await testCallbackPorts(module_)
    await testCancelWhileBinding(module_)
    await testDeviceFallback(module_)
    await testCancellationAndIsolation(module_)
    await testDevicePollBoundaries(module_)
    await testInstanceIsolationAndCallbackReplay(module_)
    await testOtherChannelFlows(module_)
    await sleep(150)
    assert.equal(unhandled.length, 0, `出现 unhandledRejection: ${unhandled.map(String).join(', ')}`)
    console.log('\nchatgpt-auth 全部通过 ✔')
  } finally {
    globalThis.fetch = realFetch
    await rm(tmp, { recursive: true, force: true })
  }
}

await main()
