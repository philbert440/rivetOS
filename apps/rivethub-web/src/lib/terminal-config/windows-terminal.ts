/**
 * Windows Terminal (`settings.json`, JSON-with-comments).
 *
 * Stock settings leave `profiles.defaults` empty and put `colorScheme` / font
 * on `profiles.list[]`, selected by root `defaultProfile`. The active profile
 * is defaults merged with that list entry (else the first entry).
 *
 * Built-in schemes (Campbell, …) are not copied into the user's `schemes`
 * array on current WT, so a name that isn't there is resolved against the
 * nine palettes in `windows-terminal-builtins.ts`. When no scheme is named,
 * WT uses Campbell.
 *
 * Two spellings of each matter in the wild: the pre-1.15 flat
 * `fontFace`/`fontSize`, and the light/dark pair form of `colorScheme`.
 *
 * Windows Terminal calls ANSI 5 and 13 `purple`/`brightPurple` where xterm
 * says magenta — same slot, different name.
 */

import {
  finishPalette,
  fontStack,
  lineHeightFromPercent,
  MAX_PARSER_CHARS,
  newPaletteDraft,
  normalizeHex,
  oversizedWarning,
  positiveNumber,
  setAnsi,
  stripBom,
  type PaletteDraft,
} from './common.js'
import { parseJsonc } from './jsonc.js'
import type { TerminalImport } from './types.js'
import {
  WINDOWS_TERMINAL_BUILTINS,
  WINDOWS_TERMINAL_DEFAULT_SCHEME,
  type WindowsTerminalBuiltinScheme,
} from './windows-terminal-builtins.js'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

const SCHEME_KEYS = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'purple',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightPurple',
  'brightCyan',
  'brightWhite',
] as const

/** `"One Half Dark"` or `{ "dark": …, "light": … }` — dark wins, matching the
 *  hub's own default appearance. When both halves are named, the light
 *  scheme is ignored with a warning that names both. */
function schemeName(raw: unknown, warnings: string[]): string | undefined {
  if (typeof raw === 'string') return raw
  if (isObj(raw)) {
    const dark = raw.dark
    const light = raw.light
    if (typeof dark === 'string' && typeof light === 'string') {
      warnings.push(
        `colorScheme pair names dark \`${dark}\` and light \`${light}\`; the light scheme was ignored.`,
      )
    }
    if (typeof dark === 'string') return dark
    if (typeof light === 'string') return light
  }
  return undefined
}

/** defaults ← list entry: nested `font` is merged so a list `font.size`
 *  doesn't wipe a defaults `font.face`. */
function mergeProfile(defaults: Obj, listed: Obj): Obj {
  const font: Obj = {
    ...(isObj(defaults.font) ? defaults.font : {}),
    ...(isObj(listed.font) ? listed.font : {}),
  }
  const out: Obj = { ...defaults, ...listed }
  if (Object.keys(font).length > 0) out.font = font
  return out
}

function activeProfile(root: Obj): Obj {
  const profiles = isObj(root.profiles) ? root.profiles : {}
  const defaults = isObj(profiles.defaults) ? profiles.defaults : {}
  const list = Array.isArray(profiles.list) ? profiles.list.filter(isObj) : []
  const guid = root.defaultProfile
  const listed =
    (typeof guid === 'string' ? list.find((p) => p.guid === guid) : undefined) ?? list.at(0) ?? {}
  return mergeProfile(defaults, listed)
}

function readCellHeight(raw: unknown, warnings: string[]): number | undefined {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw > 0 ? raw : undefined
  }
  if (typeof raw !== 'string') return undefined
  const v = raw.trim()
  if (/px$/i.test(v)) {
    warnings.push('`font.cellHeight` in pixels was ignored.')
    return undefined
  }
  if (v.endsWith('%')) return lineHeightFromPercent(v, 'absolute', warnings)
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

function findScheme(
  schemes: Obj[],
  wanted: string,
): Obj | WindowsTerminalBuiltinScheme | undefined {
  const user = schemes.find((s) => s.name === wanted)
  if (user) return user
  // Plain-object index would resolve `toString` / `constructor` via the
  // prototype and skip the "matches neither" warning.
  if (!Object.hasOwn(WINDOWS_TERMINAL_BUILTINS, wanted)) return undefined
  return WINDOWS_TERMINAL_BUILTINS[wanted]
}

export function parseWindowsTerminal(text: string): TerminalImport {
  text = stripBom(text)
  if (text.length > MAX_PARSER_CHARS) return { warnings: [oversizedWarning('config')] }
  const warnings: string[] = []
  let root: unknown
  try {
    root = parseJsonc(text)
  } catch (err) {
    return {
      warnings: [
        `Could not read settings.json: ${err instanceof Error ? err.message : String(err)}`,
      ],
    }
  }
  if (!isObj(root)) return { warnings: ['settings.json did not contain a JSON object.'] }

  const active = activeProfile(root)
  const font = isObj(active.font) ? active.font : {}

  const families: string[] = []
  const face = font.face ?? active.fontFace
  if (typeof face === 'string') families.push(face)

  const result: TerminalImport = { warnings }
  const stack = fontStack(families)
  if (stack) result.fontFamily = stack
  const size = positiveNumber(font.size ?? active.fontSize)
  if (size !== undefined) result.fontSize = size
  const cellHeight = readCellHeight(font.cellHeight ?? active.cellHeight, warnings)
  if (cellHeight !== undefined) result.lineHeight = cellHeight

  const named = schemeName(active.colorScheme, warnings)
  const wanted = named ?? WINDOWS_TERMINAL_DEFAULT_SCHEME
  const schemes = Array.isArray(root.schemes) ? root.schemes.filter(isObj) : []
  const scheme = findScheme(schemes, wanted)
  if (!scheme) {
    warnings.push(
      `Color scheme \`${wanted}\` matches neither a built-in scheme nor one in this settings.json.`,
    )
    return result
  }

  const draft: PaletteDraft = newPaletteDraft()
  const color = (key: string): string | undefined => {
    const raw = scheme[key as keyof typeof scheme]
    if (raw === undefined) return undefined
    const hex = normalizeHex(raw, warnings)
    if (!hex) warnings.push(`Could not read \`${wanted}.${key}\` as a color.`)
    return hex
  }
  draft.foreground = color('foreground')
  draft.background = color('background')
  draft.cursor = color('cursorColor')
  draft.selectionBackground = color('selectionBackground')
  SCHEME_KEYS.forEach((key, i) => {
    setAnsi(draft, i, color(key))
  })

  const palette = finishPalette(draft, warnings, `\`${wanted}\` palette`)
  if (palette) result.palette = palette
  return result
}
