/**
 * Boot-time `?node=<baseUrl>` — used by the Android drawer (and deep links)
 * to open the local hub already pointed at a chosen peer. Contract:
 *   Android:  navigate → `http://127.0.0.1:5174/?node=<urlencoded denUrl>`
 *   Hub:      setConnection(denUrl) + roster add, then strip query params.
 *
 * `?token=` is ignored (bearer auth removed — device mTLS only).
 * Never navigates the document; only repoints the gateway client.
 */

import { gatewayOrigin } from './gateway-url.js'

export interface BootNodeHandlers {
  setConnection: (baseUrl: string) => void
  addNode: (node: { name: string; baseUrl: string }) => void
}

/**
 * Parse `node` from a query string (legacy `token` param is discarded).
 * Returns the canonical origin when present, else null.
 */
export function parseBootNodeParam(search: string): {
  baseUrl: string
} | null {
  const raw = search.startsWith('?') ? search.slice(1) : search
  const params = new URLSearchParams(raw)
  const nodeRaw = params.get('node')
  if (!nodeRaw) return null
  const origin = gatewayOrigin(nodeRaw.trim())
  if (!origin) return null
  return { baseUrl: origin }
}

/**
 * Apply boot `?node=`, add to roster, strip params from the address bar via
 * history.replaceState. No-op when param absent or invalid.
 */
export function applyBootNodeParam(
  handlers: BootNodeHandlers,
  opts?: {
    search?: string
    href?: string
    replaceState?: (url: string) => void
  },
): boolean {
  const search = opts?.search ?? (typeof location !== 'undefined' ? location.search : '')
  const parsed = parseBootNodeParam(search)
  if (!parsed) return false

  handlers.setConnection(parsed.baseUrl)
  let host: string
  try {
    host = new URL(parsed.baseUrl).host
  } catch {
    host = parsed.baseUrl
  }
  handlers.addNode({ name: host, baseUrl: parsed.baseUrl })

  const href = opts?.href ?? (typeof location !== 'undefined' ? location.href : '')
  if (href) {
    try {
      const u = new URL(href)
      u.searchParams.delete('node')
      u.searchParams.delete('token')
      const next = u.pathname + u.search + u.hash
      const replace =
        opts?.replaceState ??
        ((url: string) => {
          if (typeof history !== 'undefined' && typeof history.replaceState === 'function') {
            history.replaceState(null, '', url)
          }
        })
      replace(next)
    } catch {
      /* ignore bad href in tests */
    }
  }
  return true
}
