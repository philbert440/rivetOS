/**
 * Node-switch capability: browser Hub opens the peer origin in a new tab
 * (current chat/turn stays put); Tauri desktop re-points the local gateway
 * client (local shell stays).
 */

import { gatewayOrigin } from './gateway-url.js'

export type NodeSwitchMode = 'navigate' | 'repoint'

/** True when running inside the Tauri shell (withGlobalTauri). */
export function isTauriShell(
  g: { __TAURI__?: unknown } = globalThis as { __TAURI__?: unknown },
): boolean {
  return g.__TAURI__ != null
}

export function nodeSwitchMode(
  g: { __TAURI__?: unknown } = globalThis as { __TAURI__?: unknown },
): NodeSwitchMode {
  return isTauriShell(g) ? 'repoint' : 'navigate'
}

/**
 * Resolve what to do when the user picks a roster/mesh hub URL.
 * Returns null when the URL is not a valid http(s) origin (#304 / #330).
 * Always canonicalizes to `origin` (no path/query/hash).
 */
export function resolveNodeSwitch(
  hubUrl: string,
  g: { __TAURI__?: unknown } = globalThis as { __TAURI__?: unknown },
): { mode: NodeSwitchMode; url: string } | null {
  const origin = gatewayOrigin(hubUrl)
  if (!origin) return null
  return { mode: nodeSwitchMode(g), url: origin }
}

/** Default browser action: new tab so mid-turn chat isn't torn down. */
export function openHubInNewTab(target: string): void {
  if (typeof window !== 'undefined' && typeof window.open === 'function') {
    // noopener: don't give the new tab a handle back to this document
    window.open(target, '_blank', 'noopener,noreferrer')
    return
  }
  // non-browser fallback (tests / SSR) — same-tab last resort
  if (typeof location !== 'undefined') {
    if (typeof location.assign === 'function') location.assign(target)
    else location.href = target
  }
}

/**
 * Perform a node switch for the current shell.
 * Browser: open peer hub origin in a **new tab** (this page keeps live chat).
 * Tauri: API re-point via switchTo so the local shell stays put.
 * Same-origin browser switch is a no-op (don't open a duplicate tab of self).
 * Returns null when rejected (invalid URL).
 */
export function performNodeSwitch(
  hubUrl: string,
  switchTo: (url: string) => void,
  opts?: {
    g?: { __TAURI__?: unknown }
    /** Override browser open (tests inject a spy). Default: window.open new tab. */
    navigate?: (url: string) => void
    /** Current origin for same-origin no-op (defaults to location.origin) */
    currentOrigin?: string
  },
): { mode: NodeSwitchMode; url: string } | null {
  const g = opts?.g ?? (globalThis as { __TAURI__?: unknown })
  const resolved = resolveNodeSwitch(hubUrl, g)
  if (!resolved) return null
  const { mode, url } = resolved
  if (mode === 'navigate') {
    const here =
      opts?.currentOrigin ?? (typeof location !== 'undefined' ? location.origin : undefined)
    if (here && url === here) {
      // Already on this hub — don't open a redundant tab
      return { mode, url }
    }
    const go = opts?.navigate ?? openHubInNewTab
    go(url)
  } else {
    switchTo(url)
  }
  return { mode, url }
}
