/**
 * Boot-time `?node=<baseUrl>` (+ optional `?token=`) — used by the Android
 * drawer (and deep links) to open the LOCAL hub already pointed at a chosen
 * peer. Contract:
 *   Android:  navigate → `http://127.0.0.1:5174/?node=<urlencoded denUrl>`
 *   Hub:      setConnection(denUrl) + roster add, then strip query params.
 *
 * Never navigates the document; only repoints the gateway client.
 */

import { gatewayOrigin } from './gateway-url.js'

export interface BootNodeHandlers {
  setConnection: (baseUrl: string, token?: string) => void
  addNode: (node: { name: string; baseUrl: string }) => void
}

/**
 * Parse `node` / `token` from a query string, repoint connection + roster.
 * Returns the canonical origin when applied, else null.
 */
export function parseBootNodeParam(search: string): {
  baseUrl: string
  token?: string
} | null {
  const raw = search.startsWith('?') ? search.slice(1) : search
  const params = new URLSearchParams(raw)
  const nodeRaw = params.get('node')
  if (!nodeRaw) return null
  // URLSearchParams already percent-decodes once
  const origin = gatewayOrigin(nodeRaw.trim())
  if (!origin) return null
  const token = params.get('token')?.trim() || undefined
  return { baseUrl: origin, token }
}

/**
 * Apply boot `?node=` (and optional `?token=`), add to roster, strip params
 * from the address bar via history.replaceState. No-op when param absent
 * or invalid. Returns true when a connection was set.
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

  handlers.setConnection(parsed.baseUrl, parsed.token)
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
