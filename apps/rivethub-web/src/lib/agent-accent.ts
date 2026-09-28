/**
 * One accent for agent-rail dots and conversation-row stripes.
 *
 * A named preset colour wins when it is a real hex; otherwise the harness
 * palette (claude clay / grok grey / local emerald). Same inputs → same
 * colour on both surfaces.
 */

import { harnessAccent } from './harness-colors.js'

/** 3- or 6-digit hex, matching the agent editor's colour field. */
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

export function accentFor(input: {
  presetColor?: string
  harnessId?: string
  command?: string
}): string {
  const preset = input.presetColor?.trim()
  if (preset && HEX.test(preset)) return preset
  return harnessAccent(input.harnessId ?? input.command)
}

/**
 * Tile letters for an agent: the first letter of each of the first two words
 * (`grok scout` → `GS`), else the first letter (`reviewer` → `R`). Words split
 * on spaces, `-`, `_` and `.`; a name with no letters or digits gets `?`.
 */
export function agentInitials(name: string): string {
  const words = name.split(/[\s\-_.]+/).filter((w) => /[\p{L}\p{N}]/u.test(w))
  const firstOf = (w: string): string => (w.match(/[\p{L}\p{N}]/u)?.[0] ?? '').toUpperCase()
  if (words.length === 0) return '?'
  return words.length === 1 ? firstOf(words[0]) : firstOf(words[0]) + firstOf(words[1])
}

/** Near-black or white, whichever reads better on the hex `fill`. */
export function inkOn(fill: string): string {
  let hex = fill.trim().replace(/^#/, '')
  if (hex.length === 3) hex = hex.replace(/./g, (c) => c + c)
  const channel = (i: number): number => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  const luminance = 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4)
  // Contrast is equal against #111 and #fff near L≈0.18; above it, dark wins.
  return luminance > 0.18 ? '#111111' : '#ffffff'
}

/** True when two labels read the same, ignoring case, spaces, `-` and `_`. */
export function sameLabel(a: string, b: string): boolean {
  const norm = (v: string): string => v.toLowerCase().replace(/[\s\-_]+/g, '')
  return norm(a) === norm(b)
}
