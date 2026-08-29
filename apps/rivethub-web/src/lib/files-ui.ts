/**
 * Pure helpers for the Files browser (preview eligibility, join paths).
 */

const TEXT_EXT = new Set([
  '.txt',
  '.md',
  '.json',
  '.css',
  '.js',
  '.ts',
  '.tsx',
  '.jsx',
  '.py',
  '.log',
  '.csv',
  '.yaml',
  '.yml',
  '.toml',
  '.sh',
  '.rs',
  '.go',
  '.env',
  '.svg', // download-as-text only server-side; we still preview as text client-side via fetch
])

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])

export type PreviewKind = 'text' | 'image' | 'none'

export function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i).toLowerCase() : ''
}

/** Client-side preview kind (server still fences HTML as attachment). */
export function previewKind(name: string, size: number): PreviewKind {
  // Cap text preview at 1 MiB so we don't pull huge logs into the panel.
  if (TEXT_EXT.has(extOf(name)) && size <= 1024 * 1024) return 'text'
  if (IMAGE_EXT.has(extOf(name)) && size <= 12 * 1024 * 1024) return 'image'
  return 'none'
}

/** In-shell downloads buffer the whole file in the renderer (blob) — bound
 *  it so a multi-GB artifact can't OOM the window. */
export const DOWNLOAD_BLOB_MAX = 64 * 1024 * 1024

/** Human-readable refusal for an oversized in-shell download, or undefined
 *  when the size is acceptable/unknown-at-precheck. */
export function downloadTooLargeError(sizeBytes: number | undefined): string | undefined {
  if (sizeBytes === undefined || sizeBytes <= DOWNLOAD_BLOB_MAX) return undefined
  const mb = String(Math.round(DOWNLOAD_BLOB_MAX / 1024 / 1024))
  return `file exceeds the ${mb} MB in-app download limit — fetch it from the node directly`
}

/** Content-Length as a usable byte count, or null when absent/empty/NaN/
 *  negative — an unparseable header must read as UNKNOWN, never as 0, or an
 *  oversized chunked response sails past the size check. */
export function parseContentLength(raw: string | null): number | null {
  if (raw == null || raw.trim() === '') return null
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/** The subset of Response the bounded reader touches — structural so tests
 *  can hand in a fake stream. */
export interface BoundedBodyResponse {
  headers: { get(name: string): string | null }
  body: ReadableStream<Uint8Array> | null
  blob(): Promise<Blob>
}

/**
 * Buffer a response body under DOWNLOAD_BLOB_MAX, enforced on the ACTUAL
 * bytes read: a chunked or lying response cannot be bounded by its header,
 * so the declared length is only a fast refusal — the byte counter is the
 * cap. Aborts the stream the moment the count passes the limit.
 */
export async function readBlobBounded(res: BoundedBodyResponse): Promise<Blob> {
  const declared = parseContentLength(res.headers.get('content-length'))
  const declaredErr = downloadTooLargeError(declared ?? undefined)
  if (declaredErr) throw new Error(declaredErr)
  if (!res.body) return res.blob() // no stream API — the header check is all we have
  const reader = res.body.getReader()
  // Network reads are always plain-ArrayBuffer-backed; the assertion only
  // narrows the ArrayBufferLike generic BlobPart refuses.
  const chunks: Array<Uint8Array<ArrayBuffer>> = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > DOWNLOAD_BLOB_MAX) {
      await reader.cancel().catch(() => undefined)
      const err = downloadTooLargeError(total)
      throw new Error(err ?? 'download exceeded the in-app limit')
    }
    chunks.push(value as Uint8Array<ArrayBuffer>)
  }
  return new Blob(chunks)
}

/** Join root-relative path segments without trailing slash on root. */
export function joinRel(dir: string, name: string): string {
  if (!dir) return name
  return `${dir.replace(/\/+$/, '')}/${name}`
}

/** Parent of a root-relative path ('' for top-level entries). */
export function parentRel(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}

/** Basename of a root-relative path. */
export function baseName(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? path : path.slice(i + 1)
}
