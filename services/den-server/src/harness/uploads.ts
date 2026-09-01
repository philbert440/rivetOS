/**
 * Harness attachment staging — the design doc's `POST /uploads`.
 *
 *   POST /api/uploads?name=<client-filename>[&mime=<type>]   raw body
 *   → 201 { uri, name, mime, size, expiresAt }
 *
 * `UserTurn.attachments[].pathOrUri` must be **node-resolvable**: a remote
 * client (web / desktop / Android) has no path the node can open, so it
 * streams the bytes here first and puts the returned `uri` in the turn. This
 * endpoint is the only sanctioned way for a client to turn its own bytes into
 * a node-local path — attachments are never client filesystem paths.
 *
 * Deliberate shape choices, all matching what den already does:
 *
 * - **Raw body, metadata in the query string** — exactly `POST /files/upload`
 *   (`files.ts`). den has no body parser and no multipart dependency; adding
 *   one to accept `multipart/form-data` would be a new runtime dep for a
 *   single-file endpoint. A filename *header* was rejected for a different
 *   reason: den's CORS allow-list is a fixed set (`content-type`,
 *   `authorization`, two `x-rivet-*`), so a custom header would fail preflight
 *   for exactly the browser clients this endpoint exists for.
 * - **The client filename is metadata, never a path.** The on-disk name is
 *   always generated (`<uuid><ext>`); the client's name survives only as the
 *   sanitized single-segment `name` in the response, for display.
 * - **Flat staging dir, unique names.** No per-session subdirectories: with
 *   UUID names there is nothing to disambiguate, and a flat dir of regular
 *   files lets the TTL sweep be maximally paranoid — it never recurses and
 *   never touches an entry that is not a regular file, so a symlink planted
 *   in the staging dir can neither be followed nor unlinked.
 *
 * Auth is the den server's bearer gate, same as every other `/api/*` route;
 * these handlers assume the caller already passed it.
 *
 * See docs/ARCHITECTURE.md.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import {
  createWriteStream,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
} from 'node:fs'
import { join } from 'node:path'

/** Per-upload ceiling. Attachments are screenshots, logs and PDFs pasted into
 *  a turn — not disk images. (`/files/upload` allows 1 GiB because that mount
 *  is a filestore; this one is a scratch buffer on the node's state volume.) */
export const DEFAULT_UPLOAD_MAX_BYTES = 25 * 1024 * 1024

/** How long a staged file survives. Long enough to outlive a slow compose or
 *  a client that stages then reconnects; short enough that a forgotten upload
 *  is not a permanent resident. */
export const DEFAULT_UPLOAD_TTL_MS = 6 * 60 * 60 * 1000

/** Sweep cadence ceiling — a long TTL still gets checked twice an hour. */
const MAX_SWEEP_INTERVAL_MS = 30 * 60 * 1000
const MIN_SWEEP_INTERVAL_MS = 60 * 1000

/** In-flight temp name; committed to its real name by rename. */
const PART_SUFFIX = '.part'

/** Extension fallbacks for clients that send no usable Content-Type. */
const EXT_MIME: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.log': 'text/plain',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
}

/**
 * Last path segment of a client-supplied name, stripped to something safe to
 * echo back and safe to use as a filename fragment. Returns '' when nothing
 * usable survives — callers fall back to the generated id.
 *
 * Both `/` and `\` split: a Windows client sends `C:\Users\me\shot.png`, and
 * on POSIX a backslash would otherwise survive as a literal filename char.
 */
export function displayName(raw: string): string {
  const leaf = raw.split(/[/\\]/).pop() ?? ''
  const cleaned = leaf
    // eslint-disable-next-line no-control-regex -- stripping control chars is the point
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return ''
  return cleaned.slice(0, 128)
}

/**
 * Extension to give the staged file, derived from the client name. Only a
 * short alphanumeric suffix is honored — anything else (no dot, `..`, a
 * 40-char "extension", punctuation) stages without one. The extension is
 * cosmetic: it helps a driver or a human recognize the file, it is never
 * trusted for typing.
 */
export function safeExtension(raw: string): string {
  const leaf = displayName(raw)
  const dot = leaf.lastIndexOf('.')
  if (dot <= 0 || dot === leaf.length - 1) return ''
  const ext = leaf.slice(dot + 1)
  return /^[A-Za-z0-9]{1,12}$/.test(ext) ? `.${ext.toLowerCase()}` : ''
}

/** `<uuid><ext>` — the on-disk name. Never derived from client text beyond
 *  the validated extension, so traversal has nothing to work with. */
export function stagedFileName(clientName: string, id: string = randomUUID()): string {
  return `${id}${safeExtension(clientName)}`
}

/** Normalize a media type, or '' when it is absent/malformed. Parameters
 *  (`; charset=utf-8`, `; boundary=…`) are dropped. */
export function safeMime(raw: string | undefined): string {
  const base = (raw ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,127}$/.test(base)
    ? base
    : ''
}

export interface UploadRoutesOptions {
  /** Staging directory. Created lazily on the first upload. */
  dir: string
  maxBytes?: number
  /** 0 or less disables both the periodic sweep and `sweep()`. */
  ttlMs?: number
  /** Test seam; derived from `ttlMs` by default. */
  sweepIntervalMs?: number
  /** Test seam. */
  now?: () => number
  log?: (msg: string) => void
}

export interface UploadRoutes {
  /** Absolute staging directory. */
  readonly dir: string
  /** `true` when the request was handled (response already written). */
  handle(req: IncomingMessage, res: ServerResponse, url: URL): boolean
  /** Unlink staged files older than the TTL. Returns how many went. */
  sweep(): number
  close(): void
}

export function createUploadRoutes(opts: UploadRoutesOptions): UploadRoutes {
  const dir = opts.dir
  const maxBytes = opts.maxBytes && opts.maxBytes > 0 ? opts.maxBytes : DEFAULT_UPLOAD_MAX_BYTES
  const ttlMs = opts.ttlMs ?? DEFAULT_UPLOAD_TTL_MS
  const now = opts.now ?? ((): number => Date.now())
  const log = opts.log ?? ((): void => undefined)

  const json = (res: ServerResponse, status: number, body: unknown): boolean => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
    return true
  }

  const sweep = (): number => {
    if (ttlMs <= 0) return 0
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return 0 // no staging dir yet — nothing to reap
    }
    const cutoff = now() - ttlMs
    let removed = 0
    for (const name of entries) {
      const path = join(dir, name)
      let st
      try {
        // lstat, never stat: a symlink planted in the staging dir must not be
        // followed. It fails isFile() below and is left strictly alone —
        // unlinking it would still be safe, but "touch only what we wrote" is
        // the simpler invariant to audit.
        st = lstatSync(path)
      } catch {
        continue // raced away
      }
      if (!st.isFile()) continue
      if (st.mtimeMs > cutoff) continue
      try {
        unlinkSync(path)
        removed++
      } catch {
        // permissions / raced unlink — the next sweep tries again
      }
    }
    if (removed > 0) log(`[uploads] swept ${String(removed)} staged file(s) older than the TTL`)
    return removed
  }

  // Boot sweep: a node that was down past the TTL comes back with a clean
  // staging dir instead of yesterday's attachments.
  sweep()
  const interval =
    ttlMs > 0
      ? (opts.sweepIntervalMs ??
        Math.max(MIN_SWEEP_INTERVAL_MS, Math.min(ttlMs, MAX_SWEEP_INTERVAL_MS)))
      : 0
  const timer = interval > 0 ? setInterval(sweep, interval) : null
  timer?.unref?.()

  const handle = (req: IncomingMessage, res: ServerResponse, url: URL): boolean => {
    if (url.pathname !== '/api/uploads') return false
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })

    const clientName = url.searchParams.get('name') ?? ''
    const name = displayName(clientName)
    const id = randomUUID()
    const fileName = stagedFileName(clientName, id)
    const mime =
      safeMime(url.searchParams.get('mime') ?? undefined) ||
      safeMime(req.headers['content-type']) ||
      EXT_MIME[safeExtension(clientName)] ||
      'application/octet-stream'

    /**
     * Answer a request whose body we are not going to finish reading.
     * `Connection: close` tells node to tear the socket down once the
     * response is flushed; the destroy is the backstop for a client still
     * pushing bytes. Order matters — destroying first races the response out
     * of existence and the client sees a socket error instead of the status.
     */
    const refuse = (status: number, error: string): boolean => {
      if (res.headersSent) {
        req.destroy()
        return true
      }
      res.writeHead(status, { 'Content-Type': 'application/json', Connection: 'close' })
      res.end(JSON.stringify({ error }), () => {
        if (!req.complete) req.destroy()
      })
      return true
    }

    // Cheap pre-check: refuse an oversized body before reading a byte of it.
    const declared = req.headers['content-length']
    if (declared !== undefined && Number(declared) > maxBytes) {
      return refuse(413, `upload exceeds ${String(maxBytes)} bytes`)
    }

    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
    } catch (err) {
      return json(res, 500, { error: `staging dir unavailable: ${(err as Error).message}` })
    }

    const target = join(dir, fileName)
    const tmp = `${target}${PART_SUFFIX}`
    /**
     * Open the temp file SYNCHRONOUSLY and hand the stream a live fd.
     *
     * `createWriteStream(path, { flags: 'wx' })` opens lazily on the event
     * loop, which loses a race with `abort()`: a cap breach on the very first
     * chunk destroys the stream and unlinks `tmp` before the open lands, the
     * unlink no-ops on ENOENT, and the pending `O_CREAT` then recreates the
     * file — an empty `<uuid>.part` orphan that only the TTL sweep clears.
     * With the fd already open there is nothing left to race: the file exists
     * before the first byte can arrive, and `rmSync` always finds it. Writes
     * that lose to the unlink just land on an unlinked inode and vanish.
     *
     * 'wx': a collision on a fresh uuid is impossible in practice and a bug
     * worth failing on if it ever happens, rather than clobbering.
     */
    let fd: number
    try {
      fd = openSync(tmp, 'wx', 0o600)
    } catch (err) {
      return json(res, 500, { error: `staging failed: ${(err as Error).message}` })
    }
    const out = createWriteStream(tmp, { fd, autoClose: true })
    let bytes = 0
    let failed = false
    const abort = (status: number, error: string): void => {
      if (failed) return
      failed = true
      req.unpipe(out)
      out.destroy()
      rmSync(tmp, { force: true })
      refuse(status, error)
    }

    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > maxBytes) abort(413, `upload exceeds ${String(maxBytes)} bytes`)
    })
    req.on('error', () => abort(400, 'upload stream failed'))
    // A premature disconnect can surface as a bare 'close' with no 'error';
    // a partial body must never be committed to its final name.
    req.on('close', () => {
      if (!req.complete) abort(400, 'upload aborted mid-stream')
    })
    out.on('error', (err) => abort(500, `write failed: ${err.message}`))
    out.on('finish', () => {
      if (failed) return
      if (!req.complete || (declared !== undefined && bytes !== Number(declared))) {
        abort(400, 'upload truncated')
        return
      }
      if (bytes === 0) {
        abort(400, 'empty upload')
        return
      }
      try {
        renameSync(tmp, target)
      } catch (err) {
        rmSync(tmp, { force: true })
        json(res, 500, { error: `stage failed: ${(err as Error).message}` })
        return
      }
      log(`[uploads] staged ${fileName} (${String(bytes)} bytes, ${mime})`)
      json(res, 201, {
        // Absolute node-local path: exactly what `UserTurn.attachments[].
        // pathOrUri` wants. Not a file:// URL — every consumer of pathOrUri
        // is a driver that will open() it.
        uri: target,
        name: name || fileName,
        mime,
        size: bytes,
        ...(ttlMs > 0 ? { expiresAt: new Date(now() + ttlMs).toISOString() } : {}),
      })
    })
    req.pipe(out)
    return true
  }

  return {
    dir,
    handle,
    sweep,
    close(): void {
      if (timer) clearInterval(timer)
    },
  }
}
