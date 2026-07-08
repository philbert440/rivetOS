/**
 * Node-switch capability: browser Hub navigates to the peer origin;
 * Tauri desktop re-points the local gateway client (local shell stays).
 */

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
 * - navigate: caller should assign window.location (or equivalent)
 * - repoint: caller should call connection.switchTo(url)
 */
export function resolveNodeSwitch(
  hubUrl: string,
  g: { __TAURI__?: unknown } = globalThis as { __TAURI__?: unknown },
): { mode: NodeSwitchMode; url: string } {
  const url = hubUrl.trim().replace(/\/+$/, '')
  return { mode: nodeSwitchMode(g), url }
}
