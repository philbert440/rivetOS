/**
 * app:// protocol — serves the bundled rivethub-web dist to every window.
 *
 * A custom privileged scheme instead of loadFile so the renderer gets a
 * stable secure-context origin (app://bundle): localStorage keys survive
 * updates, navigator.clipboard exists, and remote-ui's isBundledOrigin
 * treats it as bundled (app://bundle is not a valid gateway origin).
 *
 * Every response carries the same CSP the Tauri shell enforced through
 * tauri.conf.json — the shell changed, the policy must not.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'

export const APP_SCHEME = 'app'
export const APP_ORIGIN = `${APP_SCHEME}://bundle`

/** Mirror of the Tauri config's CSP, verbatim. */
export const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: http: https:; font-src 'self' data:; " +
  "connect-src 'self' http: https: ws: wss:; frame-src http: https:; " +
  "object-src 'none'; base-uri 'self'"

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
 * attempts. SPA fallback: anything without an extension (a router path, or
 * `/`) resolves to index.html — the client router owns those.
 */
export function resolveAsset(
  distDir: string,
  urlPath: string,
): { file: string; mime: string } | null {
  const decoded = decodeURIComponent(urlPath.split('?')[0])
  const relative = decoded.replace(/^\/+/, '')
  const wanted = relative === '' || path.extname(relative) === '' ? 'index.html' : relative
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
  protocol.handle(APP_SCHEME, async (req) => {
    const { pathname } = new URL(req.url)
    const asset = resolveAsset(root, pathname)
    if (!asset) return new Response('forbidden', { status: 403 })
    try {
      const body = await fs.readFile(asset.file)
      return new Response(body, {
        headers: { 'content-type': asset.mime, 'content-security-policy': CSP },
      })
    } catch {
      // A missing hashed asset (stale tab across an update) must 404, not
      // soft-serve index.html as text/javascript.
      return new Response('not found', { status: 404 })
    }
  })
}
