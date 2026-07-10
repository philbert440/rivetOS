/**
 * Shared filestore routes (/files/*, aliased at /api/files/*) — a browse/
 * download/upload surface over ONE operator-configured root (`/rivet-shared`
 * by default). Path-fenced: every request path is resolved and must stay
 * under the root; symlinks that point outside are refused on download so the
 * fence holds against link-outs, not just `..`.
 *
 *   GET  /files/list?path=<rel>                dir listing (dirs first)
 *   GET  /files/download?path=<rel>            stream one file
 *   POST /files/upload?dir=<rel>&name=<file>   raw-body write (no-clobber
 *        [&overwrite=1]                        unless overwrite)
 *
 * Auth rides the server's existing bearer gate — these handlers assume the
 * caller already passed it.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import type { FileEntry } from '@rivetos/types'

/** Hard upload ceiling — the mount is for plans and project files, not disk
 *  images; a runaway body must not fill the shared volume. */
const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024 // 1 GiB

/** Inline-viewable types open in the browser tab; everything else downloads. */
const INLINE_MIME: Record<string, string> = {
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.json': 'application/json',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/plain; charset=utf-8',
  '.js': 'text/plain; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.py': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.csv': 'text/plain; charset=utf-8',
  '.yaml': 'text/plain; charset=utf-8',
  '.yml': 'text/plain; charset=utf-8',
  '.toml': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
}

/**
 * Resolve a client-supplied root-relative path against the fence.
 * Returns the absolute path, or null when the input is absolute, escapes the
 * root, or smuggles NUL/backslash tricks. '' resolves to the root itself.
 */
export function resolveFenced(root: string, rel: string): string | null {
  if (rel.includes('\0')) return null
  // Windows-style separators never appear in legit rivet-shared paths; on
  // POSIX they'd survive resolve() as literal filename chars and confuse the
  // prefix check's mental model. Refuse outright.
  if (rel.includes('\\')) return null
  if (rel.startsWith('/') || rel.startsWith('~')) return null
  const abs = resolve(root, rel)
  return abs === root || abs.startsWith(root + sep) ? abs : null
}

/** Filename for upload: one path segment, no separators, no dot-dot. */
export function safeName(name: string): string | null {
  if (!name || name === '.' || name === '..') return null
  if (/[/\\\0]/.test(name)) return null
  return name
}

export interface FilesRoutes {
  /** True when the URL belonged to /files/* (response already written). */
  handle(req: IncomingMessage, res: ServerResponse, url: URL): boolean
}

export function createFilesRoutes(opts: {
  root: string
  log?: (msg: string) => void
}): FilesRoutes {
  const log = opts.log ?? (() => undefined)
  // Canonicalize the root once so the prefix fence compares real paths
  // (e.g. /rivet-shared itself may be a symlinked mount — that's fine, the
  // fence just has to be expressed in the same terms as the resolved child).
  const root = existsSync(opts.root) ? realpathSync(opts.root) : opts.root

  const json = (res: ServerResponse, status: number, body: unknown): boolean => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
    return true
  }

  const gate = (res: ServerResponse): boolean => {
    if (existsSync(root) && statSync(root).isDirectory()) return false
    json(res, 503, { error: `files root not available: ${root}` })
    return true
  }

  const handle = (req: IncomingMessage, res: ServerResponse, url: URL): boolean => {
    if (req.method === 'GET' && url.pathname === '/files/list') {
      if (gate(res)) return true
      const rel = url.searchParams.get('path') ?? ''
      const abs = resolveFenced(root, rel)
      if (!abs) return json(res, 403, { error: 'path escapes the files root' })
      if (!existsSync(abs) || !statSync(abs).isDirectory())
        return json(res, 404, { error: 'no such directory' })
      const entries: FileEntry[] = []
      for (const name of readdirSync(abs)) {
        try {
          const st = statSync(join(abs, name))
          entries.push({
            name,
            type: st.isDirectory() ? 'dir' : 'file',
            size: st.isDirectory() ? 0 : st.size,
            mtime: st.mtimeMs,
          })
        } catch {
          // broken symlink / raced unlink — skip, don't 500 the listing
        }
      }
      entries.sort((a, b) =>
        a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name),
      )
      const normRel = abs === root ? '' : abs.slice(root.length + 1)
      return json(res, 200, { path: normRel, root, entries })
    }

    if (req.method === 'GET' && url.pathname === '/files/download') {
      if (gate(res)) return true
      const rel = url.searchParams.get('path') ?? ''
      const abs = resolveFenced(root, rel)
      if (!abs) return json(res, 403, { error: 'path escapes the files root' })
      if (!existsSync(abs) || !statSync(abs).isFile())
        return json(res, 404, { error: 'no such file' })
      // Symlink fence: the resolved REAL file must also live under the root,
      // or a link inside the mount could exfiltrate anything on the node.
      const real = realpathSync(abs)
      if (real !== root && !real.startsWith(root + sep))
        return json(res, 403, { error: 'path escapes the files root' })
      const st = statSync(abs)
      const mime = INLINE_MIME[extname(abs).toLowerCase()]
      const name = abs.slice(abs.lastIndexOf(sep) + 1)
      res.writeHead(200, {
        'Content-Type': mime ?? 'application/octet-stream',
        'Content-Length': st.size,
        'Content-Disposition': `${mime ? 'inline' : 'attachment'}; filename="${encodeURIComponent(name)}"`,
      })
      createReadStream(abs).pipe(res)
      return true
    }

    if (req.method === 'POST' && url.pathname === '/files/upload') {
      if (gate(res)) return true
      const dirRel = url.searchParams.get('dir') ?? ''
      const name = safeName(url.searchParams.get('name') ?? '')
      if (!name) return json(res, 422, { error: 'invalid file name' })
      const dirAbs = resolveFenced(root, dirRel)
      if (!dirAbs) return json(res, 403, { error: 'path escapes the files root' })
      if (!existsSync(dirAbs) || !statSync(dirAbs).isDirectory())
        return json(res, 404, { error: 'no such directory' })
      const target = join(dirAbs, name)
      const overwrite = url.searchParams.get('overwrite') === '1'
      if (existsSync(target)) {
        if (!overwrite) return json(res, 409, { error: `${name} already exists` })
        // never follow an existing symlink/dir on overwrite — replace files only
        if (!lstatSync(target).isFile())
          return json(res, 409, { error: `${name} exists and is not a regular file` })
      }
      // Stream to a sibling temp file, rename on success — a dropped
      // connection must not leave a half-written file under the real name.
      const tmp = join(dirAbs, `.${name}.part-${String(process.pid)}-${String(Date.now())}`)
      const out = createWriteStream(tmp, { flags: 'wx' })
      let bytes = 0
      let failed = false
      const abort = (status: number, error: string): void => {
        if (failed) return
        failed = true
        out.destroy()
        rmSync(tmp, { force: true })
        if (!res.headersSent) json(res, status, { error })
        req.destroy()
      }
      req.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > MAX_UPLOAD_BYTES) abort(413, 'upload exceeds 1 GiB cap')
      })
      req.on('error', () => abort(400, 'upload stream failed'))
      out.on('error', (err) => abort(500, `write failed: ${err.message}`))
      out.on('finish', () => {
        if (failed) return
        try {
          renameSync(tmp, target)
        } catch (err) {
          rmSync(tmp, { force: true })
          json(res, 500, { error: `rename failed: ${(err as Error).message}` })
          return
        }
        const relOut = target.slice(root.length + 1)
        log(`[files] upload ${relOut} (${String(bytes)} bytes)`)
        json(res, 200, { ok: true, path: relOut, bytes })
      })
      req.pipe(out)
      return true
    }

    return false
  }

  return { handle }
}
