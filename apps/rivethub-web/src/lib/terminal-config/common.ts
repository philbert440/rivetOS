/**
 * Format-agnostic helpers shared by the four emulator parsers.
 *
 * Colors: every emulator writes hex in a slightly different dialect
 * (`#rrggbb`, `#rgb`, bare `rrggbb`, Alacritty's legacy `0x1d1f21`), and
 * xterm's theme parser silently ignores anything it doesn't understand — so
 * everything is normalised to lower-case `#rrggbb` here, once, and anything
 * that fails to normalise becomes a warning instead of a half-applied theme.
 */

import type { TerminalPalette } from '../terminal-schemes.js'

/** Strip one layer of matching quotes — every format allows quoting values. */
export function unquote(raw: string): string {
  const v = raw.trim()
  if (v.length >= 2) {
    const q = v[0]
    if ((q === '"' || q === "'") && v.endsWith(q)) return v.slice(1, -1)
  }
  return v
}

const HEX6 = /^[0-9a-f]{6}$/i
const HEX3 = /^[0-9a-f]{3}$/i
const HEX4 = /^[0-9a-f]{4}$/i
const HEX8 = /^[0-9a-f]{8}$/i

function warnAlpha(warnings: string[] | undefined, raw: string, alpha: string): void {
  warnings?.push(`Alpha channel in \`${raw}\` was dropped (not fully opaque: ${alpha}).`)
}

/**
 * `#rrggbb` (lower-case) or undefined. Accepts `#rgb`, `#rgba` (expanded,
 * alpha dropped), `#rrggbb`, `#rrggbbaa` (alpha dropped — xterm takes opacity
 * from the theme, not the color; warn when the dropped alpha is not `ff`),
 * bare `rrggbb`, Alacritty's `0x`/`0X` prefix, and kitty/X11 `rgb:rr/gg/bb`
 * (16-bit `rgb:rrrr/gggg/bbbb` takes the high byte). X11 color *names* are
 * deliberately not resolved: guessing at a name table would produce colors
 * the user never chose, so those surface as warnings instead.
 */
export function normalizeHex(raw: unknown, warnings?: string[]): string | undefined {
  if (typeof raw !== 'string') return undefined
  const original = unquote(raw).trim()
  let v = original
  const rgb8 = /^rgb:([0-9a-f]{2})\/([0-9a-f]{2})\/([0-9a-f]{2})$/i.exec(v)
  if (rgb8) return `#${rgb8[1]}${rgb8[2]}${rgb8[3]}`.toLowerCase()
  const rgb16 = /^rgb:([0-9a-f]{4})\/([0-9a-f]{4})\/([0-9a-f]{4})$/i.exec(v)
  if (rgb16) {
    return `#${rgb16[1].slice(0, 2)}${rgb16[2].slice(0, 2)}${rgb16[3].slice(0, 2)}`.toLowerCase()
  }
  if (/^rgb:/i.test(v)) {
    warnings?.push(`Could not parse X11 \`rgb:rr/gg/bb\` color \`${v}\`.`)
    return undefined
  }
  const hadHash = v.startsWith('#')
  if (hadHash) v = v.slice(1)
  else if (v.startsWith('0x') || v.startsWith('0X')) v = v.slice(2)
  if (HEX6.test(v)) return `#${v.toLowerCase()}`
  if (HEX8.test(v)) {
    const alpha = v.slice(6).toLowerCase()
    if (alpha !== 'ff') warnAlpha(warnings, original, alpha)
    return `#${v.slice(0, 6).toLowerCase()}`
  }
  if (HEX4.test(v) && hadHash) {
    const [r, g, b, a] = v.toLowerCase()
    if (a !== 'f') warnAlpha(warnings, original, a)
    return `#${r}${r}${g}${g}${b}${b}`
  }
  if (HEX3.test(v)) {
    const [r, g, b] = v.toLowerCase()
    return `#${r}${r}${g}${g}${b}${b}`
  }
  return undefined
}

/** Hex colors on a line, in order (used by the paste parser).
 *  `#` tokens are 3/4/6/8 digits; `0x`/`0X` tokens are 6/8 only — a 3-digit
 *  `0x100` in a comment must not expand to a colour. */
export function hexTokens(line: string, warnings?: string[]): string[] {
  const out: string[] = []
  const re =
    /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b|0x(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6})\b/gi
  for (const m of line.matchAll(re)) {
    const hex = normalizeHex(m[0], warnings)
    if (hex) out.push(hex)
  }
  return out
}

const GENERIC_FAMILIES = new Set([
  'monospace',
  'serif',
  'sans-serif',
  'system-ui',
  'ui-monospace',
  'cursive',
  'fantasy',
])

/**
 * A CSS font stack from the emulator's family list. Emulators name one family
 * per directive (Ghostty and kitty repeat the key for fallbacks); the browser
 * needs them comma-joined and quoted, with a generic tail so a font the user
 * has installed natively but the WebView can't find still renders monospaced.
 */
export function fontStack(families: string[]): string | undefined {
  const seen = new Set<string>()
  const parts: string[] = []
  for (const raw of families) {
    const name = unquote(raw).trim()
    if (!name || seen.has(name.toLowerCase())) continue
    seen.add(name.toLowerCase())
    parts.push(
      GENERIC_FAMILIES.has(name.toLowerCase())
        ? name.toLowerCase()
        : `'${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`,
    )
  }
  if (parts.length === 0) return undefined
  if (!families.some((f) => GENERIC_FAMILIES.has(unquote(f).trim().toLowerCase()))) {
    parts.push('monospace')
  }
  return parts.join(', ')
}

/** A finite positive number, or undefined — never NaN into the store. */
export function positiveNumber(raw: unknown): number | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? raw : undefined
  if (typeof raw !== 'string') return undefined
  const n = Number(unquote(raw))
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/**
 * Ghostty's `adjust-cell-height` / kitty's `adjust_line_height` as an xterm
 * lineHeight multiplier. Only the percentage form converts: the pixel form
 * depends on the font's own cell height, which the renderer doesn't know.
 *
 * The two spell the percentage differently and it is easy to get backwards:
 * Ghostty's `10%` is an *increase* over the natural cell height (1.10), while
 * kitty's `110%` (`modify_font cell_height` / `adjust_line_height`) is the
 * new height *as a fraction* of it (also 1.10). Results are clamped to
 * 0.5–3; values outside that range warn when a warnings list is provided.
 */
export const LINE_HEIGHT_CLAMP = { min: 0.5, max: 3 } as const

export function lineHeightFromPercent(
  raw: string,
  scale: 'relative' | 'absolute',
  warnings?: string[],
): number | undefined {
  const v = unquote(raw).trim()
  if (!v.endsWith('%')) return undefined
  const pct = Number(v.slice(0, -1))
  if (!Number.isFinite(pct)) return undefined
  const lh = scale === 'relative' ? 1 + pct / 100 : pct / 100
  if (!Number.isFinite(lh) || lh <= 0) return undefined
  if (lh < LINE_HEIGHT_CLAMP.min || lh > LINE_HEIGHT_CLAMP.max) {
    warnings?.push(
      `Line height ${lh} is outside the ${LINE_HEIGHT_CLAMP.min}–${LINE_HEIGHT_CLAMP.max} range and was clamped.`,
    )
    return Math.min(LINE_HEIGHT_CLAMP.max, Math.max(LINE_HEIGHT_CLAMP.min, lh))
  }
  return lh
}

/** Accumulator for the 16 ANSI slots plus the four named colors. */
export interface PaletteDraft {
  foreground?: string
  background?: string
  cursor?: string
  selectionBackground?: string
  ansi: Array<string | undefined>
}

export function newPaletteDraft(): PaletteDraft {
  return { ansi: new Array<string | undefined>(16).fill(undefined) }
}

export function setAnsi(draft: PaletteDraft, index: number, hex: string | undefined): void {
  if (hex && Number.isInteger(index) && index >= 0 && index < 16) draft.ansi[index] = hex
}

/**
 * The draft as a palette, or undefined plus a warning naming exactly what was
 * missing. Partial palettes are refused on purpose (see TerminalImport):
 * xterm would fill the gaps from its Tango defaults and the result would look
 * like neither the user's terminal nor ours.
 */
export function finishPalette(
  draft: PaletteDraft,
  warnings: string[],
  what = 'palette',
): TerminalPalette | undefined {
  const missingAnsi = draft.ansi.reduce<number[]>((acc, c, i) => (c ? acc : [...acc, i]), [])
  const missing: string[] = []
  if (!draft.foreground) missing.push('foreground')
  if (!draft.background) missing.push('background')
  if (missingAnsi.length > 0) missing.push(`${missingAnsi.length} of 16 ANSI colors`)
  if (missing.length > 0) {
    // Nothing at all found is the normal "this config doesn't set colors"
    // case — say so plainly rather than listing every slot. Keyed off
    // "no fg, no bg, zero ANSI hits", not `missing.length === 3`.
    const empty = !draft.foreground && !draft.background && missingAnsi.length === 16
    if (empty) {
      // A more specific warning (oversize/missing include, …) already
      // explains why there's no palette — don't stack a generic one.
      if (warnings.length === 0) warnings.push(`No ${what} found in this config.`)
    } else {
      warnings.push(
        `Incomplete ${what} — missing: ${missing.join(', ')}. Colors were not imported.`,
      )
    }
    return undefined
  }
  const palette: TerminalPalette = {
    foreground: draft.foreground!,
    background: draft.background!,
    ansi: draft.ansi.slice(0, 16) as TerminalPalette['ansi'],
  }
  if (draft.cursor) palette.cursor = draft.cursor
  if (draft.selectionBackground) palette.selectionBackground = draft.selectionBackground
  return palette
}

/** Key/value config line split for the `key = value` formats (Ghostty). */
export function splitEquals(line: string): [string, string] | undefined {
  const i = line.indexOf('=')
  if (i < 0) return undefined
  return [line.slice(0, i).trim(), line.slice(i + 1).trim()]
}

/** Per-parser input cap. Independent of main's 256 KB file cap: a paste or a
 *  skewed IPC payload must not be walked as a config. */
export const MAX_PARSER_CHARS = 1024 * 1024

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

export function oversizedWarning(what = 'config'): string {
  return `This ${what} is larger than 1 MB and was not parsed.`
}

/** Own-property lookup — `includes.toString` must not resolve to Object.prototype. */
export function lookupInclude(
  includes: Record<string, string | undefined>,
  target: string,
): string | undefined {
  return Object.hasOwn(includes, target) ? includes[target] : undefined
}

/** Keys that must never be written onto a parsed table (prototype pollution). */
export const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

export function isUnsafeKey(key: string): boolean {
  return UNSAFE_KEYS.has(key)
}
