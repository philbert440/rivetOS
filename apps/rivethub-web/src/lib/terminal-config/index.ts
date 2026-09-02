/**
 * Emulator config importer (T4) — one entry point over the four parsers.
 *
 * The desktop shell reads bytes (`rivetShell.readTerminalConfigs()`); every
 * format decision happens here in the renderer so the parsers stay pure and
 * fixture-tested, and so web/mobile can use the same code for a pasted
 * palette.
 *
 * Everything exported from here is failure-tolerant on purpose: these run
 * inside click handlers on the Settings tree, where an exception from a
 * malformed config would blank the page instead of showing a warning. The raw
 * parsers still throw; the wrappers below turn that into a warning.
 */

import { parseAlacritty } from './alacritty.js'
import { isUnsafeKey } from './common.js'
import { parseGhostty } from './ghostty.js'
import { parseKitty } from './kitty.js'
import { parsePastedPalette as parsePastedPaletteRaw } from './paste.js'
import { parseWindowsTerminal } from './windows-terminal.js'
import {
  EMULATOR_LABELS,
  type EmulatorKind,
  type TerminalConfigFile,
  type TerminalImport,
} from './types.js'

export { parseAlacritty, detectAlacrittyFormat, type AlacrittyFormat } from './alacritty.js'
export { parseGhostty } from './ghostty.js'
export { parseKitty } from './kitty.js'
export { parseWindowsTerminal } from './windows-terminal.js'
export { canApply, importPatch, type TerminalImportPatch } from './apply.js'
export {
  EMULATOR_LABELS,
  type EmulatorKind,
  type TerminalConfigFile,
  type TerminalImport,
} from './types.js'

/** Same cap main enforces per file — re-checked here because the renderer
 *  must not trust a payload just because it arrived over the bridge. */
export const MAX_IMPORT_TEXT_BYTES = 256 * 1024

/** Absurd numbers of files, or of include entries, are a broken shell rather
 *  than a real config directory. */
const MAX_IMPORT_FILES = 16
const MAX_IMPORT_INCLUDES = 16

function isEmulatorKind(v: unknown): v is EmulatorKind {
  return typeof v === 'string' && Object.hasOwn(EMULATOR_LABELS, v)
}

/** Runtime check for the IPC payload — `as TerminalConfigFile` would leave
 *  `includes` as `any` from a JSON-shaped object. */
function isTerminalConfigFile(x: unknown): x is TerminalConfigFile {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false
  if (!('kind' in x) || !isEmulatorKind(x.kind)) return false
  if (!('path' in x) || typeof x.path !== 'string') return false
  if (!('text' in x) || typeof x.text !== 'string') return false
  if (x.text.length > MAX_IMPORT_TEXT_BYTES) return false
  return true
}

/**
 * Validate the IPC payload before parsing it. The bridge is trusted to be the
 * real shell, but "trusted" is not "type-checked": a version skew between an
 * older installed shell and this dist would otherwise surface as a TypeError
 * deep inside a parser.
 */
export function sanitizeConfigFiles(raw: unknown): TerminalConfigFile[] {
  if (!Array.isArray(raw)) return []
  const out: TerminalConfigFile[] = []
  for (const item of raw.slice(0, MAX_IMPORT_FILES)) {
    if (!isTerminalConfigFile(item)) continue
    const includes: Record<string, string> = Object.create(null) as Record<string, string>
    const rawIncludes: unknown = item.includes
    if (typeof rawIncludes === 'object' && rawIncludes !== null && !Array.isArray(rawIncludes)) {
      for (const [key, value] of Object.entries(rawIncludes).slice(0, MAX_IMPORT_INCLUDES)) {
        if (isUnsafeKey(key)) continue
        if (typeof value === 'string' && value.length <= MAX_IMPORT_TEXT_BYTES) {
          includes[key] = value
        }
      }
    }
    out.push({ kind: item.kind, path: item.path.slice(0, 1024), text: item.text, includes })
  }
  return out
}

/** Any parser fault becomes a warning the preview can show. */
function guarded(run: () => TerminalImport): TerminalImport {
  try {
    return run()
  } catch (err) {
    return {
      warnings: [`Could not read this config: ${err instanceof Error ? err.message : String(err)}`],
    }
  }
}

/**
 * Parse one config file. `includes` is only meaningful for the formats that
 * have an include mechanism — Windows Terminal's settings.json is always a
 * single file, so its entry carries an empty map.
 */
export function detectAndParse(
  kind: EmulatorKind,
  files: { text: string; includes?: Record<string, string>; path?: string },
): TerminalImport {
  const includes = files.includes ?? {}
  return guarded(() => {
    switch (kind) {
      case 'ghostty':
        return parseGhostty(files.text, { includes })
      case 'kitty':
        return parseKitty(files.text, { includes })
      case 'alacritty':
        return parseAlacritty(files.text, { includes, path: files.path })
      case 'windows-terminal':
        // Windows Terminal has no include mechanism — settings.json is always
        // a single file, so `files.includes` is ignored even if the shell sent
        // one.
        return parseWindowsTerminal(files.text)
      default:
        // Unreachable through the union, but the payload crosses an IPC
        // boundary — a skewed shell must get a warning, not `undefined`.
        return { warnings: [`Unknown emulator config kind \`${String(kind)}\`.`] }
    }
  })
}

/** The paste box's parser, with the same no-throw contract. */
export function parsePastedPalette(text: string): TerminalImport {
  return guarded(() => parsePastedPaletteRaw(text))
}
