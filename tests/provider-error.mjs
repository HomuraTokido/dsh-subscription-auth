/**
 * Provider 错误展示测试（node 直接跑 lib/adapter.js，驱动真实 pi-ai SDK）。
 *
 * 原生 pi-ai 适配器不靠抛异常：provider 错误以 **in-band 终态** 传递——流的最后一个
 * chunk 是 `finish`，`reason.kind === 'error'`，细节在 `reason.failure.{message,code}`。
 * 这里按这个契约校验：嵌套的 server_is_overloaded 原 message 必须可读、未知形状
 * 不能变成 [object Object]、任何情况都不能以「空成功」收场。
 * 全部网络都是 mock，access token 是合成 JWT（无真实秘密）。
 * 运行：node tests/provider-error.mjs
 */
import assert from 'node:assert/strict'
import { ChatGptAdapter } from '../lib/adapter.js'

/** 合成 JWT（无真实秘密）：codex 路由要求 access token 带 chatgpt_account_id 声明。 */
function syntheticJwt(accountId = 'test-account') {
  const segment = (value) => Buffer.from(JSON.stringify(value)).toString('base64')
  return [
    segment({ alg: 'none', typ: 'JWT' }),
    segment({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId }, sub: 'test-sub' }),
    'test-signature',
  ].join('.')
}

const adapter = new ChatGptAdapter({
  // 原生 pi-ai 适配器按路由的已配置模型解析请求：要流的模型必须声明在列表里。
  options: () => ({
    apiBaseURL: 'https://chatgpt.com/backend-api/codex/responses',
    maxTokens: 64,
    models: [{ id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', contextWindow: 400_000 }],
    defaultContextWindow: 400000,
  }),
  resolveAccessToken: async () => ({ access: syntheticJwt() }),
})

const original = globalThis.fetch

/** 用一段 SSE 文本驱动一次 stream，返回 {chunks, error}（in-band 错误不抛）。 */
async function streamFrames(text, { piece } = {}) {
  const bytes = new TextEncoder().encode(text)
  globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) {
    const step = piece === undefined ? bytes.length : piece
    for (let offset = 0; offset < bytes.length; offset += step) {
      controller.enqueue(bytes.slice(offset, offset + step))
    }
    controller.close()
  }}), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  const chunks = []
  try {
    for await (const chunk of adapter.stream({
      provider: 'chatgpt',
      model: 'gpt-6.1-sol',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }],
    })) {
      chunks.push(chunk)
    }
  } catch (error) {
    return { chunks, error }
  }
  return { chunks, error: undefined }
}

/** 断言流以 error finish 收场，返回它的 failure（message 必须可读）。 */
function expectErrorFinish({ chunks, error }, label) {
  assert.equal(
    error,
    undefined,
    `${label}：provider 错误必须 in-band 传递（error finish），不能抛异常（实际抛出 ${error?.message}）`,
  )
  const finish = chunks.at(-1)
  assert.equal(finish?.type, 'finish', `${label}：流必须以 finish 结束（实际 ${String(finish?.type)}）`)
  assert.equal(
    finish.reason.kind,
    'error',
    `${label}：必须以 error finish 结束，不能把失败当成功（实际 ${JSON.stringify(finish.reason)}）`,
  )
  const failure = finish.reason.failure
  assert.equal(typeof failure?.message, 'string', `${label}：failure.message 必须是字符串`)
  assert.ok(failure.message.length > 0, `${label}：failure.message 不能为空`)
  assert.match(String(failure.code), /^[A-Z_]+$/, `${label}：failure.code 必须是稳定错误码（实际 ${String(failure.code)}）`)
  assert.ok(
    !failure.message.includes('[object Object]'),
    `${label}：不能出现 [object Object]（实际：${failure.message}）`,
  )
  return failure
}

try {
  // ---------- 1. 真实 codex server_is_overloaded（嵌套 error 对象） ----------
  {
    const overloaded = {
      type: 'error',
      error: {
        type: 'server_error',
        code: 'server_is_overloaded',
        message: 'Our servers are currently overloaded. Please try again later.',
      },
    }
    const frame = (eol) => 'event: error' + eol + 'data: ' + JSON.stringify(overloaded) + eol + eol
    for (const [label, text, piece] of [
      ['LF 帧', frame('\n')],
      ['CRLF 帧', frame('\r\n')],
      ['分片传输（每 7 字节一块，会切进 JSON 与 \\r\\n 中间）', frame('\r\n'), 7],
    ]) {
      const failure = expectErrorFinish(await streamFrames(text, { piece }), label)
      assert.ok(
        failure.message.includes('Our servers are currently overloaded. Please try again later.'),
        `${label}：嵌套的原 message 必须保留（实际：${failure.message}）`,
      )
    }
    console.log('✓ 1. 嵌套 server_is_overloaded：in-band error finish，原 message 保留（含 CRLF / 分片）')
  }

  // ---------- 2. 顶层 message/code 与字符串 error ----------
  for (const [label, payload] of [
    ['顶层 message + code', { type: 'error', message: 'Context exhausted', code: 'context_length_exceeded' }],
    ['嵌套字符串 error', { type: 'error', error: 'Provider unavailable' }],
  ]) {
    const failure = expectErrorFinish(await streamFrames('event: error\ndata: ' + JSON.stringify(payload) + '\n\n'), label)
    assert.ok(failure.message.length > 0, label)
  }
  console.log('✓ 2. 顶层 / 字符串错误载荷都给出可读 message，且绝不空成功')

  // ---------- 3. 未知 / 空载荷：可读兜底、code 不丢 ----------
  for (const [label, payload] of [
    ['空 error 对象', { type: 'error' }],
    ['空嵌套 error', { type: 'error', error: {} }],
    ['非字符串 message', { type: 'error', message: { nested: 'object' } }],
    ['只有嵌套 code', { type: 'error', error: { code: 'server_is_overloaded' } }],
  ]) {
    const failure = expectErrorFinish(await streamFrames('event: error\ndata: ' + JSON.stringify(payload) + '\n\n'), label)
    assert.ok(!failure.message.includes('[object Object]'), label)
  }
  const codeOnly = expectErrorFinish(
    await streamFrames('event: error\ndata: ' + JSON.stringify({ type: 'error', error: { code: 'server_is_overloaded' } }) + '\n\n'),
    '只有嵌套 code',
  )
  assert.match(codeOnly.message, /server_is_overloaded/, '只有 code 时协议码不能丢')
  console.log('✓ 3. 未知 / 空错误载荷：可读兜底（无 [object Object]、无空成功、code 不丢）')
} finally {
  globalThis.fetch = original
}
console.log('\nprovider-error 全部通过 ✔')
