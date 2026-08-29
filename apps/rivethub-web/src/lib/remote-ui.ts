/**
 * Last-active node persistence for the thin/bundled shell. The local/bundled
 * UI always stays put; only the gateway baseUrl is repointed (connection
 * store + switch-mode). `rivethub.remoteUi` lets a stored last-active be
 * adopted at boot without navigation. Escape hatch `?local=1` skips adopting
 * a stored remote target (debugging).
 */

import { isValidGatewayUrl } from './gateway-url.js'

const REMOTE_UI_KEY = 'rivethub.remoteUi'

export function isBundledOrigin(origin: string, protocol: string): boolean {
  // app://bundle (Electron shell). Anything else that is not a valid
  // http(s) gateway origin is also treated as bundled.
  if (protocol === 'app:') return true
  return !isValidGatewayUrl(origin)
}

/** The node the bundled shell last pointed at, if any. */
export function storedRemoteUi(storage: Pick<Storage, 'getItem'>): string | undefined {
  const raw = storage.getItem(REMOTE_UI_KEY)
  if (!raw) return undefined
  const url = raw.trim().replace(/\/+$/, '')
  return isValidGatewayUrl(url) ? url : undefined
}

/** Remember which node was last active (no navigation). */
export function rememberRemoteUi(storage: Pick<Storage, 'setItem'>, url: string): void {
  const clean = url.trim().replace(/\/+$/, '')
  if (isValidGatewayUrl(clean)) storage.setItem(REMOTE_UI_KEY, clean)
}

/**
 * Boot-time hook, awaited before React mounts. Never navigates away from the
 * local/bundled dist: if a last-active remote is stored and the connection
 * store has not already adopted it (empty baseUrl under a bundled origin),
 * repoints via setConnection and stays.
 */
export function adoptStoredRemoteUi(apply?: (baseUrl: string) => void): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve()

  const bundled = isBundledOrigin(window.location.origin, window.location.protocol)
  const localOverride = new URLSearchParams(window.location.search).has('local')
  const target = storedRemoteUi(localStorage)

  // Persist last-active into the connection store when bundled and empty —
  // defaultBaseUrl() already reads rivethub.baseUrl; this covers the legacy
  // rivethub.remoteUi-only case without a document navigation.
  if (bundled && !localOverride && target && apply) {
    apply(target)
  }

  return Promise.resolve()
}
