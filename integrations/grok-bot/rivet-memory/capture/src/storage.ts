/**
 * Bound stored text and replace image payloads with a short stub.
 *
 * 256 KiB (262_144): after image stubs, the remaining overflow is huge
 * shell dumps. A 1M cap would still let the 104 mega-rows through the
 * trigram GIN index and the embedding queue. 256 KiB is 16× the old 16K
 * recap — enough for a long review — and the source pointer recovers the
 * rest via memory_get_full.
 */
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { CONTENT_LIMIT } from './types.js'

export { CONTENT_LIMIT }

const DATA_URI_RE = /data:(image\/[a-zA-Z0-9.+-]+)(?:;charset=[^;,]+)?;base64,([A-Za-z0-9+/=\s]+)/gi
const IMAGE_FIELD_RE =
  /("(?:b64_json|image_base64|imageBase64|base64_image|base64|b64)"\s*:\s*")([A-Za-z0-9+/=\s]{16,})(")/g
const MAGIC_B64_RE = /(?:^|[\s"'])((?:iVBORw0KGgo|\/9j\/|R0lGOD|UklGR)[A-Za-z0-9+/=\s]{16,})/g

export function pointerMeta(file: string, line: number): Record<string, unknown> {
  return { session_jsonl_path: resolve(file), session_jsonl_line: line }
}

export function imageStub(mime: string, bytes: Buffer): string {
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16)
  return `[image mime=${mime} bytes=${String(bytes.length)} sha256=${hash}]`
}

function mimeFromMagic(buf: Buffer): string {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'image/png'
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg'
  }
  if (buf.length >= 6 && buf.subarray(0, 6).toString('ascii').startsWith('GIF')) return 'image/gif'
  if (buf.length >= 12 && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return 'image/unknown'
}

function decodeB64(raw: string): Buffer | undefined {
  const compact = raw.replace(/\s+/g, '')
  if (!/^[A-Za-z0-9+/]+=*$/.test(compact) || compact.length < 16) return undefined
  try {
    return Buffer.from(compact, 'base64')
  } catch {
    return undefined
  }
}

/** Replace data-URI and base64 image payloads with a mime/bytes/hash stub. */
export function stubImagePayloads(text: string): { text: string; stubbed: boolean } {
  let stubbed = false
  let out = text.replace(DATA_URI_RE, (_m, mime: string, b64: string) => {
    const buf = decodeB64(b64)
    if (!buf) return _m
    stubbed = true
    return imageStub(mime, buf)
  })
  out = out.replace(IMAGE_FIELD_RE, (_m, prefix: string, b64: string, suffix: string) => {
    const buf = decodeB64(b64)
    if (!buf) return _m
    stubbed = true
    return `${prefix}${imageStub(mimeFromMagic(buf), buf)}${suffix}`
  })
  out = out.replace(MAGIC_B64_RE, (full, b64: string) => {
    const buf = decodeB64(b64)
    if (!buf || buf.length < 8) return full
    stubbed = true
    const lead = full.slice(0, full.length - b64.length)
    return `${lead}${imageStub(mimeFromMagic(buf), buf)}`
  })
  return { text: out, stubbed }
}

export function capStoredText(
  text: string,
  limit = CONTENT_LIMIT,
): { text: string; truncated: boolean; fullLength: number } {
  if (text.length <= limit) return { text, truncated: false, fullLength: text.length }
  let cut = limit
  const cc = text.charCodeAt(cut - 1)
  if (cc >= 0xd800 && cc <= 0xdbff) cut -= 1
  return { text: text.slice(0, Math.max(0, cut)), truncated: true, fullLength: text.length }
}

export function boundStoredText(
  raw: string,
  limit = CONTENT_LIMIT,
): { text: string; truncated: boolean; stubbed: boolean; fullLength: number } {
  const stub = stubImagePayloads(raw)
  const capped = capStoredText(stub.text, limit)
  return {
    text: capped.text,
    truncated: capped.truncated || stub.stubbed,
    stubbed: stub.stubbed,
    fullLength: stub.stubbed ? raw.length : capped.fullLength,
  }
}
