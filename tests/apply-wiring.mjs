/**
 * apply() 接线测试（node 直接跑，替代 bun smoke 的 section 6）：
 * 验证 provider/adapter 注册、按登录状态门控（未登录不注册）、每渠道一段
 * volatile Config、Typert Gateway Remote 服务注册，以及过期令牌下的模型发现。
 * 运行：node tests/apply-wiring.mjs
 */
import assert from 'node:assert'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'

const plugin = await import('../lib/index.js')
assert.equal(plugin.name, 'dsh-subscription-auth')
assert.deepEqual(plugin.inject, ['llm'])

// 测试环境无网络：让模型发现立刻失败（discoverModels 内部会捕获并返回 []）。
globalThis.fetch = async () => {
  throw new Error('no network in wiring test')
}

/** 每次 apply 用全新的记录器 + mock。tokens：ref 名 → StoredToken JSON。
 *  credReadyAt：credentials 服务在 apply 后多少 ms 才可用（默认 0 = 立即）。 */
function freshHarness(tokens = {}, credReadyAt = 0) {
  const calls = {
    providers: [],
    adapters: [],
    providerReplaces: [],
    adapterReplaces: [],
    plugins: [],
    effects: [],
    disposers: 0,
    /** configEditor 写进条目的最新 raw 配置。 */
    savedConfig: undefined,
  }
  const entry = { options: { id: 'dsh-subscription-auth' } }
  const configEditor = {
    edit: async (target, change) => {
      assert.equal(target, entry, 'configEditor.edit 编辑的是本插件自己的条目')
      calls.savedConfig = change(calls.savedConfig)
    },
  }
  const disposers = []
  let credReady = credReadyAt <= 0
  if (credReadyAt > 0) setTimeout(() => { credReady = true }, credReadyAt)
  /**
   * 真实 credential mock：引用半边（resolve/set/unset）留给旧令牌迁移，
   * 记录半边（readRecord/modifyRecord/deleteRecord）带串行事务语义——
   * modifyRecord 的 mutate 看到当前记录，返回 undefined 表示不改。
   */
  const records = new Map()
  let recordQueue = Promise.resolve()
  const mockCred = {
    resolve: async (ref) => {
      const raw = tokens[String(ref)]
      return raw === undefined ? undefined : { value: raw }
    },
    set: async (ref, value) => { tokens[String(ref)] = value },
    unset: async (ref) => { delete tokens[String(ref)] },
    readRecord: async (key) => records.get(String(key)),
    modifyRecord: async (key, mutate) => {
      const run = recordQueue.then(async () => {
        const next = await mutate(records.get(String(key)))
        if (next !== undefined) records.set(String(key), next)
        return records.get(String(key))
      })
      recordQueue = run.then(() => undefined, () => undefined)
      return run
    },
    deleteRecord: async (key) => { records.delete(String(key)) },
    /** 测试观察用。 */
    recordOf: (key) => records.get(String(key)),
    legacyRefs: () => Object.keys(tokens),
  }
  const mockCtx = {
    fiber: { entry },
    get: (name) => {
      if (name === 'credentials') return credReady ? mockCred : undefined
      if (name === 'configEditor') return configEditor
      return undefined
    },
    inject: (deps, fn) => {
      fn({
        effect: (cb, label) => {
          calls.effects.push(label)
          const d = cb()
          if (typeof d === 'function') {
            disposers.push(d)
            calls.disposers++
          }
        },
        webServer: {
          register: (desc) => {
            calls.routes.push(desc.path)
            calls.routeHandlers[desc.path] = desc.handler
            return () => {}
          },
        },
      })
    },
    plugin: (p) => {
      calls.plugins.push(p)
      return () => {}
    },
    effect: (cb, label) => {
      calls.effects.push(label)
      const d = cb()
      if (typeof d === 'function') {
        disposers.push(d)
        calls.disposers++
      }
    },
    llm: {
      registerConfigurableProviders: (list) => {
        calls.providers.push(...list)
        return {
          replace: (next) => {
            calls.providerReplaces.push(next.map((e) => e.provider))
          },
        }
      },
      registerAdapter: (ids, adapter) => {
        calls.adapters.push({ ids, adapter })
        return {
          replace: (next) => {
            calls.adapterReplaces.push(next)
          },
        }
      },
    },
  }
  return { calls, mockCtx, mockCred, disposers }
}

const waitSettle = () => new Promise((r) => setTimeout(r, 60))

// ============ 场景 A：完全没有令牌 → 4 个渠道全部不注册 ============
{
  const { calls, mockCtx } = freshHarness()
  plugin.apply(mockCtx)

  // 初始同步注册（API 要求至少一个条目）后，异步门控应全部撤销
  assert.deepEqual(
    calls.providers.map((p) => p.provider).sort(),
    ['chatgpt', 'claude', 'grok', 'kimi'],
    '4 个可配置 provider 初始注册',
  )
  assert.deepEqual(
    calls.adapters.map((a) => a.ids[0]).sort(),
    ['chatgpt', 'claude', 'grok', 'kimi'],
    '4 个 adapter 初始注册',
  )

  await waitSettle()

  assert.equal(calls.providerReplaces.length, 4, `未登录：4 个渠道都调用了 provider 撤销 (${calls.providerReplaces.length})`)
  assert.ok(
    calls.providerReplaces.every((list) => Array.isArray(list) && list.length === 0),
    `未登录：configurable provider 全部撤销 (${JSON.stringify(calls.providerReplaces)})`,
  )
  assert.equal(calls.adapterReplaces.length, 4, '未登录：4 个渠道都调用了 adapter 撤销')
  assert.ok(
    calls.adapterReplaces.every((list) => Array.isArray(list) && list.length === 0),
    '未登录：adapter 全部撤销',
  )
  console.log('✓ A. 未登录：4 个渠道的 provider + adapter 全部从模型列表撤销')
}

// ============ 场景 B：只有 chatgpt 有令牌 → 仅 chatgpt 保持注册 ============
{
  const token = JSON.stringify({ refresh: 'r', access: 'a', expires: Date.now() + 3600_000 })
  const { calls, mockCtx } = freshHarness({ CHATGPT_SUBSCRIPTION_TOKEN: token })
  plugin.apply(mockCtx)
  await waitSettle()

  // chatgpt：registered 状态未变（true），门控直接跳过 → 无 replace 调用
  assert.equal(
    calls.providerReplaces.filter((l) => l.length > 0).length,
    0,
    'chatgpt 保持注册（无需 replace）',
  )
  // 其余三个渠道撤销
  const withdrawn = calls.providerReplaces.filter((l) => l.length === 0).length
  assert.equal(withdrawn, 3, `其余 3 个渠道的 provider 撤销 (${withdrawn})`)
  const withdrawnAdapters = calls.adapterReplaces.filter((l) => l.length === 0).length
  assert.equal(withdrawnAdapters, 3, `其余 3 个渠道的 adapter 撤销 (${withdrawnAdapters})`)
  console.log('✓ B. 仅 chatgpt 已登录：chatgpt 保持注册，其余 3 个渠道撤销')
}

// ============ 场景 D：credentials 服务晚于插件激活（启动竞态） ============
// chatgpt 有令牌，但 credentials 在 apply 后 500ms 才可用。修复前门控一次性
// 执行会误判「未登录」而撤销 chatgpt；修复后门控轮询等待服务就绪，chatgpt
// 绝不撤销（只有无令牌的 3 个渠道被撤销）。
{
  const token = JSON.stringify({ refresh: 'r', access: 'a', expires: Date.now() + 3600_000 })
  const { calls, mockCtx } = freshHarness({ CHATGPT_SUBSCRIPTION_TOKEN: token }, 500)
  plugin.apply(mockCtx)
  await new Promise((r) => setTimeout(r, 1400)) // 等待 credentials 就绪 + 门控轮询收敛

  assert.equal(
    calls.providerReplaces.filter((l) => l.length === 0).length,
    3,
    `竞态下 chatgpt 不应被撤销（实际撤销 ${calls.providerReplaces.filter((l) => l.length === 0).length} 个）`,
  )
  assert.equal(
    calls.adapterReplaces.filter((l) => l.length === 0).length,
    3,
    '竞态下 chatgpt 的 adapter 不应被撤销',
  )
  assert.equal(
    calls.providerReplaces.filter((l) => l.length > 0).length,
    0,
    'chatgpt 保持注册（无重注册调用）',
  )
  console.log('✓ D. credentials 晚就绪（启动竞态）：门控轮询等待，chatgpt 不被误撤销')
}

// ============ 接线基础断言（Remote 服务 / settings / effect） ============
{
  const { calls, mockCtx } = freshHarness()
  plugin.apply(mockCtx)
  // apply 用动态 import() 挂 Remote 服务：等一轮宏任务让它落地。
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(calls.plugins.length, 1, 'Remote 服务类已通过 ctx.plugin 注册')
  // core 0.2 的 settings 只编辑插件 Config 里的 volatile 字段：每个渠道一段，空配置也能解析成引用。
  const parsed = plugin.Config({})
  assert.deepEqual(Object.keys(parsed).sort(), ['chatgpt', 'claude', 'grok', 'kimi'], 'Config 每个渠道一段')
  assert.ok(Object.values(parsed).every((ref) => typeof ref.get === 'function'), '每段都是 volatile 引用')
  assert.equal(parsed.chatgpt.get().apiBaseURL, 'https://chatgpt.com/backend-api/codex/responses', 'chatgpt 段带默认值')
  assert.ok(
    calls.providers.every((p) => p.settingsNs === 'dsh-subscription-auth' && p.settingsPath[0] === p.provider),
    'provider 的设置链接指向本插件条目下的渠道段',
  )
  assert.ok(calls.effects.length >= 1, `effect 已注册 (${calls.effects.join(', ')})`)

  // Remote 服务：namespace 就是 wire 前缀，三个方法都要带 @Remote 标记。
  const RemoteClass = calls.plugins[0]
  const instance = new RemoteClass({ reflect: { provide: () => {} } })
  assert.equal(instance.typertRemote.namespace, 'subscriptionAuth', 'wire namespace = subscriptionAuth')
  assert.deepEqual(
    remoteMethods(instance).map((m) => m.method).sort(),
    ['login', 'logout', 'providers'],
    '三个 Remote 端点已标记（gateway 靠它拼 subscriptionAuth/<方法名>）',
  )

  // 端点冒烟：providers 返回 4 个渠道卡片（未登录状态）
  const payload = await instance.providers()
  assert.equal(payload.providers.length, 4, 'providers 返回 4 个渠道')
  assert.deepEqual(payload.providers.map((p) => p.id).sort(), ['chatgpt', 'claude', 'grok', 'kimi'])
  assert.ok(payload.providers.every((p) => p.status === 'not-logged-in'), '未登录状态')

  // 未知 provider 抛错（gateway 会把它包成 failure 信封）
  await assert.rejects(() => instance.login('nope'), /unknown provider: nope/, '未知 provider 抛错')

  console.log('✓ C. 接线基础：Remote namespace subscriptionAuth + 3 端点 + 每渠道一段 volatile Config；providers 返回 4 卡片（含未登录态），未知 provider 抛错')
}

// ============ 场景 E：令牌已过期 → 先刷新、按 npm 上 codex 最新版发现、写回配置、设置页拿到新列表 ============
// 修复前：过期令牌让发现直接返回，客户端版本写死，设置页只看到内置兜底列表。
{
  const expired = JSON.stringify({ refresh: 'r', access: 'old', expires: Date.now() - 1000 })
  const requested = []
  const offline = globalThis.fetch
  globalThis.fetch = async (url) => {
    const u = String(url)
    requested.push(u)
    const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    if (u.includes('/oauth/token')) return json({ access_token: 'fresh', expires_in: 3600 })
    if (u.startsWith('https://registry.npmjs.org/@openai/codex/latest')) return json({ version: '0.160.0' })
    if (u.includes('/codex/models')) {
      return json({ models: [
        { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', visibility: 'list', context_window: 272000 },
        { slug: 'gpt-reserve', visibility: 'hide' },
      ] })
    }
    throw new Error(`unexpected fetch ${u}`)
  }
  try {
    const { calls, mockCtx } = freshHarness({ CHATGPT_SUBSCRIPTION_TOKEN: expired })
    plugin.apply(mockCtx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const instance = new calls.plugins[0]({ reflect: { provide: () => {} } })
    const card = (await instance.providers()).providers.find((p) => p.id === 'chatgpt')

    assert.deepEqual(card.models, ['gpt-6.1-sol'], `设置页拿到发现的列表，不是兜底 (${card.models})`)
    assert.equal(card.modelsSource, 'discovered', '卡片标明列表来自官方发现')
    assert.ok(requested.some((u) => u.includes('/oauth/token')), '过期令牌先刷新')
    assert.ok(requested.some((u) => u.includes('client_version=0.160.0')), `带 npm 最新版本号请求模型 (${requested.join(' | ')})`)
    assert.equal(requested.filter((u) => u.includes('/codex/models')).length, 1, '门控和设置页同时触发，只发一次发现请求')
    assert.deepEqual(calls.savedConfig?.chatgpt?.discoveredModels?.map((m) => m.id), ['gpt-6.1-sol'], '发现结果经 configEditor 写回 chatgpt 段')
    console.log('✓ E. 过期令牌：先刷新，按 codex 最新版发现，写回配置，设置页显示新列表')
  } finally {
    globalThis.fetch = offline
  }
}

// ============ 场景 F：发现迟到时 logout 已经清列表（guard 行为证明） ============
// 注销会把 revision 推前：在途发现拿到结果后不得再写回模型列表，也不得重新注册 provider。
{
  const token = JSON.stringify({ refresh: 'r', access: 'a', expires: Date.now() + 3600_000 })
  const { calls, mockCtx } = freshHarness({ CHATGPT_SUBSCRIPTION_TOKEN: token })
  const offline = globalThis.fetch
  let releaseModels
  let wrote = 0
  globalThis.fetch = async (url) => {
    const u = String(url)
    const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    if (u.includes('/oauth/token')) return json({ access_token: 'fresh', expires_in: 3600 })
    if (u.startsWith('https://registry.npmjs.org/')) return json({ version: '0.160.0' })
    if (u.includes('/codex/models')) {
      wrote += 1
      await new Promise((resolve) => { releaseModels = resolve })
      return json({ models: [{ slug: 'gpt-6.1-sol', visibility: 'list', context_window: 272000 }] })
    }
    throw new Error(`unexpected fetch ${u}`)
  }
  try {
    plugin.apply(mockCtx)
    await waitSettle()
    while (releaseModels === undefined) await new Promise((r) => setTimeout(r, 5))

    const instance = new calls.plugins[0]({ reflect: { provide: () => {} } })
    await instance.logout('chatgpt')
    const afterLogout = JSON.parse(JSON.stringify(calls.savedConfig?.chatgpt?.discoveredModels ?? null))

    releaseModels() // 迟到的发现结果
    await new Promise((r) => setTimeout(r, 40))

    assert.deepEqual(
      calls.savedConfig?.chatgpt?.discoveredModels ?? null,
      afterLogout,
      '注销后的迟到发现不得再写回模型列表',
    )
    assert.deepEqual(afterLogout, [], '注销把列表清成了空')
    assert.ok(calls.providerReplaces.every((list) => list.length === 0), '注销后不得重新注册 provider')
    console.log('✓ F. 发现迟到 + 已注销：不再写配置、不再注册（revision guard 的行为证明）')
  } finally {
    globalThis.fetch = offline
  }
}

// ============ 场景 G：插件卸载后迟到的发现不得写配置 / 注册 ============
{
  const token = JSON.stringify({ refresh: 'r', access: 'a', expires: Date.now() + 3600_000 })
  const { calls, mockCtx, disposers } = freshHarness({ CHATGPT_SUBSCRIPTION_TOKEN: token })
  const offline = globalThis.fetch
  let releaseModels
  globalThis.fetch = async (url) => {
    const u = String(url)
    const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    if (u.includes('/oauth/token')) return json({ access_token: 'fresh', expires_in: 3600 })
    if (u.startsWith('https://registry.npmjs.org/')) return json({ version: '0.160.0' })
    if (u.includes('/codex/models')) {
      await new Promise((resolve) => { releaseModels = resolve })
      return json({ models: [{ slug: 'gpt-6.1-sol', visibility: 'list', context_window: 272000 }] })
    }
    throw new Error(`unexpected fetch ${u}`)
  }
  try {
    plugin.apply(mockCtx)
    await waitSettle()
    while (releaseModels === undefined) await new Promise((r) => setTimeout(r, 5))

    // 卸载：跑 effect teardown（置 disposed + revision++ + cancelLogin）
    for (const dispose of disposers) dispose()
    const configBefore = JSON.parse(JSON.stringify(calls.savedConfig ?? null))
    const replacesBefore = calls.providerReplaces.length

    releaseModels()
    await new Promise((r) => setTimeout(r, 40))

    assert.deepEqual(JSON.parse(JSON.stringify(calls.savedConfig ?? null)), configBefore, '卸载后不得再写配置')
    assert.equal(calls.providerReplaces.length, replacesBefore, '卸载后不得再注册 / 撤销 provider')
    console.log('✓ G. 卸载后迟到的发现：不再写配置、不再注册')
  } finally {
    globalThis.fetch = offline
  }
}

console.log('✓ apply() 接线测试全部通过')
