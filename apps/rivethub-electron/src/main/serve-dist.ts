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
 * Every response carries the same CSP the Tauri shell enforced through
 * tauri.conf.json — the shell changed, the policy must not.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'

export const APP_SCHEME = 'app'
export const APP_ORIGIN = `${APP_SCHEME}://bundle`

/** The Tauri config's CSP, plus `frame-ancestors 'none'`: nothing may frame
 *  an app:// document — without it a den page (frame-src allows http/https
 *  content INSIDE the hub) could nest app://bundle and clickjack the
 *  privileged UI (review finding, PR #555). The hub itself never frames
 *  app:// content, so 'none' costs nothing. */
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
 * attempts and undecodable paths. A trailing slash means the directory's own
 * index.html (`/den/` → den/index.html — the nested den viewer, not the hub
 * SPA). SPA fallback: anything else without an extension (a router path, or
 * `/`) resolves to the root index.html — the client router owns those.
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
    relative === ''
      ? 'index.html'
      : relative.endsWith('/')
        ? `${relative}index.html`
        : path.extname(relative) === ''
          ? 'index.html'
          : relative
  const file = path.normalize(path.join(distDir, wanted))
  // The fence: a normalized path must stay inside the dist root.
  if (file !== distDir && !file.startsWith(distDir + path.sep)) return null
  const mime = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
  return { file, mime }
}

/** Register the app:// handler on the given protocol module (post-ready). */
export function serveDist(
  protocol: { handle: (scheme: string, handler: (req: Request) => Promise<Response>) => void },
  distDir: string,
): void {
  const root = path.normalize(distDir)
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
      const body = await fs.readFile(asset.file)
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
