// Where the den-server lives. When the viewer is served BY den-server the
// API is same-origin; in vite dev it's the default den port on the same host.
// `?server=` overrides both (and `?token=` rides along for auth): a bare
// `host:port` inherits the page's protocol, a full `http(s)://origin` is used
// as-is (its scheme also picks ws vs wss).

const DEV_PORT = 5174

export interface PageLocation {
  protocol: string
  host: string
  hostname: string
}

export interface ServerBases {
  /** http(s) base, no trailing slash — '' means same-origin. */
  http: string
  /** ws(s) base, scheme + host only (endpoints append their own path). */
  ws: string
}

/** Pure derivation so tests can exercise it without a browser `location`. */
export function resolveServer(
  override: string | null,
  dev: boolean,
  page: PageLocation,
): ServerBases {
  const wsProto = page.protocol === 'https:' ? 'wss' : 'ws'
  if (override) {
    if (override.includes('://')) {
      try {
        const u = new URL(override)
        // origin (not the raw string): drops any path/query, keeps host:port
        return { http: u.origin, ws: `${u.protocol === 'https:' ? 'wss' : 'ws'}://${u.host}` }
      } catch {
        // unparseable — fall through to the bare host:port treatment, which
        // is exactly what garbage got before full origins were accepted
      }
    }
    return { http: `${page.protocol}//${override}`, ws: `${wsProto}://${override}` }
  }
  if (!dev) return { http: '', ws: `${wsProto}://${page.host}` }
  return {
    http: `${page.protocol}//${page.hostname}:${DEV_PORT}`,
    ws: `ws://${page.hostname}:${DEV_PORT}`,
  }
}

// Import-safe under vitest's node environment (no `location` there): tests
// import the pure resolver above; a real page always has a location.
const loc: PageLocation & { search: string } =
  typeof location === 'undefined'
    ? { protocol: 'http:', host: 'localhost', hostname: 'localhost', search: '' }
    : location

const params = new URLSearchParams(loc.search)
const override = params.get('server')
const token = params.get('token') ?? ''

const bases = resolveServer(override, import.meta.env.DEV, loc)

export const serverHttp = bases.http

export const serverWs = `${bases.ws}/ws`

/** WS origin without the /ws suffix — for other WS endpoints on the same
 *  server (the terminal drawer builds `${serverWsBase}/term?session=…`). */
export const serverWsBase = bases.ws

export const withToken = (url: string): string =>
  token ? `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : url

/** Same-origin viewer navigation (/ ↔ /mesh) that keeps the ?server= and
 *  ?token= overrides alive across routes — they configure the API, not the
 *  page, and losing them on a route change would silently break auth. */
export const viewerHref = (path: string): string => {
  const keep = new URLSearchParams()
  if (override) keep.set('server', override)
  if (token) keep.set('token', token)
  const q = keep.toString()
  return q ? `${path}?${q}` : path
}
