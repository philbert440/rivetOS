import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  applyOmarchyTokens,
  clearOmarchyTokens,
  contrastRatio,
  OMARCHY_TOKEN_NAMES,
  omarchyAppTokens,
  parseOmarchyColors,
  type OmarchyColors,
} from './omarchy-theme.js'

const HEX = /^#[0-9a-f]{6}$/i

const readFixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./__fixtures__/omarchy/${name}`, import.meta.url)), 'utf8')

const osakaJadeToml = readFixture('osaka-jade-4.colors.toml')
const latteToml = readFixture('catppuccin-latte-4.colors.toml')
const upstreamLatteToml = readFixture('upstream-latte.colors.toml')

function expectParsed(c: OmarchyColors | null, mode: 'dark' | 'light'): OmarchyColors {
  expect(c).not.toBeNull()
  if (!c) throw new Error('expected colors')
  expect(c.mode).toBe(mode)
  expect(c.accent).toMatch(HEX)
  expect(c.background).toMatch(HEX)
  expect(c.foreground).toMatch(HEX)
  expect(c.selection).toMatch(HEX)
  expect(c.ansi).toHaveLength(16)
  for (const slot of c.ansi) expect(slot).toMatch(HEX)
  return c
}

describe('parseOmarchyColors', () => {
  it('parses schema A dark (osaka-jade 4.x)', () => {
    const c = expectParsed(parseOmarchyColors(osakaJadeToml), 'dark')
    expect(c.accent).toBe('#509475')
    expect(c.background).toBe('#111c18')
    expect(c.foreground).toBe('#c1c497')
    expect(c.orange).toBe('#a2734b')
    expect(c.ansi[0]).toBe('#090f0d')
    expect(c.ansi[1]).toBe('#ff5345')
    expect(c.ansi[15]).toBe('#f7e8b2')
  })

  it('parses schema A light (catppuccin-latte 4.x)', () => {
    const c = expectParsed(parseOmarchyColors(latteToml), 'light')
    expect(c.accent).toBe('#1e66f5')
    expect(c.background).toBe('#eff1f5')
    expect(c.foreground).toBe('#4c4f69')
    expect(c.orange).toBe('#d84e2b')
  })

  it('parses schema B (upstream latte): mode from background luminance', () => {
    const c = expectParsed(parseOmarchyColors(upstreamLatteToml), 'light')
    expect(c.accent).toBe('#1e66f5')
    expect(c.background).toBe('#eff1f5')
    expect(c.foreground).toBe('#4c4f69')
    expect(c.selection).toBe('#dc8a78')
    expect(c.orange).toBeUndefined()
    expect(c.bg).toEqual({})
    expect(c.fg).toEqual({})
    expect(c.ansi[0]).toBe('#bcc0cc')
    expect(c.ansi[15]).toBe('#6c6f85')
  })

  it('schema B honors lightModeMarker', () => {
    const darkB = [
      'accent = "#509475"',
      'foreground = "#c1c497"',
      'background = "#111c18"',
      'selection_background = "#32473b"',
      ...Array.from(
        { length: 16 },
        (_, i) => `color${i} = "#${(i + 1).toString(16).repeat(6).slice(0, 6)}"`,
      ),
    ].join('\n')
    expect(parseOmarchyColors(darkB)?.mode).toBe('dark')
    expect(parseOmarchyColors(darkB, { lightModeMarker: true })?.mode).toBe('light')
    expect(parseOmarchyColors(upstreamLatteToml, { lightModeMarker: true })?.mode).toBe('light')
  })

  it('returns null when background or foreground is missing or not #hex', () => {
    expect(parseOmarchyColors('accent = "#509475"\nforeground = "#c1c497"\n')).toBeNull()
    expect(parseOmarchyColors('background = "#111c18"\naccent = "#509475"\n')).toBeNull()
    expect(
      parseOmarchyColors('background = "111c18"\nforeground = "#c1c497"\naccent = "#509475"\n'),
    ).toBeNull()
    expect(parseOmarchyColors('not toml at all {{{')).toBeNull()
  })
})

describe('omarchyAppTokens', () => {
  it('token-name completeness against theme.css', () => {
    const css = readFileSync(fileURLToPath(new URL('../theme.css', import.meta.url)), 'utf8')
    const declared = new Set<string>()
    for (const m of css.matchAll(/^\s*(--[\w-]+)\s*:/gm)) {
      const name = m[1]
      if (name) declared.add(name)
    }
    const aliases = new Set([
      '--bg',
      '--panel',
      '--panel-2',
      '--line',
      '--ink',
      '--ink-dim',
      '--em',
      '--warn',
      '--bad',
      '--user',
      '--mono',
    ])
    for (const name of [...declared]) {
      if (name.startsWith('--font-') || aliases.has(name)) declared.delete(name)
    }
    const osakaJade = parseOmarchyColors(osakaJadeToml)
    expect(osakaJade).not.toBeNull()
    if (!osakaJade) return
    expect(new Set(Object.keys(omarchyAppTokens(osakaJade)))).toEqual(declared)
  })

  it('OMARCHY_TOKEN_NAMES matches every key omarchyAppTokens emits', () => {
    const osakaJade = parseOmarchyColors(osakaJadeToml)!
    expect(new Set(Object.keys(omarchyAppTokens(osakaJade)))).toEqual(new Set(OMARCHY_TOKEN_NAMES))
  })

  it('floors --color-ink to contrast ≥ 4.5 when foreground ≈ background', () => {
    const toml = [
      'mode = "dark"',
      'accent = "#509475"',
      'selection = "#32473b"',
      'background = "#111c18"',
      'foreground = "#121d19"',
      'red = "#ff5345"',
      'yellow = "#459451"',
      'green = "#549e6a"',
      'cyan = "#2dd5b7"',
      'blue = "#509475"',
      'magenta = "#d2689c"',
    ].join('\n')
    const c = parseOmarchyColors(toml)
    expect(c).not.toBeNull()
    if (!c) return
    const tokens = omarchyAppTokens(c)
    expect(contrastRatio(tokens['--color-ink']!, tokens['--color-bg']!)).toBeGreaterThanOrEqual(4.5)
  })

  it('picks orange for --color-warn and never collapses to --color-red', () => {
    const osakaJade = parseOmarchyColors(osakaJadeToml)
    expect(osakaJade).not.toBeNull()
    if (!osakaJade) return
    const osakaTokens = omarchyAppTokens(osakaJade)
    expect(osakaTokens['--color-warn']).toBe('#a2734b')

    const latte = parseOmarchyColors(latteToml)
    expect(latte).not.toBeNull()
    if (!latte) return
    const latteTokens = omarchyAppTokens(latte)
    expect(latteTokens['--color-warn']).toBe('#d84e2b')
    expect(latteTokens['--color-warn']).not.toBe(latteTokens['--color-red'])
    expect(
      contrastRatio(latteTokens['--color-warn']!, latteTokens['--color-bg']!),
    ).toBeGreaterThanOrEqual(3)

    const upstream = parseOmarchyColors(upstreamLatteToml)
    expect(upstream).not.toBeNull()
    if (!upstream) return
    const upTokens = omarchyAppTokens(upstream)
    expect(upTokens['--color-warn']).not.toBe(upTokens['--color-red'])
    expect(
      contrastRatio(upTokens['--color-warn']!, upTokens['--color-bg']!),
    ).toBeGreaterThanOrEqual(3)
  })

  it('floors --color-ink-dim to contrast ≥ 3.0 (latte + crafted fg.dark ≈ bg)', () => {
    const latte = parseOmarchyColors(latteToml)
    expect(latte).not.toBeNull()
    if (!latte) return
    const latteTokens = omarchyAppTokens(latte)
    expect(
      contrastRatio(latteTokens['--color-ink-dim']!, latteTokens['--color-bg']!),
    ).toBeGreaterThanOrEqual(3.0)

    const toml = [
      'mode = "dark"',
      'accent = "#509475"',
      'selection = "#32473b"',
      'background = "#111c18"',
      'foreground = "#c1c497"',
      'dark_foreground = "#121d19"',
      'red = "#ff5345"',
      'yellow = "#459451"',
      'green = "#549e6a"',
      'cyan = "#2dd5b7"',
      'blue = "#509475"',
      'magenta = "#d2689c"',
    ].join('\n')
    const c = parseOmarchyColors(toml)
    expect(c).not.toBeNull()
    if (!c) return
    expect(c.fg.dark).toBe('#121d19')
    const tokens = omarchyAppTokens(c)
    expect(contrastRatio(tokens['--color-ink-dim']!, tokens['--color-bg']!)).toBeGreaterThanOrEqual(
      3.0,
    )
  })

  it('floors --tool, --system, --banner-warn-ink, --banner-bad-ink to ≥ 3.0 on latte', () => {
    const latte = parseOmarchyColors(latteToml)
    expect(latte).not.toBeNull()
    if (!latte) return
    const tokens = omarchyAppTokens(latte)
    const bg = tokens['--color-bg']!
    for (const name of ['--tool', '--system', '--banner-warn-ink', '--banner-bad-ink'] as const) {
      expect(contrastRatio(tokens[name]!, bg)).toBeGreaterThanOrEqual(3.0)
    }
  })
})

describe('applyOmarchyTokens / clearOmarchyTokens', () => {
  it('round-trips setProperty / removeProperty on a stub element', () => {
    const set: Array<[string, string]> = []
    const removed: string[] = []
    const el = {
      style: {
        setProperty(n: string, v: string): void {
          set.push([n, v])
        },
        removeProperty(n: string): void {
          removed.push(n)
        },
      },
    }
    const osakaJade = parseOmarchyColors(osakaJadeToml)!
    const tokens = omarchyAppTokens(osakaJade)
    applyOmarchyTokens(el, tokens)
    expect(set).toEqual(Object.entries(tokens))
    clearOmarchyTokens(el, OMARCHY_TOKEN_NAMES)
    expect(removed).toEqual([...OMARCHY_TOKEN_NAMES])
  })
})
