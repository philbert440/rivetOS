/**
 * Stage dropped/pasted Files through the gateway upload endpoint and turn
 * the returned node-local uris into paste text for the terminal.
 *
 * The composer has its own chip state machine and does not use these
 * helpers — only the gateway method shape is shared.
 */

export interface StagedFile {
  uri: string
  name: string
  mime: string
  size: number
  expiresAt?: number
}

/** Subset of RivetGateway.stageUpload — fakes implement this, the real
 *  client is assignable. `expiresAt` is `number | string` because den
 *  sends an ISO string while StagedUploadResponse declares a number. */
export interface StageGateway {
  stageUpload(
    name: string,
    body: Blob | ArrayBuffer,
    opts?: { mime?: string; signal?: AbortSignal },
  ): Promise<{
    uri: string
    name?: string
    mime?: string
    size?: number
    expiresAt?: number | string
  }>
}

const DEFAULT_MIME = 'application/octet-stream'
const PASTED_IMAGE = 'pasted-image.png'
const PASTED_FILE = 'pasted-file'
/** POSIX: quote only when a char sits outside this set. */
const SAFE_PATH = /^[A-Za-z0-9_./:@=+-]+$/

function fallbackName(file: File, mime: string): string {
  if (file.name) return file.name
  return mime.startsWith('image/') ? PASTED_IMAGE : PASTED_FILE
}

/** Epoch ms, or undefined when the wire value is missing/unusable. */
function normalizeExpiresAt(raw: unknown): number | undefined {
  let n: number
  if (typeof raw === 'number') n = raw
  else if (typeof raw === 'string') n = Date.parse(raw)
  else return undefined
  return Number.isFinite(n) ? n : undefined
}

/** Hours remaining until `expiresAt`, always ≥ 1. Missing/NaN → den's
 *  default TTL (`6h`). */
export function expiresInLabel(expiresAt: number | undefined, now = Date.now()): string {
  if (expiresAt == null || !Number.isFinite(expiresAt)) return '6h'
  return `${Math.max(1, Math.round((expiresAt - now) / 3600000))}h`
}

/** Sequential stage. Failures are collected by fallback name; later files
 *  still run. Nameless image blobs become `pasted-image.png`. */
export async function stageFiles(
  gw: StageGateway,
  files: Iterable<File>,
): Promise<{ staged: StagedFile[]; failed: string[] }> {
  const staged: StagedFile[] = []
  const failed: string[] = []
  for (const file of files) {
    const mime = file.type || DEFAULT_MIME
    const name = fallbackName(file, mime)
    try {
      const res = await gw.stageUpload(name, file, { mime })
      staged.push({
        uri: res.uri,
        name: res.name ?? name,
        mime: res.mime ?? mime,
        size: res.size ?? file.size,
        expiresAt: normalizeExpiresAt(res.expiresAt),
      })
    } catch {
      failed.push(name)
    }
  }
  return { staged, failed }
}

/** clipboardData / dataTransfer → File[]. `files` wins when non-empty;
 *  otherwise `items` with `kind === 'file'` only when text/plain is empty
 *  (`getText` mirrors DataTransfer.getData; `getData` is accepted so both
 *  clipboardData and dataTransfer type-check without wrapping). */
export function filesFrom(
  dt:
    | {
        files?: FileList | File[] | null
        items?: DataTransferItemList | null
        getText?: (type: string) => string
        getData?: (format: string) => string
      }
    | null
    | undefined,
): File[] {
  if (!dt) return []
  const files = dt.files
  if (files && files.length > 0) return Array.from(files)
  const getText = dt.getText ?? dt.getData
  if ((getText?.('text/plain') ?? '') !== '') return []
  const items = dt.items
  if (!items) return []
  const out: File[] = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item.kind === 'file') {
      const f = item.getAsFile()
      if (f) out.push(f)
    }
  }
  return out
}

/** POSIX single-quote quoting; unquoted when every char is in the safe set.
 *  Control chars are stripped first — the result is pasted into a TUI via
 *  bracketed paste, and a path-borne ESC/CR/LF would escape that mode. */
export function shellQuotePath(p: string): string {
  const stripped = p
    .split('')
    .filter((ch) => {
      const c = ch.charCodeAt(0)
      return c >= 0x20 && c !== 0x7f
    })
    .join('')
  if (stripped !== '' && SAFE_PATH.test(stripped)) return stripped
  return `'${stripped.replaceAll("'", `'\\''`)}'`
}

/** Quoted, space-joined paths. No trailing newline — the user hits Enter. */
export function pathsToPasteText(uris: string[]): string {
  return uris.map(shellQuotePath).join(' ')
}
