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
} finally { globalThis.fetch = original }
