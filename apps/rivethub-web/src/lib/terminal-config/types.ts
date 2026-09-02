/**
 * Shared shape for the emulator-config importers (T4).
 *
 * Every parser is pure text → `TerminalImport`, so the four formats stay
 * fixture-testable without Electron, a filesystem, or an xterm instance. The
 * desktop IPC only supplies bytes (`main/terminal-config.ts`); all format
 * knowledge lives here in the renderer.
 */

import type { TerminalPalette } from '../terminal-schemes.js'

export type EmulatorKind = 'ghostty' | 'alacritty' | 'kitty' | 'windows-terminal'

export const EMULATOR_LABELS: Record<EmulatorKind, string> = {
  ghostty: 'Ghostty',
  alacritty: 'Alacritty',
  kitty: 'kitty',
  'windows-terminal': 'Windows Terminal',
}

/**
 * A parsed config. Every field is optional except `warnings`: a config that
 * only sets a font still imports usefully, and `palette` is present ONLY when
 * all 16 ANSI slots plus foreground and background were found — a partial
 * palette handed to xterm would silently mix the user's colors with the
 * emulator defaults, which looks like a bug rather than a partial import.
 */
export interface TerminalImport {
  fontFamily?: string
  fontSize?: number
  lineHeight?: number
  palette?: TerminalPalette
  warnings: string[]
}

/** One config file as read by the desktop shell (preload `readTerminalConfigs`). */
export interface TerminalConfigFile {
  kind: EmulatorKind
  /** Absolute path of the file that was read — shown in the UI so the user
   *  can tell which of several installs was picked up. */
  path: string
  text: string
  /** `include` / `config-file` targets resolved by main, keyed by the raw
   *  directive value so the parser can splice them at the right point.
   *  Windows Terminal has no include mechanism — settings.json is always a
   *  single file, so this map is empty for that kind. */
  includes: Record<string, string>
}
