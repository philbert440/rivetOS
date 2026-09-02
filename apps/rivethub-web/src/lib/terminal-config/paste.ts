/**
 * The paste path: a palette typed or pasted into Settings rather than read
 * off disk. This is what web and mobile clients get instead of the desktop
 * importer, and it is also the WezTerm story — WezTerm's config is Lua, and
 * evaluating a user's Lua to read four colors is not a trade worth making.
 *
 * One tolerant scanner covers every shape people actually paste: Ghostty's
 * `palette = 0=#hex` lines, kitty's `color0 #hex`, a bare list of hex colors,
 * and a WezTerm `colors` block (`ansi = { … }` / `brights = { … }` plus
 * `foreground`/`background`/`cursor_bg`/`selection_bg`).
 */

import {
  finishPalette,
  hexTokens,
  MAX_PARSER_CHARS,
  newPaletteDraft,
  normalizeHex,
  oversizedWarning,
  setAnsi,
  stripBom,
} from './common.js'
import type { TerminalImport } from './types.js'

/** A line is a comment only when it starts with `#` / `--` / `//` AND has
 *  no hex tokens — a one-line `#1d1f21 #cc342b …` palette is colors. */
function isComment(line: string): boolean {
  if (!(line.startsWith('#') || line.startsWith('--') || line.startsWith('//'))) return false
  return hexTokens(line).length === 0
}

/** Ghostty / WezTerm indexed form — the keyword is required so `0 = #hex`
 *  falls through to named-slot / ramp handling. */
const GHOSTTY_INDEXED = /\bpalette\s*=\s*(\d{1,3})\s*=\s*(#?[0-9a-fA-F]{3,8})\b/i
/** kitty `color0 #rrggbb` and `color0 rrggbb` (no hash). */
const KITTY_INDEXED = /\bcolor(\d{1,3})\s+#?([0-9a-fA-F]{6})\b/i

function isSelectionBackground(lower: string): boolean {
  return /\b(selection_background|selectionbackground|selection_bg)\b/.test(lower)
}

function isCursorBackground(lower: string): boolean {
  if (/\bcursor_text/.test(lower)) return false
  if (/\bcursor_fg\b/.test(lower) || /\bcursor_foreground\b/.test(lower)) return false
  return (
    /\bcursor_bg\b/.test(lower) ||
    /\bcursor_color\b/.test(lower) ||
    /\bcursorcolor\b/.test(lower) ||
    /\bcursor\b/.test(lower)
  )
}

export function parsePastedPalette(text: string): TerminalImport {
  text = stripBom(text)
  if (text.length > MAX_PARSER_CHARS) return { warnings: [oversizedWarning('pasted palette')] }
  const warnings: string[] = []
  const draft = newPaletteDraft()
  const ramp: string[] = []
  let sawIndexed = false

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || isComment(line)) continue

    const indexed = KITTY_INDEXED.exec(line) ?? GHOSTTY_INDEXED.exec(line)
    if (indexed) {
      const index = Number(indexed[1])
      const hex = normalizeHex(indexed[2], warnings)
      if (hex && Number.isInteger(index) && index >= 0 && index < 16) {
        setAnsi(draft, index, hex)
        sawIndexed = true
        continue
      }
      // Bad hex or index ≥ 16: fall through to named-slot / ramp handling
      // rather than `continue` past it.
    }

    const colors = hexTokens(line, warnings)
    if (colors.length === 0) continue
    // Named slots are claimed before the ramp so a `cursor_bg` line can't
    // shift every ANSI color by one. Selection is tested first: it also
    // contains "bg"/"background". Hyphens become underscores so Ghostty's
    // `selection-background` is the same key as `selection_background`
    // (`\b` treats `-` as a boundary and would otherwise let `background`
    // match inside it). Explicit keys only — `selection_foreground` /
    // `cursor_fg` / `cursor_text_color` must not land in these slots.
    const lower = line.toLowerCase().replace(/-/g, '_')
    if (isSelectionBackground(lower)) draft.selectionBackground ??= colors[0]
    else if (isCursorBackground(lower)) draft.cursor ??= colors[0]
    else if (/\b(foreground|fg)\b/.test(lower)) draft.foreground ??= colors[0]
    else if (/\b(background|bg)\b/.test(lower)) draft.background ??= colors[0]
    else ramp.push(...colors)
  }

  if (!sawIndexed && ramp.length > 0) {
    if (ramp.length > 16) {
      warnings.push(`Found ${ramp.length} colors — the first 16 were used as the ANSI palette.`)
    }
    ramp.slice(0, 16).forEach((hex, i) => setAnsi(draft, i, hex))
  }

  // A bare 16-color list carries no foreground/background. Deriving only the
  // missing slot from ANSI white / black is what every emulator does with
  // such a palette; warn only for the slot actually invented. Fill notes are
  // appended AFTER finishPalette so a partial paste's first warning is the
  // incomplete-palette summary, not a per-slot fill.
  const fillNotes: string[] = []
  if (!draft.foreground && draft.ansi[7]) {
    draft.foreground = draft.ansi[7]
    fillNotes.push('No foreground in the pasted text — ANSI white was used instead.')
  }
  if (!draft.background && draft.ansi[0]) {
    draft.background = draft.ansi[0]
    fillNotes.push('No background in the pasted text — ANSI black was used instead.')
  }

  const result: TerminalImport = { warnings }
  const palette = finishPalette(draft, warnings, 'pasted palette')
  if (palette) result.palette = palette
  warnings.push(...fillNotes)
  return result
}
