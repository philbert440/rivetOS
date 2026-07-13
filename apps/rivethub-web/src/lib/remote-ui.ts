/**
 * Last-active node persistence for the thin/bundled shell.
 *
 * Historically the desktop shell redirected (`location.replace`) to the
 * configured node's live-served dist so updates rode mesh deploy. That is
 * gone: the local/bundled UI always stays put and only the gateway baseUrl
 * is repointed (see connection store + switch-mode).
 *
 * `rivethub.remoteUi` is still written so a stored last-active can be adopted
 * at boot without a full-page navigation. Escape hatch `?local=1` skips
 * adopting a stored remote target (debugging).
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
 * Pure decision helper (tests / call sites). Always false now — we never
 * full-page redirect to a remote dist.
 */
export function shouldRedirect(_opts: {
  bundled: boolean
  localOverride: boolean
  target: string | undefined
  probeOk: boolean
}): boolean {
  return false
}

/**
 * Boot-time hook, awaited before React mounts.
 *
 * Never navigates away from the local/bundled dist. If a last-active remote
 * is stored and the connection store has not already adopted it (empty
 * baseUrl under a bundled origin), repoints via setConnection and stays.
 * Always returns `'stay'` so the caller mounts React.
 *
 * `'redirecting'` remains in the return type for call-site compatibility
 * but is never produced.
 */
export function maybeRedirectToRemoteUi(
  apply?: (baseUrl: string) => void,
): Promise<'redirecting' | 'stay'> {
  if (typeof window === 'undefined') return Promise.resolve('stay')

  const bundled = isBundledOrigin(window.location.origin, window.location.protocol)
  const localOverride = new URLSearchParams(window.location.search).has('local')
  const target = storedRemoteUi(localStorage)

  // Persist last-active into the connection store when bundled and empty —
  // defaultBaseUrl() already reads rivethub.baseUrl; this covers the legacy
  // rivethub.remoteUi-only case without a document navigation.
  if (bundled && !localOverride && target && apply) {
    apply(target)
  }

  return Promise.resolve('stay')
}
