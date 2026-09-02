/**
 * Pull the live Omarchy `colors.toml` through the desktop shell and park it
 * on the theme store. Called at boot and on window focus (throttled) so
 * switching themes in Omarchy and alt-tabbing back restyles the hub.
 *
 * No `window` access at module-eval time — only inside installOmarchySync.
 */

import { rivetShell as getRivetShell, type RivetShell } from './shell-bridge.js'
import { parseOmarchyColors } from './omarchy-theme.js'
import { useTheme, type OmarchySnapshot } from '../stores/theme.js'

const FOCUS_THROTTLE_MS = 2000

type OmarchyStore = {
  getState: () => {
    omarchy: OmarchySnapshot | null
    setOmarchy: (v: OmarchySnapshot | null) => void
  }
}

export async function syncOmarchyTheme(
  shell: RivetShell | undefined = getRivetShell(),
  store: OmarchyStore = useTheme,
): Promise<boolean> {
  if (!shell?.readTerminalConfigs) return false
  let configs: Awaited<ReturnType<NonNullable<RivetShell['readTerminalConfigs']>>>
  try {
    configs = await shell.readTerminalConfigs()
  } catch {
    return false
  }
  const entry = configs.find((c) => c.kind === 'omarchy' && c.colorsToml)
  if (!entry?.colorsToml) return false
  const colors = parseOmarchyColors(entry.colorsToml)
  if (!colors) return false
  const next: OmarchySnapshot = entry.themeName ? { name: entry.themeName, colors } : { colors }
  const current = store.getState().omarchy
  if (
    current &&
    current.name === next.name &&
    JSON.stringify(current.colors) === JSON.stringify(colors)
  ) {
    return true
  }
  store.getState().setOmarchy(next)
  return true
}

export function installOmarchySync(
  win: { addEventListener(type: string, listener: () => void): void } = window,
): void {
  void syncOmarchyTheme()
  let last = Number.NEGATIVE_INFINITY
  win.addEventListener('focus', () => {
    const now = Date.now()
    if (now - last < FOCUS_THROTTLE_MS) return
    last = now
    void syncOmarchyTheme()
  })
}
