/**
 * Gateway / hub URL guards (#304 poisoned roster/mesh).
 * Accept only bare http(s) origins — no userinfo, no path/query/hash.
 */

export function isValidGatewayUrl(url: string): boolean {
  try {
    const u = new URL(url.trim())
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
    if (!u.host) return false
    // Reject credentialed URLs: http://127.0.0.1@evil.com → host evil.com
    if (u.username || u.password) return false
    // Origin-only: empty path or "/", no query/hash
    const path = u.pathname === '' || u.pathname === '/'
    if (!path || u.search || u.hash) return false
    return true
  } catch {
    return false
  }
}

/**
 * Canonical hub base for switch / storage: scheme://host[:port] only.
 * Accepts trailing slash (common in mesh denUrl) and strips path/query/hash
 * only when path is exactly `/` — deeper paths still fail isValidGatewayUrl.
 */
export function gatewayOrigin(url: string): string | null {
  const raw = url.trim()
  // Allow a single trailing slash for origin URLs: http://host:port/
  const candidate = raw.replace(/\/+$/, '') || raw
  // Re-check with and without slash so pathname is `/` or empty-equivalent
  if (isValidGatewayUrl(candidate) || isValidGatewayUrl(candidate + '/')) {
    try {
      return new URL(candidate.includes('://') ? candidate : raw).origin
    } catch {
      return null
    }
  }
  return null
}
