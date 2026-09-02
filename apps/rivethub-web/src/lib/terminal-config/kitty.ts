/**
 * kitty (`~/.config/kitty/kitty.conf`) — `key value`, space-separated, `#`
 * comments. `include` directives are spliced from the map the desktop IPC
 * supplies (kitty themes ship as an `include ./current-theme.conf`, so
 * without this most kitty users would import a font and no colors).
 *
 * Later assignments win in kitty, and they win here too — the parser simply
 * overwrites as it walks.
 */

import {
  finishPalette,
  fontStack,
  lineHeightFromPercent,
  lookupInclude,
  MAX_PARSER_CHARS,
  newPaletteDraft,
  normalizeHex,
  oversizedWarning,
  positiveNumber,
  setAnsi,
  stripBom,
  unquote,
  type PaletteDraft,
} from './common.js'
import type { TerminalImport } from './types.js'

/** `key rest-of-line`, or undefined for a comment/blank. */
function splitSpace(line: string): [string, string] | undefined {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) return undefined
  const m = /^(\S+)\s*(.*)$/.exec(trimmed)
  if (!m) return undefined
  return [m[1], m[2].trim()]
}

/**
 * kitty ≥0.28 allows `font_family family="Fira Code" style=Bold`; older
 * configs are a bare family name. Reading only the `family=` part keeps the
 * style tokens out of the CSS stack.
 */
function fontFamilyValue(value: string): string {
  const m = /\bfamily\s*=\s*("([^"]*)"|'([^']*)'|\S+)/.exec(value)
  if (!m) return value
  // .at() is honest about optional capture groups; m[2] is typed `string`.
  return m.at(2) ?? m.at(3) ?? m[1]
}

function flatten(
  text: string,
  includes: Record<string, string | undefined>,
  warnings: string[],
): string[] {
  const out: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    const kv = splitSpace(raw)
    if (!kv) continue
    if (kv[0] === 'include' || kv[0] === 'globinclude' || kv[0] === 'envinclude') {
      if (kv[0] !== 'include') {
        warnings.push(`\`${kv[0]}\` directives are not followed.`)
        continue
      }
      // Main keys the include map by the unquoted target, so look it up the
      // same way — a `include "theme.conf"` would otherwise never match.
      const target = unquote(kv[1])
      const included = lookupInclude(includes, target)
      if (included === undefined) {
        warnings.push(`Could not read included config \`${target}\`.`)
        continue
      }
      if (included.length > MAX_PARSER_CHARS) {
        warnings.push(`Included config \`${target}\` is larger than 1 MB and was not parsed.`)
        continue
      }
      for (const sub of stripBom(included).split(/\r?\n/)) {
        const subKv = splitSpace(sub)
        if (!subKv) continue
        if (subKv[0] === 'include' || subKv[0] === 'globinclude' || subKv[0] === 'envinclude') {
          warnings.push(`Nested include in \`${target}\` was not followed.`)
          continue
        }
        out.push(sub.trim())
      }
      continue
    }
    out.push(raw.trim())
  }
  return out
}

export function parseKitty(
  text: string,
  opts: { includes?: Record<string, string | undefined> } = {},
): TerminalImport {
  text = stripBom(text)
  if (text.length > MAX_PARSER_CHARS) return { warnings: [oversizedWarning('config')] }
  const warnings: string[] = []
  const draft: PaletteDraft = newPaletteDraft()
  let families: string[] = []
  let fontSize: number | undefined
  let lineHeight: number | undefined

  for (const line of flatten(text, opts.includes ?? {}, warnings)) {
    const kv = splitSpace(line)
    if (!kv) continue
    const [key, value] = kv
    const colorIndex = /^color(\d{1,3})$/.exec(key)
    if (colorIndex) {
      const index = Number(colorIndex[1])
      if (index >= 16) continue // no xterm theme slot for the 256-color extras
      const hex = normalizeHex(value, warnings)
      if (!hex) warnings.push(`Could not read \`${key} ${value}\` as a color.`)
      else setAnsi(draft, index, hex)
      continue
    }
    switch (key) {
      case 'font_family': {
        // kitty: a later font_family replaces the earlier one; it is not a
        // fallback stack (that's Ghostty). Skip empty family="".
        const name = fontFamilyValue(value).trim()
        if (name) families = [name]
        break
      }
      case 'font_size':
        fontSize = positiveNumber(value) ?? fontSize
        break
      case 'adjust_line_height': {
        const lh = lineHeightFromPercent(value, 'absolute', warnings)
        if (lh === undefined) warnings.push('`adjust_line_height` in pixels was ignored.')
        else lineHeight = lh
        break
      }
      case 'modify_font': {
        const cell = /^cell_height\s+(\S+)/i.exec(value)
        if (cell) {
          const lh = lineHeightFromPercent(cell[1], 'absolute', warnings)
          if (lh === undefined) warnings.push('`modify_font cell_height` in pixels was ignored.')
          else lineHeight = lh
        }
        break
      }
      case 'foreground':
      case 'background':
      case 'cursor':
      case 'selection_background': {
        const hex = normalizeHex(value, warnings)
        if (!hex) {
          warnings.push(`Could not read \`${key} ${value}\` as a color.`)
          break
        }
        if (key === 'foreground') draft.foreground = hex
        else if (key === 'background') draft.background = hex
        else if (key === 'cursor') draft.cursor = hex
        else draft.selectionBackground = hex
        break
      }
      default:
        break
    }
  }

  const result: TerminalImport = { warnings }
  const family = fontStack(families)
  if (family) result.fontFamily = family
  if (fontSize !== undefined) result.fontSize = fontSize
  if (lineHeight !== undefined) result.lineHeight = lineHeight
  const palette = finishPalette(draft, warnings)
  if (palette) result.palette = palette
  return result
}
