/**
 * Node-switch capability: always re-point the local gateway client so the
 * fast local (or bundled) UI stays put. The node drives the UI underneath —
 * never navigate to a peer's served dist over the mesh.
 */

import { gatewayOrigin } from './gateway-url.js'

/** Only one switch mode exists: repoint. */
export type NodeSwitchMode = 'repoint'

/** True when running inside the Tauri shell (withGlobalTauri). */
export function isTauriShell(
  g: { __TAURI__?: unknown } = globalThis as { __TAURI__?: unknown },
): boolean {
  return g.__TAURI__ != null
}

/**
 * Always repoint — desktop Tauri, browser Hub, and Android WebView all keep
 * the local dist and rebuild the gateway to the chosen node's baseUrl.
 */
export function nodeSwitchMode(): NodeSwitchMode {
  return 'repoint'
}

/**
 * Resolve what to do when the user picks a roster/mesh hub URL.
 * Returns null when the URL is not a valid http(s) origin (#304 / #330).
 * Always canonicalizes to `origin` (no path/query/hash).
 */
export function resolveNodeSwitch(hubUrl: string): { mode: NodeSwitchMode; url: string } | null {
  const origin = gatewayOrigin(hubUrl)
  if (!origin) return null
  return { mode: nodeSwitchMode(), url: origin }
}

/**
 * Perform a node switch for the current shell: re-point the gateway via
 * switchTo so the local UI stays put. Returns null when rejected (invalid URL).
 *
 */
export function performNodeSwitch(
  hubUrl: string,
  switchTo: (url: string) => void,
): { mode: NodeSwitchMode; url: string } | null {
  const resolved = resolveNodeSwitch(hubUrl)
  if (!resolved) return null
  switchTo(resolved.url)
  return resolved
}
