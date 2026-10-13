import assert from 'node:assert/strict'
import { ChatGptAdapter } from '../lib/adapter.js'
const adapter = new ChatGptAdapter({
  options: () => ({ apiBaseURL: 'https://chatgpt.com/backend-api/codex/responses', maxTokens: 64, models: [], defaultContextWindow: 400000 }),
  resolveAccessToken: async () => ({ access: 'test-token' }),
})
const original = globalThis.fetch
try {
  for (const [payload, expected] of [
    [{ error: { message: 'Tool output is missing', code: 'invalid_request_error' } }, 'Tool output is missing (invalid_request_error)'],
    [{ error: 'Provider unavailable' }, 'Provider unavailable'],
    [{ message: 'Context exhausted', code: 'context_length_exceeded' }, 'Context exhausted (context_length_exceeded)'],
  ]) {
    globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('event: error\ndata: ' + JSON.stringify(payload) + '\n\n'))
      controller.close()
    }}), { status: 200 })
    await assert.rejects(async () => {
      for await (const _ of adapter.stream({ provider: 'chatgpt', model: 'gpt-6.1-sol', messages: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }] })) {}
    }, (error) => error.message === expected && error.code === 'PROVIDER')
  }
  console.log('Provider structured/string/top-level errors retain message and code')

  /** 用一段 SSE 文本驱动一次 stream 并返回抛出的错误；piece 指定则按字节切片模拟分片传输。 */
  async function streamError(text, { piece } = {}) {
    const bytes = new TextEncoder().encode(text)
    globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) {
      const step = piece === undefined ? bytes.length : piece
      for (let offset = 0; offset < bytes.length; offset += step) controller.enqueue(bytes.slice(offset, offset + step))
      controller.close()
    }}), { status: 200 })
    try {
      for await (const _ of adapter.stream({ provider: 'chatgpt', model: 'gpt-6.1-sol', messages: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }] })) {}
    } catch (error) { return error }
    return undefined
  }

  // 真实 codex server_is_overloaded：message 与 code 都在嵌套 error 对象里
  const overloaded = {
    type: 'error',
    error: {
      type: 'server_error',
      code: 'server_is_overloaded',
      message: 'Our servers are currently overloaded. Please try again later.',
    },
  }
  const overloadedMessage = 'Our servers are currently overloaded. Please try again later. (server_is_overloaded)'
  const frame = (eol) => 'event: error' + eol + 'data: ' + JSON.stringify(overloaded) + eol + eol
  for (const [label, text, piece] of [
    ['LF 帧', frame('\n')],
    ['CRLF 帧', frame('\r\n')],
    ['分片传输（每 7 字节一块，会切进 JSON 与 \\r\\n 中间）', frame('\r\n'), 7],
  ]) {
    const error = await streamError(text, { piece })
    assert.ok(error, label + '：应当抛错')
    assert.equal(error.message, overloadedMessage, label)
    assert.equal(error.code, 'PROVIDER', label)
  }
  console.log('Provider error frames survive CRLF framing and transport chunk splits')

  // 未知 / 空的错误载荷：给可读兜底，不能出现 [object Object]
  for (const [label, payload] of [
    ['空对象', {}],
    ['空嵌套 error', { error: {} }],
    ['只有 code', { error: { code: 'server_is_overloaded' } }],
    ['非字符串 message', { message: { nested: 'object' } }],
  ]) {
    const error = await streamError('event: error\ndata: ' + JSON.stringify(payload) + '\n\n')
    assert.ok(error, label + '：应当抛错')
    assert.equal(error.code, 'PROVIDER', label)
    assert.equal(typeof error.message, 'string', label)
    assert.ok(error.message.length > 0, label + '：错误信息不能为空')
    assert.ok(!error.message.includes('[object Object]'), label + '：不能出现 [object Object]（实际：' + error.message + '）')
  }
  // 只有 code 的兜底里 code 不能丢
  assert.match(
    (await streamError('event: error\ndata: ' + JSON.stringify({ error: { code: 'server_is_overloaded' } }) + '\n\n')).message,
    /server_is_overloaded/,
  )
  console.log('Provider unknown/empty errors fall back to a readable message (no [object Object])')
} finally { globalThis.fetch = original }
