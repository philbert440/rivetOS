/**
 * Thin-shell cutover: the desktop shell bundles a dist at build time, which
 * goes stale invisibly (mesh deploys don't rebuild the Tauri binary). Fix:
 * the BUNDLED app redirects itself to the configured node's live-served UI
 * (den-server serves rivethub-web) whenever that node is reachable — web
 * updates then ride `rivetos update --mesh`, and the bundled dist demotes to
 * a first-run / node-down fallback.
 *
 * The fallback logic deliberately lives HERE, not in the shell: a client-side
 * probe + `location.replace` is trivially testable and keeps the shell dumb.
 * Only relevant under a non-http origin (tauri://localhost); browsers are
 * already served by a node and never redirect.
 *
 * Escape hatch: `?local=1` skips the redirect (debugging a broken node dist
 * from the bundled app).
 */

import { isValidGatewayUrl } from './gateway-url.js'

const REMOTE_UI_KEY = 'rivethub.remoteUi'

export function isBundledOrigin(origin: string, protocol: string): boolean {
  // tauri://localhost (linux/macOS); http://tauri.localhost (windows) parses
  // as a legit http origin, so it needs its own case. Anything else that is
  // not a valid http(s) gateway origin is also treated as bundled.
  if (protocol === 'tauri:') return true
  if (/^https?:\/\/tauri\.localhost(?::\d+)?$/.test(origin)) return true
  return !isValidGatewayUrl(origin)
}

/** The node UI url the bundled shell should boot into, if any. */
export function storedRemoteUi(storage: Pick<Storage, 'getItem'>): string | undefined {
  const raw = storage.getItem(REMOTE_UI_KEY)
  if (!raw) return undefined
  const url = raw.trim().replace(/\/+$/, '')
  return isValidGatewayUrl(url) ? url : undefined
}

/** Remember (under the BUNDLED origin's storage) which node UI to boot into. */
export function rememberRemoteUi(storage: Pick<Storage, 'setItem'>, url: string): void {
  const clean = url.trim().replace(/\/+$/, '')
  if (isValidGatewayUrl(clean)) storage.setItem(REMOTE_UI_KEY, clean)
}

/**
 * Pure decision: redirect only when bundled, not escape-hatched, a valid
 * target is stored, and the probe says the node is up.
 */
export function shouldRedirect(opts: {
  bundled: boolean
  localOverride: boolean
  target: string | undefined
  probeOk: boolean
}): boolean {
  return opts.bundled && !opts.localOverride && opts.target !== undefined && opts.probeOk
}

/**
 * Boot-time hook, awaited before React mounts. Returns 'redirecting' when a
 * navigation to the node UI has been issued (caller should NOT mount).
 */
export async function maybeRedirectToRemoteUi(): Promise<'redirecting' | 'stay'> {
  const bundled = isBundledOrigin(window.location.origin, window.location.protocol)
  if (!bundled) return 'stay'
  const localOverride = new URLSearchParams(window.location.search).has('local')
  const target = storedRemoteUi(localStorage)
  if (!target || localOverride) return 'stay'

  let probeOk = false
  try {
    const res = await fetch(`${target}/healthz`, { signal: AbortSignal.timeout(1500) })
    probeOk = res.ok
  } catch {
    probeOk = false // node down → stay on the bundled fallback
  }

  if (!shouldRedirect({ bundled, localOverride, target, probeOk })) return 'stay'
  window.location.replace(`${target}/`)
  return 'redirecting'
}
