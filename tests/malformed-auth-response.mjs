import assert from 'node:assert/strict'
import { test } from 'node:test'
import { requestDeviceAuthorization, pollDeviceAuthorization } from '../lib/chatgpt-device-auth.js'
import { exchangeAuthorizationCode, refreshAccessToken, readAuthJson } from '../lib/oauth.js'

// Fake marker only; all network responses are mocked.
for (const [name, request, expected] of [
  ['device authorization initialization', () => requestDeviceAuthorization(), '设备授权响应不是合法 JSON'],
  ['device authorization polling', () => pollDeviceAuthorization('fake-device-id', 'fake-code'), '设备授权响应不是合法 JSON'],
  ['authorization code exchange', () => exchangeAuthorizationCode('fake-code', 'http://localhost:1455/auth/callback', 'fake-verifier'), 'token response is not valid JSON'],
  ['token refresh', () => refreshAccessToken('fake-refresh'), 'token refresh response is not valid JSON'],
]) {
  await test(`${name}: malformed JSON must not echo response content`, async () => {
    const originalFetch = globalThis.fetch
    const marker = 'FAKE-AUTH-LEAK'
    globalThis.fetch = async () => new Response(marker, { status: 200 })
    try {
      await assert.rejects(request(), (error) =>
        error.message === expected && !error.message.includes(marker) && error.cause === undefined)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
}

await test('auth parser preserves cancellation and body-read errors', async () => {
  for (const original of [new DOMException('cancelled', 'AbortError'), new TypeError('connection reset')]) {
    await assert.rejects(readAuthJson({ json: async () => { throw original } }, 'invalid JSON'),
      (error) => error === original)
  }
})

await test('auth parser leaves valid JSON unchanged', async () => {
  const payload = { device_auth_id: 'fake-device', user_code: 'fake-code' }
  assert.deepEqual(await readAuthJson(new Response(JSON.stringify(payload)), 'invalid JSON'), payload)
})
