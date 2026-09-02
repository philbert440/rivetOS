/**
 * Ghostty (`~/.config/ghostty/config`) — `key = value`, one per line, `#`
 * comments, repeated keys building lists.
 *
 * `config-file` includes are spliced in place from the map the desktop IPC
 * supplies (main resolves and fences the paths; this parser never touches a
 * filesystem). Only one level deep — a nested `config-file` inside an
 * included file is reported as a warning rather than silently dropped.
 */

import { TERMINAL_SCHEMES } from '../terminal-schemes.js'
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
  splitEquals,
  stripBom,
  unquote,
  type PaletteDraft,
} from './common.js'
import type { TerminalImport } from './types.js'

function looseName(v: string): string {
  return v.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Built-in schemes keyed by the same normaliser the lookup uses, so
 *  `Catppuccin Mocha`, `catppuccin-mocha` and `CatppuccinMocha` all land on
 *  the same palette. Names we don't ship are NOT guessed at. */
const SCHEMES_BY_LOOSE_NAME = new Map(TERMINAL_SCHEMES.map((s) => [looseName(s.id), s]))

/**
 * Ghostty allows `theme = dark:one,light:two` for automatic light/dark. The
 * embedded terminal carries a single palette, so the dark variant wins — it
 * is the one that matches RivetHub's own default.
 */
function themeName(value: string): string {
  const v = unquote(value)
  if (!/(^|,)\s*(dark|light):/i.test(v)) return v
  const parts = v.split(',').map((p) => p.trim())
  const dark = parts.find((p) => /^dark:/i.test(p))
  const chosen = dark ?? parts.find((p) => /^light:/i.test(p)) ?? ''
  return chosen.slice(chosen.indexOf(':') + 1).trim()
}

/** Optional include is `config-file = ?path` — `?` prefixes the value. */
function configFileTarget(rawValue: string): { target: string; optional: boolean } {
  let target = unquote(rawValue)
  const optional = target.startsWith('?')
  if (optional) target = unquote(target.slice(1).trim())
  return { target, optional }
}

function resolveTheme(value: string) {
  const v = unquote(value)
  const names: string[] = []
  if (/(^|,)\s*(dark|light):/i.test(v)) {
    const name = themeName(value)
    if (name) names.push(name)
  } else {
    for (const part of v.split(',')) {
      const name = part.trim()
      if (name) names.push(name)
    }
  }
  for (const name of names) {
    const scheme = SCHEMES_BY_LOOSE_NAME.get(looseName(name))
    if (scheme) return scheme
  }
  return undefined
}

/** Config lines with one level of `config-file` includes spliced in. */
function flatten(
  text: string,
  includes: Record<string, string | undefined>,
  warnings: string[],
): string[] {
  const out: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const kv = splitEquals(line)
    if (kv && kv[0] === 'config-file') {
      const { target, optional } = configFileTarget(kv[1])
      const included = lookupInclude(includes, target)
      if (included === undefined) {
        if (!optional) warnings.push(`Could not read included config \`${target}\`.`)
        continue
      }
      if (included.length > MAX_PARSER_CHARS) {
        warnings.push(`Included config \`${target}\` is larger than 1 MB and was not parsed.`)
        continue
      }
      for (const sub of stripBom(included).split(/\r?\n/)) {
        const subLine = sub.trim()
        if (!subLine || subLine.startsWith('#')) continue
        const subKv = splitEquals(subLine)
        if (subKv && subKv[0] === 'config-file') {
          warnings.push(`Nested include in \`${target}\` was not followed.`)
          continue
        }
        out.push(subLine)
      }
      continue
    }
    out.push(line)
  }
  return out
}

export function parseGhostty(
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
  let theme: string | undefined

  for (const line of flatten(text, opts.includes ?? {}, warnings)) {
    const kv = splitEquals(line)
    if (!kv) continue
    const [key, rawValue] = kv
    const value = unquote(rawValue)
    switch (key) {
      case 'font-family':
        // An empty value is Ghostty's documented "reset the list" — honoring
        // it keeps a config that clears then re-adds families correct.
        if (value === '') families = []
        else families.push(value)
        break
      case 'font-size':
        fontSize = positiveNumber(value) ?? fontSize
        break
      case 'adjust-cell-height': {
        const lh = lineHeightFromPercent(value, 'relative', warnings)
        if (lh === undefined) warnings.push('`adjust-cell-height` in pixels was ignored.')
        else lineHeight = lh
        break
      }
      case 'theme':
        theme = themeName(rawValue)
        break
      case 'foreground':
      case 'background':
      case 'cursor-color':
      case 'selection-background': {
        const hex = normalizeHex(value, warnings)
        if (!hex) {
          warnings.push(`Could not read \`${key} = ${value}\` as a color.`)
          break
        }
        if (key === 'foreground') draft.foreground = hex
        else if (key === 'background') draft.background = hex
        else if (key === 'cursor-color') draft.cursor = hex
        else draft.selectionBackground = hex
        break
      }
      case 'palette': {
        // `palette = N=#hex` — the index is part of the VALUE, not the key.
        const eq = value.indexOf('=')
        if (eq < 0) {
          warnings.push(`Could not read palette entry \`${value}\` as a color.`)
          break
        }
        const rawIndex = value.slice(0, eq).trim()
        // `Number('')` is 0 and `Number('0x2')` is 2 — require a decimal
        // index before converting, otherwise `palette = =#ffffff` writes slot 0.
        if (!/^\d{1,3}$/.test(rawIndex)) {
          warnings.push(`Could not read palette entry \`${value}\` as a color.`)
          break
        }
        const index = Number(rawIndex)
        const hex = normalizeHex(value.slice(eq + 1), warnings)
        if (!Number.isInteger(index) || index < 0 || index >= 16 || !hex) {
          warnings.push(`Could not read palette entry \`${value}\` as a color.`)
        } else {
          setAnsi(draft, index, hex)
        }
        break
      }
      default:
        break
    }
  }

  if (theme) {
    const scheme = resolveTheme(theme)
    if (scheme) {
      // Theme is the base layer; explicit color directives already in the
      // draft win, whatever order they appeared in the file.
      draft.foreground ??= scheme.palette.foreground
      draft.background ??= scheme.palette.background
      draft.cursor ??= scheme.palette.cursor
      draft.selectionBackground ??= scheme.palette.selectionBackground
      scheme.palette.ansi.forEach((c, i) => {
        draft.ansi[i] ??= c
      })
    } else {
      warnings.push(
        `Theme \`${theme}\` isn't one RivetHub ships — only colors set directly in the config were imported.`,
      )
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
