/**
 * app:// protocol — serves the bundled rivethub-web dist to every window.
 *
 * A custom privileged scheme instead of loadFile so the renderer gets a
 * stable origin (app://bundle): localStorage keys survive updates, and
 * remote-ui's isBundledOrigin treats it as bundled (not a valid gateway
 * origin). NOTE the scheme registers `secure: false` (index.ts explains
 * why: plain-http LAN nodes must not be mixed-content-blocked), so this is
 * NOT a secure context — no navigator.clipboard, no crypto.subtle; the web
 * app's IPC clipboard bridge and uuid fallback cover exactly that.
 *
 * Every response carries the CSP below.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'

export const APP_SCHEME = 'app'
export const APP_ORIGIN = `${APP_SCHEME}://bundle`

/** True only for the bundled app origin, by PARSED protocol+host — never a
 *  string-prefix test (custom schemes give URL.origin 'null', so neither
 *  startsWith nor origin equality is safe). Accepts both shapes Electron
 *  hands the two permission gates — a full URL (request handler) and a bare
 *  origin (check handler) — so the fences cannot disagree (PR #555). */
export function isBundledUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.host}` === APP_ORIGIN
  } catch {
    return false
  }
}

/** The shell's ONE permission hole: microphone capture for the bundled UI's
 *  main frame (voice dictation). Camera, iframes, and every other origin
 *  stay denied — LAN-served frames must not inherit the mic hole. */
export function allowMediaRequest(details: {
  requestingUrl?: string
  isMainFrame?: boolean
  mediaTypes?: readonly string[]
}): boolean {
  if (!details.requestingUrl || !isBundledUrl(details.requestingUrl)) return false
  if (details.isMainFrame !== true) return false
  const types = details.mediaTypes ?? []
  return types.length > 0 && types.every((t) => t === 'audio')
}

/** Check-handler twin of allowMediaRequest (permissions.query must agree
 *  with getUserMedia — the #555 split). The check API has no mediaTypes
 *  array, only a single mediaType; anything video answers false. Electron
 *  passes isMainFrame here too — a same-origin subframe keeps the parent
 *  origin and omits embeddingOrigin, so the frame check is the only thing
 *  keeping the twins in agreement for nested bundled frames. Both gates
 *  fail closed when the boolean is missing. */
export function allowMediaCheck(
  requestingOrigin: string,
  details: { embeddingOrigin?: string; mediaType?: string; isMainFrame?: boolean },
): boolean {
  if (!isBundledUrl(requestingOrigin)) return false
  if (details.isMainFrame !== true) return false
  if (details.embeddingOrigin && !isBundledUrl(details.embeddingOrigin)) return false
  return details.mediaType !== 'video'
}

/** `frame-ancestors 'none'`: nothing may frame an app:// document — without
 *  it an embedded http/https page (frame-src allows content INSIDE the hub)
 *  could nest app://bundle and clickjack the privileged UI (review finding,
 *  PR #555). The hub itself never frames app:// content, so 'none' costs
 *  nothing. */
export const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: http: https:; font-src 'self' data:; " +
  "connect-src 'self' http: https: ws: wss:; frame-src http: https:; " +
  "object-src 'none'; base-uri 'self'; frame-ancestors 'none'"

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
}

/**
 * Resolve a request path to a file inside `distDir`, or null for traversal
 * attempts and undecodable paths. SPA fallback: anything without a file
 * extension (a router path, a trailing-slash directory, or `/`) resolves to
 * the root index.html — the client router owns those.
 */
export function resolveAsset(
  distDir: string,
  urlPath: string,
): { file: string; mime: string } | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0])
  } catch {
    return null // malformed escape (%zz) — refuse, don't throw out of the handler
  }
  const relative = decoded.replace(/^\/+/, '')
  const wanted =
    relative === '' || relative.endsWith('/') || path.extname(relative) === ''
      ? 'index.html'
      : relative
  const file = path.normalize(path.join(distDir, wanted))
  // The fence: a normalized path must stay inside the dist root.
  if (file !== distDir && !file.startsWith(distDir + path.sep)) return null
  const mime = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
  return { file, mime }
}

/**
 * Every file under `distDir`, keyed by normalized absolute path. The packaged
 * dist is a few MB and immutable for the life of the process, so holding it
 * in memory costs nothing — and it is the only thing that keeps NEW windows
 * working when the directory disappears underneath a running app. That is
 * not hypothetical: under `APPIMAGE_EXTRACT_AND_RUN` the AppImage runtime
 * extracts into `/tmp/appimage_extracted_<md5 of the image PATH>` — shared by
 * every launch of the same file — and `rm -rf`s it when ITS payload exits.
 * A second launch (Plasma/GNOME/Hyprland "open new window" re-runs Exec)
 * loses the single-instance lock, exits, and takes the first instance's
 * resources with it; the already-loaded windows keep running, every later
 * window 404s on index.html ("not found"). Reproduced on 0.5.16.
 */
export async function snapshotDist(distDir: string): Promise<Map<string, Buffer>> {
  const root = path.normalize(distDir)
  const files = new Map<string, Buffer>()
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const file = path.normalize(path.join(entry.parentPath, entry.name))
    files.set(file, await fs.readFile(file))
  }
  return files
}

export interface ServeDistOptions {
  /** Serve from an in-memory snapshot taken now (packaged builds — see
   *  snapshotDist). Off, every request reads the disk, so a dev rebuild of
   *  the web dist shows on reload. */
  snapshot?: boolean
  /** Snapshot failure is logged, never fatal: disk serving still works. */
  onError?: (err: unknown) => void
}

/** Register the app:// handler on the given protocol module (post-ready). */
export function serveDist(
  protocol: { handle: (scheme: string, handler: (req: Request) => Promise<Response>) => void },
  distDir: string,
  opts: ServeDistOptions = {},
): void {
  const root = path.normalize(distDir)
  const snapshot: Promise<Map<string, Buffer>> = opts.snapshot
    ? snapshotDist(root).catch((err: unknown) => {
        opts.onError?.(err)
        return new Map<string, Buffer>()
      })
    : Promise.resolve(new Map<string, Buffer>())
  // Error responses carry the CSP too — constant bodies, but "every app://
  // response carries the policy" should be true without exceptions.
  const errorHeaders = { 'content-type': 'text/plain', 'content-security-policy': CSP }
  protocol.handle(APP_SCHEME, async (req) => {
    let url: URL
    try {
      url = new URL(req.url)
    } catch {
      return new Response('bad request', { status: 400, headers: errorHeaders })
    }
    // One host, one origin: app://anything-else must not become a second
    // origin serving the same UI with its own storage partition.
    if (`${url.protocol}//${url.host}` !== APP_ORIGIN) {
      return new Response('forbidden', { status: 403, headers: errorHeaders })
    }
    const asset = resolveAsset(root, url.pathname)
    if (!asset) return new Response('forbidden', { status: 403, headers: errorHeaders })
    try {
      // Snapshot first: a file missing from it (dev, or a snapshot that
      // failed to load) still falls through to the disk.
      const body = (await snapshot).get(asset.file) ?? (await fs.readFile(asset.file))
      return new Response(body, {
        headers: { 'content-type': asset.mime, 'content-security-policy': CSP },
      })
    } catch {
      // A missing hashed asset (stale tab across an update) must 404, not
      // soft-serve index.html as text/javascript.
      return new Response('not found', { status: 404, headers: errorHeaders })
    }
  })
}
