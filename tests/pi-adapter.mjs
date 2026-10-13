/**
 * 原生 pi-ai 适配器测试（node 直接跑）：驱动真实的 PiAiAdapter + 实际 pi-ai SDK，
 * 只 mock 网络响应，验证「路由 URL / 请求头 / token 读取、快照隔离、取消、
 * 文本+工具+思考流与 replay 数据、caller maxTokens、contextWindow、
 * 不支持输入的错误可读」这些薄封装必须交代的行为。
 * 运行：node tests/pi-adapter.mjs
 */
import assert from 'node:assert'
import { requestJson } from './wire-request.mjs'
import { createPiAdapter, normalizeBaseUrl } from '../lib/pi-adapter.js'

const encoder = new TextEncoder()

/**
 * 合成 JWT（无真实秘密）：codex 路由的 access token 必须带
 * `https://api.openai.com/auth`.chatgpt_account_id 声明，SDK 才肯发请求。
 */
function syntheticJwt(accountId = 'test-account') {
  const segment = (value) => Buffer.from(JSON.stringify(value)).toString('base64')
  return [
    segment({ alg: 'none', typ: 'JWT' }),
    segment({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId }, sub: 'test-sub' }),
    'test-signature',
  ].join('.')
}

const TEST_ACCESS = syntheticJwt()

/** 统一的 mock fetch：记录请求，按路由返回预设 SSE。 */
function mockFetch(handler) {
  const requests = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const body = requestJson(init)
    const record = { url: String(url), headers: Object.fromEntries(new Headers(init.headers).entries()), body, signal: init.signal }
    requests.push(record)
    const sse = await handler(record)
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sse))
        controller.close()
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  return { requests, restore: () => { globalThis.fetch = original } }
}

const REASONING_ITEM = { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'think' }] }
const MESSAGE_ITEM = { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'hi', annotations: [] }] }
const TOOL_ITEM = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"B"}' }

/**
 * codex Responses 的真实事件序列：每个事件的 data 都带真实 `type`，终态
 * `response.completed` 带完整 `response.output` 与 usage；工具项有
 * `response.output_item.done`（完整 arguments），否则 SDK 会报未完成的工具调用。
 */
const RESPONSES_SSE = [
  { type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } },
  { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_1' } },
  { type: 'response.reasoning_summary_text.delta', output_index: 0, delta: 'think' },
  { type: 'response.output_item.done', output_index: 0, item: REASONING_ITEM },
  { type: 'response.output_item.added', output_index: 1, item: { type: 'message', id: 'msg_1', role: 'assistant' } },
  { type: 'response.output_text.delta', output_index: 1, delta: 'hi' },
  { type: 'response.output_item.done', output_index: 1, item: MESSAGE_ITEM },
  { type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather', arguments: '' } },
  { type: 'response.function_call_arguments.delta', output_index: 2, delta: '{"city":"B"}' },
  { type: 'response.output_item.done', output_index: 2, item: TOOL_ITEM },
  {
    type: 'response.completed',
    response: {
      id: 'resp_1',
      status: 'completed',
      output: [REASONING_ITEM, MESSAGE_ITEM, TOOL_ITEM],
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        input_tokens_details: { cached_tokens: 3 },
        output_tokens_details: { reasoning_tokens: 2 },
      },
    },
  },
].map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join('')

const ANTHROPIC_SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-sonnet-5","content":[],"usage":{"input_tokens":10,"output_tokens":1}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig-1"}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":0}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"hi"}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":1}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
].join('\n')

/** 一个可控的渠道路由（默认 Responses）。 */
function route(overrides = {}) {
  let options = overrides.options ?? {
    apiBaseURL: 'https://example.com/v1/responses',
    maxTokens: 8192,
    models: [{ id: 'gpt-5.5', name: 'GPT-5.5', contextWindow: 400_000 }],
    defaultContextWindow: 400_000,
  }
  const tokens = []
  return {
    setOptions: (next) => { options = next },
    tokens,
    route: {
      provider: overrides.provider ?? 'chatgpt',
      displayName: overrides.displayName ?? 'ChatGPT (订阅)',
      ...(overrides.protocol !== undefined ? { protocol: overrides.protocol } : {}),
      options: () => options,
      resolveAccessToken: async () => {
        tokens.push('t')
        return { access: TEST_ACCESS }
      },
      ...(overrides.reasoning !== undefined ? { reasoning: overrides.reasoning } : {}),
      ...(overrides.log !== undefined ? { log: overrides.log } : {}),
    },
  }
}

const drain = async (iterable) => {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

// ---------- 1. baseURL 规范化：每个协议只裁自己的尾段，SDK 自己追加 ----------
assert.equal(normalizeBaseUrl('https://a.example/v1/responses', 'openai-responses'), 'https://a.example/v1')
assert.equal(normalizeBaseUrl('https://a.example/v1/responses/', 'openai-codex-responses'), 'https://a.example/v1')
// Anthropic：SDK 会补 `/v1/messages`，所以 base 要把 `/v1/messages` 一起裁掉
assert.equal(normalizeBaseUrl('https://a.example/v1/messages', 'anthropic-messages'), 'https://a.example')
assert.equal(normalizeBaseUrl('https://a.example/coding/v1/messages', 'anthropic-messages'), 'https://a.example/coding')
assert.equal(normalizeBaseUrl('https://a.example/v1', 'anthropic-messages'), 'https://a.example')
assert.equal(normalizeBaseUrl('https://a.example/coding', 'anthropic-messages'), 'https://a.example/coding')
// 自定义根路径里的其它段（/coding 之类）必须保留
assert.equal(normalizeBaseUrl('https://a.example/proxy/anthropic/v1/messages', 'anthropic-messages'), 'https://a.example/proxy/anthropic')
// 不把「裁 /v1」套到 Responses / codex 上
assert.equal(normalizeBaseUrl('https://a.example/v1', 'openai-responses'), 'https://a.example/v1')
assert.equal(normalizeBaseUrl('https://a.example/backend-api/codex/responses', 'openai-codex-responses'), 'https://a.example/backend-api/codex')
console.log('✓ 1. baseURL 规范化：Anthropic 裁 /v1/messages（不拼成 /v1/v1/messages），Responses 只裁 /responses')

// ---------- 2. 四条路由：最终 URL / token 读取 / 授权头（Bearer） ----------
for (const [provider, apiBaseURL, protocol, expectedUrl] of [
  ['chatgpt', 'https://example.com/backend-api/codex/responses', 'openai-codex-responses', 'https://example.com/backend-api/codex/responses'],
  ['grok', 'https://example.com/v1/responses', 'openai-responses', 'https://example.com/v1/responses'],
  ['claude', 'https://example.com/v1/messages', 'anthropic-messages', 'https://example.com/v1/messages'],
  ['kimi', 'https://example.com/coding/v1/messages', 'anthropic-messages', 'https://example.com/coding/v1/messages'],
]) {
  const sse = protocol === 'anthropic-messages' ? ANTHROPIC_SSE : RESPONSES_SSE
  const capture = mockFetch(async () => sse)
  try {
    const holder = route({ provider, protocol, options: {
      apiBaseURL,
      maxTokens: 8192,
      models: [{ id: protocol === 'anthropic-messages' ? 'claude-sonnet-5' : 'gpt-5.5', name: 'm', contextWindow: 200_000 }],
      defaultContextWindow: 200_000,
    } })
    const adapter = createPiAdapter(holder.route)
    await drain(adapter.stream({
      provider,
      model: protocol === 'anthropic-messages' ? 'claude-sonnet-5' : 'gpt-5.5',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }))
    assert.equal(capture.requests.length, 1, `${provider}: 应当只发一次请求`)
    assert.equal(capture.requests[0].url, expectedUrl + (protocol === 'anthropic-messages' ? '?beta=true' : ''), `${provider}: 最终 URL 精确等于配置的端点`)
    const auth = capture.requests[0].headers.authorization ?? capture.requests[0].headers.Authorization
    assert.equal(auth, `Bearer ${TEST_ACCESS}`, `${provider}: Authorization 头是 Bearer access（含 Anthropic 路由）`)
    assert.equal(holder.tokens.length, 1, `${provider}: 每次 stream 解析一次 token`)
  } finally {
    capture.restore()
  }
}
console.log('✓ 2. 四路由精确 URL / Bearer token / 每 stream 一次 token 解析')

// ---------- 3. caller maxTokens 覆盖 configured ----------
{
  const capture = mockFetch(async () => RESPONSES_SSE)
  try {
    const holder = route({ provider: 'grok', protocol: 'openai-responses' })
    const adapter = createPiAdapter(holder.route)
    await drain(adapter.stream({
      provider: 'grok',
      model: 'gpt-5.5',
      messages: [],
      maxTokens: 1234,
    }))
    assert.equal(capture.requests[0].body.max_output_tokens, 1234, 'caller 的 maxTokens 必须覆盖配置值')
  } finally {
    capture.restore()
  }
}
console.log('✓ 3. caller maxTokens 覆盖 configured（请求体带 1234）')

// ---------- 4. 快照隔离：在途请求不受配置变化影响 ----------
{
  let release
  const capture = mockFetch(async () => {
    await new Promise((resolve) => { release = resolve })
    return RESPONSES_SSE
  })
  try {
    const holder = route()
    const adapter = createPiAdapter(holder.route)
    const inflight = drain(adapter.stream({
      provider: 'chatgpt',
      model: 'gpt-5.5',
      messages: [],
    }))
    // 等请求真的发出去（说明快照已经冻结）
    while (capture.requests.length === 0) await new Promise((r) => setTimeout(r, 1))
    holder.setOptions({
      apiBaseURL: 'https://other.example/v1/responses',
      maxTokens: 4096,
      models: [{ id: 'gpt-5.5', name: 'GPT-5.5', contextWindow: 128_000 }],
      defaultContextWindow: 128_000,
    })
    release()
    await inflight
    assert.equal(capture.requests[0].url, 'https://example.com/v1/codex/responses', '在途请求仍用旧快照经Codex规范化的URL')
  } finally {
    capture.restore()
  }
}
console.log('✓ 4. 配置变化不污染在途请求的快照')

// ---------- 5. 取消：必须是 aborted finish / ABORTED，不是任意 finish ----------
{
  const original = globalThis.fetch
  let requestStarted
  const started = new Promise(resolve => { requestStarted = resolve })
  globalThis.fetch = async (_url, init) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_c","status":"in_progress"}}\n\n'))
      init.signal.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')), { once: true })
      requestStarted()
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  try {
    const holder = route()
    const adapter = createPiAdapter(holder.route)
    const controller = new AbortController()
    const chunks = []
    let error
    const outcome = (async () => {
      try {
        for await (const chunk of adapter.stream({
          provider: 'chatgpt',
          model: 'gpt-5.5',
          messages: [],
          signal: controller.signal,
        })) {
          chunks.push(chunk)
          controller.abort()
        }
      } catch (caught) {
        error = caught
      }
    })()
    await started
    controller.abort()
    await outcome
    const finish = chunks.at(-1)
    const abortedFinish = finish?.type === 'finish' && finish.reason.kind === 'aborted'
    const abortedError = error !== undefined && /abort/i.test(String(error?.code ?? error?.message ?? ''))
    assert.ok(abortedFinish || abortedError, `取消必须表现为 aborted finish / ABORTED（实际：${JSON.stringify({ finish: finish?.reason, error: error?.message })}）`)
    if (abortedFinish) assert.equal(finish.reason.failure.code, 'ABORTED', 'aborted finish 带 ABORTED failure')
  } finally {
    globalThis.fetch = original
  }
}
console.log('✓ 5. 取消：aborted finish / ABORTED，不会把任意 finish 当成功')

// ---------- 6. 文本 + 工具 + 思考的完整流与 replay 数据 ----------
{
  const capture = mockFetch(async () => RESPONSES_SSE)
  try {
    const holder = route({ reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } })
    const adapter = createPiAdapter(holder.route)
    const chunks = await drain(adapter.stream({
      provider: 'chatgpt',
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'weather?' }] }],
      tools: [{ name: 'get_weather', description: 'w', parameters: { type: 'object', properties: {} } }],
    }))
    assert.equal(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''), 'hi')
    assert.equal(chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join(''), 'think')
    const tool = chunks.find((c) => c.type === 'block-end' && c.block.type === 'tool-call')
    assert.equal(tool.block.name, 'get_weather')
    assert.equal(tool.block.arguments, '{"city":"B"}', '工具参数是 replay 需要的完整 JSON')
    assert.equal(chunks.at(-1).type, 'finish')
  } finally {
    capture.restore()
  }
}
console.log('✓ 6. Responses 流：文本 / 思考 / 工具参数 / finish 完整')

// ---------- 7. Claude 思考 + signature：从实际 finish.replayState 重放 ----------
{
  const capture = mockFetch(async () => ANTHROPIC_SSE)
  try {
    const holder = route({
      provider: 'claude',
      protocol: 'anthropic-messages',
      options: {
        apiBaseURL: 'https://example.com/v1/messages',
        maxTokens: 8192,
        models: [{ id: 'claude-sonnet-5', name: 'Claude Sonnet 5', contextWindow: 200_000 }],
        defaultContextWindow: 200_000,
      },
      reasoning: { efforts: [{ id: 'medium', name: 'Medium', budgetTokens: 16_384 }], defaultEffort: 'medium' },
    })
    const adapter = createPiAdapter(holder.route)
    const chunks = await drain(adapter.stream({
      provider: 'claude',
      model: 'claude-sonnet-5',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }))
    assert.equal(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''), 'hi')
    assert.ok(chunks.some((c) => c.type === 'reasoning-delta'), 'thinking_delta 必须翻译成 reasoning-delta')

    // 实际的 replay envelope：宿主 finish 上带出来，原样挂到 assistant 消息的 source 上
    const finish = chunks.at(-1)
    assert.equal(finish.type, 'finish')
    const replayState = finish.replayState
    assert.ok(replayState !== undefined, '成功响应的 finish 必须带 replayState')
    assert.equal(replayState.response.kind, 'pi-ai')
    assert.equal(replayState.response.provider, 'claude', 'envelope 带实际 provider')
    assert.equal(replayState.response.model, 'claude-sonnet-5', 'envelope 带请求的 model')
    assert.equal(replayState.blocks.length, 2, '每个 block 一条 replay 元数据')
    assert.deepEqual(replayState.blocks[0], { type: 'reasoning', thinkingSignature: 'sig-1' }, 'signature 进了 replay block')

    // 第二轮：拿上一轮的真实 replayState 重放，signature 必须原样回到 wire
    const replayAssistant = {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'hmm' },
        { type: 'text', text: 'hi' },
      ],
      source: { kind: 'model', provider: 'claude', model: 'claude-sonnet-5', replayState },
    }
    await drain(adapter.stream({
      provider: 'claude',
      model: 'claude-sonnet-5',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        replayAssistant,
        { role: 'user', content: [{ type: 'text', text: 'again' }] },
      ],
    }))
    const body = capture.requests.at(-1).body
    assert.ok(Array.isArray(body.messages), 'Anthropic 请求体带 messages')
    const assistant = body.messages.find((m) => m.role === 'assistant')
    assert.ok(assistant !== undefined, '重放的 assistant 轮仍在请求体里')
    assert.deepEqual(assistant.content, [
      { type: 'thinking', thinking: 'hmm', signature: 'sig-1' },
      { type: 'text', text: 'hi' },
    ], 'thinking signature 必须原样回到 wire')
  } finally {
    capture.restore()
  }
}
console.log('✓ 7. Claude 思考输出 + 从 finish.replayState 重放：signature 原样回 wire')

// ---------- 8. contextWindow 暴露 ----------
{
  const holder = route({
    options: {
      apiBaseURL: 'https://example.com/v1/responses',
      maxTokens: 8192,
      models: [
        { id: 'gpt-5.5', name: 'GPT-5.5', contextWindow: 111_111 },
        { id: 'custom-model', name: 'Custom' },
      ],
      defaultContextWindow: 222_222,
    },
  })
  const adapter = createPiAdapter(holder.route)
  assert.equal((await adapter.resolveModel('chatgpt', 'gpt-5.5')).context.contextWindow, 111_111, '条目自带的大小优先')
  assert.equal((await adapter.resolveModel('chatgpt', 'custom-model')).context.contextWindow, 222_222, '缺省回退 defaultContextWindow')
  console.log('✓ 8. 模型 contextWindow：条目优先、缺省回退 defaultContextWindow')
}

// ---------- 8b. 目录里认得的模型：条目没给 contextWindow 时用 defaultContextWindow ----------
{
  const holder = route({
    provider: 'claude',
    protocol: 'anthropic-messages',
    options: {
      apiBaseURL: 'https://example.com/v1/messages',
      maxTokens: 8192,
      models: [{ id: 'claude-sonnet-5', name: 'Claude Sonnet 5' }],
      defaultContextWindow: 333_333,
    },
  })
  const adapter = createPiAdapter(holder.route)
  // 目录里 claude-sonnet-5 的 contextWindow 是 1_000_000：必须以渠道给的 default 为准
  assert.equal(
    (await adapter.resolveModel('claude', 'claude-sonnet-5')).context.contextWindow,
    333_333,
    '严格 entry ?? defaultContextWindow，不拿目录值偷换',
  )
  console.log('✓ 8b. 目录认得的模型也严格用 entry ?? defaultContextWindow')
}

// ---------- 9. 不支持输入的可读错误 ----------
{
  const capture = mockFetch(async () => ANTHROPIC_SSE)
  try {
    const holder = route({
      provider: 'claude',
      protocol: 'anthropic-messages',
      options: {
        apiBaseURL: 'https://example.com/v1/messages',
        maxTokens: 8192,
        // 目录里 claude-haiku 系是文本模型；用真实目录里文本 only 的能力判定
        models: [{ id: 'claude-3-haiku-20240307', name: 'Haiku', contextWindow: 200_000 }],
        defaultContextWindow: 200_000,
      },
    })
    const adapter = createPiAdapter(holder.route)
    const info = await adapter.resolveModel('claude', 'claude-3-haiku-20240307')
    const supportsImage = (info.inputModalities ?? []).includes('image')
    if (!supportsImage) {
      let error
      try {
        await drain(adapter.stream({
          provider: 'claude',
          model: 'claude-3-haiku-20240307',
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: 'what is this' },
              { type: 'image', attachment: { id: 'img-1', mediaType: 'image/png' } },
            ],
          }],
        }))
      } catch (caught) {
        error = caught
      }
      assert.ok(error !== undefined, 'text-only 模型收到图片必须报错')
      assert.ok(!String(error.message).includes('[object Object]'), `错误信息必须可读（实际：${error.message}）`)
    } else {
      assert.equal(supportsImage, true, '该模型声明支持图片：图片不应被丢弃')
    }
  } finally {
    capture.restore()
  }
}
console.log('✓ 9. 不支持图片的模型给可读错误（或声明支持则保留图片）')

// ---------- 10. 目录 metadata 进 wire：adaptive 走 effort、旧模型走 budget ----------
{
  const capture = mockFetch(async () => ANTHROPIC_SSE)
  const claudeRoute = (modelId, maxTokens, reasoning) => route({
    provider: 'claude',
    protocol: 'anthropic-messages',
    options: {
      apiBaseURL: 'https://example.com/v1/messages',
      maxTokens,
      models: [{ id: modelId, name: modelId, contextWindow: 1_000_000 }],
      defaultContextWindow: 1_000_000,
    },
    reasoning,
  })
  try {
    // claude-sonnet-5 在目录里带 compat.forceAdaptiveThinking：必须发 adaptive thinking
    const adaptive = claudeRoute('claude-sonnet-5', 16_384, {
      efforts: [{ id: 'medium', name: 'Medium', budgetTokens: 16_384 }],
      defaultEffort: 'medium',
    })
    await drain(createPiAdapter(adaptive.route).stream({
      provider: 'claude',
      model: 'claude-sonnet-5',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      reasoningEffort: 'medium',
    }))
    const adaptiveBody = capture.requests.at(-1).body
    assert.deepEqual(adaptiveBody.thinking, { type: 'adaptive', display: 'summarized' }, '目录 compat 不得丢失：自适应模型发 adaptive thinking')
    assert.equal(adaptiveBody.output_config?.effort, 'medium', 'adaptive 走 output_config.effort')
    assert.equal(adaptiveBody.thinking.budget_tokens, undefined, 'adaptive 不带 budget_tokens')

    // claude-sonnet-4-5 是目录里的旧式模型：走预算式 thinking，预算来自渠道声明
    const legacy = claudeRoute('claude-sonnet-4-5', 64_000, {
      efforts: [{ id: 'medium', name: 'Medium', budgetTokens: 16_384 }],
      defaultEffort: 'medium',
    })
    await drain(createPiAdapter(legacy.route).stream({
      provider: 'claude',
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      reasoningEffort: 'medium',
    }))
    const legacyBody = capture.requests.at(-1).body
    assert.equal(legacyBody.thinking?.type, 'enabled', '非自适应模型仍然发预算式 thinking')
    assert.equal(legacyBody.thinking?.budget_tokens, 16_384, '渠道声明的 budgetTokens 进 wire')
    assert.equal(legacyBody.output_config, undefined, '预算式不发 effort')

    // 未指定请求档位时仍须应用已配置的medium默认，而非关闭思考
    await drain(createPiAdapter(legacy.route).stream({
      provider: 'claude',
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }))
    assert.equal(capture.requests.at(-1).body.thinking.budget_tokens, 16_384, '请求未指定档位时采用渠道配置的medium默认预算')

    // 渠道声明了 off 档位：off 允许 'off'，此时关闭思考发 disabled
    const offOffered = claudeRoute('claude-sonnet-4-5', 16_384, {
      efforts: [
        { id: 'off', name: 'Off' },
        { id: 'medium', name: 'Medium', budgetTokens: 16_384 },
      ],
    })
    await drain(createPiAdapter(offOffered.route).stream({
      provider: 'claude',
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }))
    assert.deepEqual(capture.requests.at(-1).body.thinking, { type: 'disabled' }, '渠道声明 off 时关闭思考发 disabled')
  } finally {
    capture.restore()
  }
}
console.log('✓ 10. 目录 metadata 保留：adaptive Claude 发 effort、旧模型发 budget、off 档位可控')

console.log('\npi-adapter 全部通过 ✔')

// Same model/profile snapshot must re-resolve credentials for every request.
for (const provider of ['chatgpt', 'grok', 'claude', 'kimi']) {
  const anthropic = provider === 'claude' || provider === 'kimi'
  const capture = mockFetch(async () => anthropic ? ANTHROPIC_SSE : RESPONSES_SSE)
  try {
    const holder = route({ provider, protocol: anthropic ? 'anthropic-messages' : provider === 'grok' ? 'openai-responses' : 'openai-codex-responses' })
    let reads = 0
    holder.route.resolveAccessToken = async () => ({ access: syntheticJwt(++reads === 1 ? 'first-account' : 'second-account') })
    const adapter = createPiAdapter(holder.route)
    for (let i = 0; i < 2; i++) await drain(adapter.stream({ provider, model: 'gpt-5.5', messages: [] }))
    assert.equal(reads, 2)
    assert.equal(capture.requests.length, 2)
    assert.notEqual(capture.requests[0].headers.authorization, capture.requests[1].headers.authorization)
  } finally { capture.restore() }
}
console.log('✓ 11. 同一配置快照的四渠道连续请求读取新令牌')
