/**
 * Node switch: always re-point the local gateway client so the fast local
 * (or bundled) UI stays put. The node drives the UI underneath — never
 * navigate to a peer's served dist over the mesh.
 */

import { gatewayOrigin } from './gateway-url.js'

/**
 * Re-point the gateway to the chosen roster/mesh hub URL via switchTo.
 * Returns the canonicalized origin, or null when the URL is not a valid
 * http(s) origin (#304 / #330 — no path/query/hash, no userinfo).
 */
export function performNodeSwitch(hubUrl: string, switchTo: (url: string) => void): string | null {
  const origin = gatewayOrigin(hubUrl)
  if (!origin) return null
  switchTo(origin)
  return origin
}
