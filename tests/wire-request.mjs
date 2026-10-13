import * as zlib from 'node:zlib'

/** SDK may send JSON as text, bytes, or zstd; inspect the actual wire body. */
export function requestJson(init = {}) {
  if (init.body == null) return undefined
  let bytes = Buffer.from(init.body)
  if (new Headers(init.headers).get('content-encoding') === 'zstd') {
    if (typeof zlib.zstdDecompressSync !== 'function') throw new Error('zstd request requires Node with zstd support')
    bytes = zlib.zstdDecompressSync(bytes)
  }
  return JSON.parse(bytes.toString('utf8'))
}
