/**
 * 思考强度（reasoning effort）测试（node 直接跑）：
 * 1. resolveModel 返回 reasoning 元数据（efforts + defaultEffort）→ 模型选择器
 *    显示「推理等级」菜单；
 * 2. ChatGptAdapter（ChatGPT/Grok）：显式 effort 序列化为 responses 请求的
 *    reasoning.effort；未选择/未声明渠道不发送该字段；
 * 3. AnthropicMessagesAdapter（Claude/Kimi）：目录里带 compat.forceAdaptiveThinking
 *    的自适应模型把 effort 发成 thinking { type: 'adaptive' } + output_config.effort；
 *    旧式模型发 thinking { type: 'enabled', budget_tokens }，预算来自渠道声明。
 * 运行：node tests/reasoning-wire.mjs
 */
import assert from 'node:assert'
import { requestJson } from './wire-request.mjs'
import { ChatGptAdapter } from '../lib/adapter.js'
import { AnthropicMessagesAdapter } from '../lib/adapters/anthropic.js'

/**
 * 合成 JWT（无真实秘密）：codex 路由的 access token 必须带
 * `https://api.openai.com/auth`.chatgpt_account_id，SDK 才肯发请求。
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

/** 捕获 stream() 发出的请求体（mock fetch）。Responses 路由用，SSE 是 codex 的完整终态流。 */
function captureStream() {
  const message = { type: 'message', id: 'msg_rw', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok', annotations: [] }] }
  const frames = [
    { type: 'response.created', response: { id: 'resp_rw', status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_rw', role: 'assistant' } },
    { type: 'response.output_text.delta', output_index: 0, delta: 'ok' },
    { type: 'response.output_item.done', output_index: 0, item: message },
    {
      type: 'response.completed',
      response: {
        id: 'resp_rw',
        status: 'completed',
        output: [message],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
  ]
  return captureSse(frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''))
}

/** Anthropic 路由用：必须是 Anthropic Messages 的终态流（message_stop），否则 SDK 报流未结束。 */
function captureAnthropicStream() {
  return captureSse(
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n' +
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n' +
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n' +
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n' +
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  )
}

/** 用给定 SSE 文本替换 fetch，捕获请求体。 */
function captureSse(text) {
  let captured = undefined
  globalThis.fetch = async (_url, init) => {
    captured = requestJson(init)
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(text))
        c.close()
      },
    })
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  return { body: () => captured }
}

const baseOptions = {
  apiBaseURL: 'https://example.com/v1/responses',
  maxTokens: 8192,
  models: [
    { id: 'gpt-5.5', name: 'GPT-5.5', contextWindow: 400_000 },
    { id: 'grok-4.3', name: 'Grok 4.3', contextWindow: 1_000_000 },
  ],
  defaultContextWindow: 400_000,
}

const callOptions = {
  provider: 'chatgpt',
  model: 'gpt-5.5',
  messages: [],
}

const drain = async (iter) => {
  for await (const _chunk of iter) {
    /* 只驱动生成器，不做断言 */
  }
}

// ---------- 1. resolveModel 的 reasoning 元数据 ----------
{
  const adapter = new ChatGptAdapter({
    options: () => baseOptions,
    resolveAccessToken: async () => ({ access: 't' }),
    reasoning: {
      efforts: [
        { id: 'minimal', name: 'Minimal' },
        { id: 'low', name: 'Low' },
        { id: 'medium', name: 'Medium' },
        { id: 'high', name: 'High' },
      ],
      defaultEffort: 'medium',
    },
  })
  const info = await adapter.resolveModel('chatgpt', 'gpt-5.5')
  // 目录（pi-ai 内置目录）给 gpt-5.5 声明了 xhigh，因此可选档位比渠道声明的多一档
  assert.deepEqual(
    info.reasoning?.efforts.map((e) => e.id),
    ['minimal', 'low', 'medium', 'high', 'xhigh'],
    '可选档位 = 目录声明 + 渠道声明',
  )
  assert.equal(info.reasoning?.defaultEffort, 'medium')
  assert.equal(info.reasoning?.efforts[2].name, 'Medium')
  assert.equal(info.context?.contextWindow, 400_000)
  assert.equal(info.defaultMaxTokens, 8192)
  console.log('✓ 1. resolveModel 返回 reasoning 元数据（efforts + defaultEffort）')
}

// ---------- 2a. ChatGptAdapter：显式 effort → reasoning.effort ----------
{
  const adapter = new ChatGptAdapter({
    options: () => baseOptions,
    resolveAccessToken: async () => ({ access: TEST_ACCESS }),
    reasoning: {
      efforts: [
        { id: 'low', name: 'Low' },
        { id: 'medium', name: 'Medium' },
        { id: 'high', name: 'High' },
      ],
    },
  })
  const cap = captureStream()
  await drain(adapter.stream({ ...callOptions, reasoningEffort: 'high' }))
  // codex Responses 除了 effort 还会带 summary（宿主不传 reasoningSummary 时为 'auto'）
  assert.deepEqual(
    cap.body().reasoning,
    { effort: 'high', summary: 'auto' },
    'Responses 请求体携带 reasoning.effort',
  )
  console.log('✓ 2a. ChatGptAdapter 显式 effort=high → body.reasoning.effort=high')
}

// ---------- 2b. 未选择 effort → 不发送 reasoning 字段 ----------
{
  const adapter = new ChatGptAdapter({
    options: () => baseOptions,
    resolveAccessToken: async () => ({ access: TEST_ACCESS }),
    reasoning: {
      efforts: [{ id: 'high', name: 'High' }],
    },
  })
  const cap = captureStream()
  await drain(adapter.stream({ ...callOptions, model: 'grok-4.3' }))
  assert.equal(cap.body().reasoning, undefined, '未选择 effort 时不发送 reasoning')
  console.log('✓ 2b. 未选择 effort → 请求体无 reasoning 字段')
}

// ---------- 2c. 目录不认识的模型 + 渠道未声明 reasoning：无元数据；带 effort 则明确拒绝 ----------
// grok-4.3 不在 chatgpt 路由的目录（openai-codex）里，模型元数据只来自渠道：
// 渠道没声明 reasoning → 无 reasoning 元数据；此时带 effort 的请求被失败地拒绝（不再静默丢弃）
{
  const adapter = new ChatGptAdapter({
    options: () => baseOptions,
    resolveAccessToken: async () => ({ access: TEST_ACCESS }),
  })
  const info = await adapter.resolveModel('chatgpt', 'grok-4.3')
  assert.equal(info.reasoning, undefined, '目录不认识 + 渠道未声明的模型无 reasoning 元数据')
  const cap = captureStream()
  await assert.rejects(
    () => drain(adapter.stream({ ...callOptions, model: 'grok-4.3', reasoningEffort: 'high' })),
    /does not support reasoning effort/,
    '不支持的 effort 必须明确报错，而不是静默不发',
  )
  assert.equal(cap.body(), undefined, '被拒绝的请求不会发出去')
  console.log('✓ 2c. 无 reasoning 元数据的模型：带 effort 的请求被明确拒绝')
}

// ---------- 3a. AnthropicMessagesAdapter：旧式模型 effort → thinking.budget_tokens ----------
// claude-sonnet-4-5 在 pi-ai 目录里不带 forceAdaptiveThinking → 预算式 thinking。
{
  const adapter = new AnthropicMessagesAdapter({
    label: 'claude',
    options: () => ({
      apiBaseURL: 'https://example.com/v1/messages',
      maxTokens: 64000,
      models: [{ id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', contextWindow: 1_000_000 }],
      defaultContextWindow: 1_000_000,
    }),
    resolveAccessToken: async () => ({ access: 't' }),
    reasoning: {
      efforts: [
        { id: 'low', name: 'Low', budgetTokens: 8_192 },
        { id: 'medium', name: 'Medium', budgetTokens: 16_384 },
        { id: 'high', name: 'High', budgetTokens: 32_000 },
      ],
      defaultEffort: 'medium',
    },
  })
  const cap = captureAnthropicStream()
  await drain(adapter.stream({
    provider: 'claude',
    model: 'claude-sonnet-4-5',
    messages: [],
    reasoningEffort: 'high',
  }))
  assert.deepEqual(
    cap.body().thinking,
    { type: 'enabled', budget_tokens: 32_000, display: 'summarized' },
    'thinking 携带档位预算',
  )
  console.log('✓ 3a. AnthropicMessagesAdapter（旧式模型）effort=high → thinking.budget_tokens=32000')
}

// ---------- 3b. 档位未声明 budget → 兜底 16384；未选择 → 不发送 ----------
// kimi-k2.6 不在 pi-ai 目录里（目录只有 k3 / kimi-for-coding 系且都带 forceAdaptiveThinking）
// → 走安全的非自适应路径，正好验证预算兜底。
{
  const adapter = new AnthropicMessagesAdapter({
    label: 'kimi',
    options: () => ({
      apiBaseURL: 'https://example.com/v1/messages',
      maxTokens: 32768,
      models: [{ id: 'kimi-k2.6', name: 'Kimi K2.6', contextWindow: 262_144 }],
      defaultContextWindow: 262_144,
    }),
    resolveAccessToken: async () => ({ access: 't' }),
    reasoning: {
      efforts: [{ id: 'high', name: 'High' }], // 无 budgetTokens → 兜底
    },
  })
  const cap = captureAnthropicStream()
  await drain(adapter.stream({ provider: 'kimi', model: 'kimi-k2.6', messages: [], reasoningEffort: 'high' }))
  assert.deepEqual(
    cap.body().thinking,
    { type: 'enabled', budget_tokens: 16_384, display: 'summarized' },
    'budget 兜底 16384',
  )
  const cap2 = captureAnthropicStream()
  await drain(adapter.stream({ provider: 'kimi', model: 'kimi-k2.6', messages: [] }))
  assert.equal(cap2.body().thinking, undefined, '未选择 effort 时不发送 thinking')
  console.log('✓ 3b. budget 兜底 16384；未选择 effort 不发送 thinking')
}

// ---------- 3c. 目录 compat.forceAdaptiveThinking → adaptive thinking + effort ----------
// claude-sonnet-5 在目录里带 forceAdaptiveThinking：必须发 adaptive + output_config.effort，
// 不得退回预算式；这是「目录 metadata 不得丢」的回归口。
{
  const adapter = new AnthropicMessagesAdapter({
    label: 'claude',
    options: () => ({
      apiBaseURL: 'https://example.com/v1/messages',
      maxTokens: 64000,
      models: [{ id: 'claude-sonnet-5', name: 'Claude Sonnet 5', contextWindow: 1_000_000 }],
      defaultContextWindow: 1_000_000,
    }),
    resolveAccessToken: async () => ({ access: 't' }),
    reasoning: {
      efforts: [
        { id: 'low', name: 'Low', budgetTokens: 8_192 },
        { id: 'high', name: 'High', budgetTokens: 32_000 },
      ],
      defaultEffort: 'high',
    },
  })
  const cap = captureAnthropicStream()
  await drain(adapter.stream({
    provider: 'claude',
    model: 'claude-sonnet-5',
    messages: [],
    reasoningEffort: 'high',
  }))
  assert.deepEqual(cap.body().thinking, { type: 'adaptive', display: 'summarized' }, '自适应模型发 adaptive thinking')
  assert.equal(cap.body().output_config?.effort, 'high', 'adaptive 走 output_config.effort')
  assert.equal(cap.body().thinking.budget_tokens, undefined, 'adaptive 不带 budget_tokens')
  console.log('✓ 3c. 自适应模型：thinking.type=adaptive + output_config.effort')
}

console.log('✓ 思考强度（reasoning effort）测试全部通过')
