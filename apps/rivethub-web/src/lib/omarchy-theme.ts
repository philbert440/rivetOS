/**
 * Omarchy `colors.toml` → RivetHub app tokens.
 *
 * Pure: parse schema A (4.x) and schema B (upstream) into a common shape,
 * map that onto the `--color-*` / literal tokens in theme.css, and apply or
 * clear them as inline custom properties (inline beats the stylesheet).
 * Contrast floors keep ink readable when a theme's fg/bg pair is too close.
 */

import { parseToml, type TomlTable, type TomlValue } from './terminal-config/toml.js'

export interface OmarchyColors {
  mode: 'dark' | 'light'
  accent: string
  background: string
  foreground: string
  selection: string
  muted?: string
  orange?: string
  bg: { dark?: string; darker?: string; lighter?: string }
  fg: { dark?: string; light?: string; bright?: string }
  ansi: [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ]
}

export const OMARCHY_TOKEN_NAMES = [
  '--color-bg',
  '--color-panel',
  '--color-panel-2',
  '--color-line',
  '--color-code-bg',
  '--color-ink',
  '--color-ink-dim',
  '--color-em',
  '--color-em-dim',
  '--color-red',
  '--color-warn',
  '--color-link',
  '--grid-line',
  '--assistant',
  '--tool',
  '--system',
  '--banner-warn-ink',
  '--banner-bad-ink',
] as const

const HEX6 = /^#[0-9a-f]{6}$/i
const HEX3 = /^#[0-9a-f]{3}$/i

/** `#rrggbb` (lower-case) from `#rrggbb` / `#rgb` only; anything else is undefined. */
function parseHexColor(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const v = raw.trim()
  if (HEX6.test(v)) return `#${v.slice(1).toLowerCase()}`
  if (HEX3.test(v)) {
    const [r, g, b] = v.slice(1).toLowerCase()
    return `#${r}${r}${g}${g}${b}${b}`
  }
  return undefined
}

function tomlString(v: TomlValue | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function hexOf(table: TomlTable, key: string): string | undefined {
  return parseHexColor(tomlString(table[key]))
}

function parseRgb(hex: string): [number, number, number] | undefined {
  const h = hex.startsWith('#') ? hex.slice(1) : hex
  if (/^[0-9a-f]{3}$/i.test(h)) {
    return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)]
  }
  if (/^[0-9a-f]{6}$/i.test(h)) {
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
  }
  return undefined
}

export function relativeLuminance(hex: string): number {
  const rgb = parseRgb(hex)
  if (!rgb) return 0
  const lin = (c: number): number => {
    const s = c / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2])
}

export function contrastRatio(a: string, b: string): number {
  const l1 = relativeLuminance(a)
  const l2 = relativeLuminance(b)
  const hi = l1 > l2 ? l1 : l2
  const lo = l1 > l2 ? l2 : l1
  return (hi + 0.05) / (lo + 0.05)
}

export function mixHex(a: string, b: string, t: number): string {
  const aa = parseRgb(a)
  const bb = parseRgb(b)
  if (!aa || !bb) return a
  const u = t < 0 ? 0 : t > 1 ? 1 : t
  const ch = (i: 0 | 1 | 2): string => {
    const v = Math.round(aa[i] * (1 - u) + bb[i] * u)
    return Math.min(255, Math.max(0, v)).toString(16).padStart(2, '0')
  }
  return `#${ch(0)}${ch(1)}${ch(2)}`
}

function hexToRgba(hex: string, alpha: number): string {
  const rgb = parseRgb(hex)
  if (!rgb) return `rgba(0, 0, 0, ${alpha})`
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`
}

function isHex6(v: unknown): v is string {
  return typeof v === 'string' && HEX6.test(v)
}

function isVariantMap(v: unknown, keys: readonly string[]): boolean {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  for (const k of keys) {
    if (o[k] !== undefined && !isHex6(o[k])) return false
  }
  return true
}

export function isOmarchyColors(v: unknown): v is OmarchyColors {
  if (typeof v !== 'object' || v === null) return false
  const c = v as Record<string, unknown>
  if (c.mode !== 'dark' && c.mode !== 'light') return false
  if (!isHex6(c.accent) || !isHex6(c.background) || !isHex6(c.foreground) || !isHex6(c.selection)) {
    return false
  }
  if (c.muted !== undefined && !isHex6(c.muted)) return false
  if (c.orange !== undefined && !isHex6(c.orange)) return false
  if (!isVariantMap(c.bg, ['dark', 'darker', 'lighter'])) return false
  if (!isVariantMap(c.fg, ['dark', 'light', 'bright'])) return false
  return Array.isArray(c.ansi) && c.ansi.length === 16 && c.ansi.every(isHex6)
}

function modeFromLuminance(background: string): 'dark' | 'light' {
  return relativeLuminance(background) > 0.5 ? 'light' : 'dark'
}

function isSchemaA(table: TomlTable): boolean {
  return (
    table.mode !== undefined ||
    table.dark_background !== undefined ||
    table.bright_foreground !== undefined
  )
}

function parseSchemaA(
  table: TomlTable,
  background: string,
  foreground: string,
): OmarchyColors | null {
  const accent = hexOf(table, 'accent')
  if (!accent) return null
  const red = hexOf(table, 'red')
  const green = hexOf(table, 'green')
  const yellow = hexOf(table, 'yellow')
  const blue = hexOf(table, 'blue')
  const magenta = hexOf(table, 'magenta')
  const cyan = hexOf(table, 'cyan')
  if (!red || !green || !yellow || !blue || !magenta || !cyan) return null

  const modeRaw = tomlString(table.mode)
  const mode: 'dark' | 'light' =
    modeRaw === 'dark' || modeRaw === 'light' ? modeRaw : modeFromLuminance(background)

  const darkBg = hexOf(table, 'dark_background')
  const darkerBg = hexOf(table, 'darker_background')
  const lighterBg = hexOf(table, 'lighter_background')
  const darkFg = hexOf(table, 'dark_foreground')
  const lightFg = hexOf(table, 'light_foreground')
  const brightFg = hexOf(table, 'bright_foreground')
  const muted = hexOf(table, 'muted')
  const orange = hexOf(table, 'orange')
  const selection = hexOf(table, 'selection') ?? background

  const ansi: OmarchyColors['ansi'] = [
    darkerBg ?? darkBg ?? background,
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    lightFg ?? foreground,
    muted ?? darkFg ?? foreground,
    hexOf(table, 'bright_red') ?? red,
    hexOf(table, 'bright_green') ?? green,
    hexOf(table, 'bright_yellow') ?? yellow,
    hexOf(table, 'bright_blue') ?? blue,
    hexOf(table, 'bright_magenta') ?? magenta,
    hexOf(table, 'bright_cyan') ?? cyan,
    brightFg ?? foreground,
  ]

  return {
    mode,
    accent,
    background,
    foreground,
    selection,
    ...(muted ? { muted } : {}),
    ...(orange ? { orange } : {}),
    bg: {
      ...(darkBg ? { dark: darkBg } : {}),
      ...(darkerBg ? { darker: darkerBg } : {}),
      ...(lighterBg ? { lighter: lighterBg } : {}),
    },
    fg: {
      ...(darkFg ? { dark: darkFg } : {}),
      ...(lightFg ? { light: lightFg } : {}),
      ...(brightFg ? { bright: brightFg } : {}),
    },
    ansi,
  }
}

function parseSchemaB(
  table: TomlTable,
  background: string,
  foreground: string,
  opts?: { lightModeMarker?: boolean },
): OmarchyColors | null {
  const accent = hexOf(table, 'accent')
  if (!accent) return null
  const slots: string[] = []
  for (let i = 0; i < 16; i++) {
    const c = hexOf(table, `color${i}`)
    if (!c) return null
    slots.push(c)
  }
  const ansi = slots as unknown as OmarchyColors['ansi']
  const selection = hexOf(table, 'selection_background') ?? background
  const mode: 'dark' | 'light' = opts?.lightModeMarker ? 'light' : modeFromLuminance(background)
  return {
    mode,
    accent,
    background,
    foreground,
    selection,
    bg: {},
    fg: {},
    ansi,
  }
}

export function parseOmarchyColors(
  toml: string,
  opts?: { lightModeMarker?: boolean },
): OmarchyColors | null {
  let table: TomlTable
  try {
    table = parseToml(toml)
  } catch {
    return null
  }
  const background = hexOf(table, 'background')
  const foreground = hexOf(table, 'foreground')
  if (!background || !foreground) return null
  if (isSchemaA(table)) return parseSchemaA(table, background, foreground)
  return parseSchemaB(table, background, foreground, opts)
}

function lift(bg: string, mode: 'dark' | 'light', t: number, fg: string): string {
  return mixHex(bg, mode === 'light' ? '#ffffff' : fg, t)
}

function nudgeContrast(
  color: string,
  bg: string,
  min: number,
  toward: string,
  maxSteps = 25,
): string {
  let c = color
  for (let i = 0; i < maxSteps; i++) {
    if (contrastRatio(c, bg) >= min) return c
    c = mixHex(c, toward, 0.1)
  }
  return contrastRatio(c, bg) >= min ? c : toward
}

function pickWarn(c: OmarchyColors): string {
  const bg = c.background
  const candidates = [c.orange, c.ansi[3], c.ansi[11], '#f59e0b', '#b45309']
  for (const cand of candidates) {
    if (cand && contrastRatio(cand, bg) >= 3) return cand
  }
  // Never red / bright_red / accent — last listed candidate is the light-theme warn.
  return '#b45309'
}

function pickBgVariants(c: OmarchyColors): {
  lighter: string
  darker: string
  hasDarker: boolean
} {
  const bgL = relativeLuminance(c.background)
  const variants = [c.bg.dark, c.bg.darker, c.bg.lighter].filter(
    (v): v is string => typeof v === 'string',
  )
  let lighter: string | undefined
  let darker: string | undefined
  for (const v of variants) {
    const l = relativeLuminance(v)
    if (l > bgL) {
      if (lighter === undefined || l > relativeLuminance(lighter)) lighter = v
    } else if (l < bgL) {
      if (darker === undefined || l < relativeLuminance(darker)) darker = v
    }
  }
  return {
    lighter: lighter ?? lift(c.background, c.mode, 0.06, c.foreground),
    darker: darker ?? mixHex(c.background, c.mode === 'light' ? c.foreground : '#000000', 0.12),
    hasDarker: darker !== undefined,
  }
}

export function omarchyAppTokens(c: OmarchyColors): Record<string, string> {
  const { lighter, darker, hasDarker } = pickBgVariants(c)
  const bg = c.background
  const fg = c.foreground
  const panel = c.mode === 'light' ? lift(bg, 'light', 0.6, fg) : mixHex(bg, lighter, 0.35)
  const panel2 = c.mode === 'light' ? (hasDarker ? darker : mixHex(bg, fg, 0.08)) : lighter
  const inkToward = c.mode === 'dark' ? '#ffffff' : '#000000'
  const ink = nudgeContrast(fg, bg, 4.5, inkToward)
  let inkDim = c.fg.dark ?? mixHex(fg, bg, 0.45)
  inkDim = nudgeContrast(inkDim, bg, 3.0, fg)
  if (contrastRatio(inkDim, bg) < 3) inkDim = nudgeContrast(inkDim, bg, 3.0, inkToward)

  const tool = nudgeContrast(c.fg.dark ?? inkDim, bg, 3.0, fg)
  const system = nudgeContrast(c.muted ?? mixHex(fg, bg, 0.5), bg, 3.0, fg)
  const bannerWarn = nudgeContrast(c.ansi[10], bg, 3.0, fg, 10)
  const bannerBad = nudgeContrast(c.ansi[9], bg, 3.0, fg, 10)

  return {
    '--color-bg': bg,
    '--color-panel': panel,
    '--color-panel-2': panel2,
    '--color-line': mixHex(panel2, fg, 0.15),
    '--color-code-bg': panel,
    '--color-ink': ink,
    '--color-ink-dim': inkDim,
    '--color-em': c.accent,
    '--color-em-dim': mixHex(c.accent, bg, 0.25),
    '--color-red': c.ansi[1],
    '--color-warn': pickWarn(c),
    '--color-link': c.ansi[4],
    '--grid-line': hexToRgba(c.accent, 0.05),
    '--assistant': c.fg.light ?? fg,
    '--tool': tool,
    '--system': system,
    '--banner-warn-ink': bannerWarn,
    '--banner-bad-ink': bannerBad,
  }
}

export function applyOmarchyTokens(
  el: { style: { setProperty(n: string, v: string): void } },
  tokens: Record<string, string>,
): void {
  for (const [n, v] of Object.entries(tokens)) el.style.setProperty(n, v)
}

export function clearOmarchyTokens(
  el: { style: { removeProperty(n: string): void } },
  names: readonly string[],
): void {
  for (const n of names) el.style.removeProperty(n)
}
