/**
 * TerminalImport → the patch the settings store takes. Pure, so the Apply
 * button's behaviour (and its disabled state) is unit-testable without a DOM
 * — the Settings section only wires this to `useTerminalSettings.update`.
 *
 * The patch is also what the preview renders, so this function is the single
 * definition of "what Apply will do". That is why the numeric clamping uses
 * the STORE's own limits: if the preview clamped differently the user would
 * be shown a font size the store would then refuse.
 */

import { TERMINAL_LIMITS } from '../../stores/terminal-settings.js'
import { isTerminalPalette, type TerminalPalette } from '../terminal-schemes.js'
import type { EmulatorKind, TerminalConfigFile, TerminalImport } from './types.js'

export interface TerminalImportPatch {
  fontFamily?: string
  fontSize?: number
  lineHeight?: number
  imported?: TerminalPalette
  /** Only set alongside `imported` — the store demotes an `imported` source
   *  with no palette back to `app`, so promising it without one would make
   *  the Apply silently do nothing to the theme. */
  themeSource?: 'imported'
}

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v))

/** A number the store will accept unchanged, or undefined. `round` mirrors
 *  the store's own integer coercion for font size. */
function usable(
  v: unknown,
  limits: { min: number; max: number },
  round: boolean,
): number | undefined {
  // Non-finite and non-positive values are omitted rather than slammed to the
  // clamp min — applying font size 8 because the parse produced 0 would be a
  // change the user never asked for. Out-of-range *positive* sizes clamp to
  // the store's own limits (not a looser preview range) so the preview is
  // exactly what Apply writes.
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return undefined
  const clamped = clamp(v, limits.min, limits.max)
  return round ? Math.round(clamped) : clamped
}

export function importPatch(imp: TerminalImport): TerminalImportPatch {
  const patch: TerminalImportPatch = {}
  if (imp.fontFamily?.trim()) patch.fontFamily = imp.fontFamily.trim()
  const fontSize = usable(imp.fontSize, TERMINAL_LIMITS.fontSize, true)
  if (fontSize !== undefined) patch.fontSize = fontSize
  const lineHeight = usable(imp.lineHeight, TERMINAL_LIMITS.lineHeight, false)
  if (lineHeight !== undefined) patch.lineHeight = lineHeight
  // Re-validate rather than trust the parser: this is the last gate before a
  // palette reaches persisted state and xterm's theme.
  if (isTerminalPalette(imp.palette)) {
    patch.imported = imp.palette
    patch.themeSource = 'imported'
  }
  return patch
}

/** Whether Apply would change anything — drives the button's disabled state. */
export function canApply(imp: TerminalImport): boolean {
  return Object.keys(importPatch(imp)).length > 0
}

/** Palette-missing / partial-ANSI warnings from finishPalette. Dropped from
 *  the emulator side when Omarchy supplies a complete palette — otherwise
 *  they sit next to a good theme and look like a failed import. */
const PALETTE_WARNING = /no palette found|incomplete .*\bpalette\b/i

function tagWarnings(source: string, warnings: readonly string[]): string[] {
  return warnings.map((w) => `[${source}] ${w}`)
}

/**
 * The emulator whose fonts pair with an Omarchy palette import.
 *
 * Prefer the one main flagged `usesOmarchy` (an include realpath under the
 * current theme dir). Fall back to the first non-omarchy file, which is
 * candidate order: ghostty → alacritty → kitty.
 */
export function omarchyFontPartner(
  files: readonly TerminalConfigFile[],
): TerminalConfigFile | undefined {
  const emulators = files.filter((c) => c.kind !== 'omarchy')
  return emulators.find((c) => c.usesOmarchy) ?? emulators[0]
}

/**
 * Merge an emulator import with an Omarchy theme import.
 *
 * Fonts live in the emulator config; the palette lives in the Omarchy theme
 * dir. Emulator fields win for fontFamily/fontSize/lineHeight; Omarchy's
 * palette (when complete) replaces the emulator's. Remaining warnings are
 * prefixed with their source (`[ghostty] …`, `[omarchy] …`).
 */
export function combineImports(
  emulator: TerminalImport,
  omarchy: TerminalImport,
  emulatorKind: EmulatorKind,
): TerminalImport {
  const emuWarnings =
    omarchy.palette !== undefined
      ? emulator.warnings.filter((w) => !PALETTE_WARNING.test(w))
      : emulator.warnings
  const result: TerminalImport = {
    warnings: [
      ...tagWarnings(emulatorKind, emuWarnings),
      ...tagWarnings('omarchy', omarchy.warnings),
    ],
  }
  const fontFamily = emulator.fontFamily ?? omarchy.fontFamily
  if (fontFamily) result.fontFamily = fontFamily
  const fontSize = emulator.fontSize ?? omarchy.fontSize
  if (fontSize !== undefined) result.fontSize = fontSize
  const lineHeight = emulator.lineHeight ?? omarchy.lineHeight
  if (lineHeight !== undefined) result.lineHeight = lineHeight
  const palette = omarchy.palette ?? emulator.palette
  if (palette) result.palette = palette
  return result
}
