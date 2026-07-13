/**
 * Node-switch capability: always re-point the local gateway client so the
 * fast local (or bundled) UI stays put. The node drives the UI underneath —
 * never navigate to a peer's served dist over the mesh.
 */

import { gatewayOrigin } from './gateway-url.js'

/** Kept for callers that branch on mode; only `'repoint'` is produced. */
export type NodeSwitchMode = 'navigate' | 'repoint'

/** True when running inside the Tauri shell (withGlobalTauri). */
export function isTauriShell(
  g: { __TAURI__?: unknown } = globalThis as { __TAURI__?: unknown },
): boolean {
  return g.__TAURI__ != null
}

/**
 * Always repoint — desktop Tauri, browser Hub, and Android WebView all keep
 * the local dist and rebuild the gateway to the chosen node's baseUrl.
 * (`'navigate'` remains in the type for callers; it is never returned.)
 */
export function nodeSwitchMode(
  _g: { __TAURI__?: unknown } = globalThis as { __TAURI__?: unknown },
): NodeSwitchMode {
  return 'repoint'
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

/**
 * Perform a node switch for the current shell: re-point the gateway via
 * switchTo so the local UI stays put. Returns null when rejected (invalid URL).
 *
 * `opts.navigate` is accepted for API compatibility but never invoked.
 */
export function performNodeSwitch(
  hubUrl: string,
  switchTo: (url: string) => void,
  opts?: {
    g?: { __TAURI__?: unknown }
    /** @deprecated No longer used — switch always repoints. */
    navigate?: (url: string) => void
    /** @deprecated No longer used — switch always repoints. */
    currentOrigin?: string
  },
): { mode: NodeSwitchMode; url: string } | null {
  const g = opts?.g ?? (globalThis as { __TAURI__?: unknown })
  const resolved = resolveNodeSwitch(hubUrl, g)
  if (!resolved) return null
  switchTo(resolved.url)
  return resolved
}
