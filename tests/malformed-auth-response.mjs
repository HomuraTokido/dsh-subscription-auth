import assert from 'node:assert/strict'
import { test } from 'node:test'
import { requestDeviceAuthorization, pollDeviceAuthorization } from '../lib/chatgpt-device-auth.js'

// Known defect independently reproduced by tester: Response.json() SyntaxError
// includes a fragment of malformed response content. Keep the desired assertion
// active and visibly TODO until the production parser sanitizes that error.
// This uses a fake marker, never a real token or external network.
for (const [name, request] of [
  ['device authorization initialization', () => requestDeviceAuthorization()],
  ['device authorization polling', () => pollDeviceAuthorization('fake-device-id', 'fake-code')],
]) {
  await test(`${name}: malformed JSON must not echo response content`, {
    todo: 'Known defect: JSON parse errors currently expose a response fragment',
  }, async () => {
    const originalFetch = globalThis.fetch
    const marker = 'FAKE-AUTH-LEAK'
    globalThis.fetch = async () => new Response(marker, { status: 200 })
    try {
      await assert.rejects(request(), (error) =>
        typeof error.message === 'string' && !error.message.includes(marker))
    } finally {
      globalThis.fetch = originalFetch
    }
  })
}
