import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseOmarchyColors, type OmarchyColors } from './omarchy-theme.js'
import {
  omarchyOpencodeThemeDoc,
  omarchyToOpencodeTheme,
  OPENCODE_THEME_KEYS,
} from './opencode-theme.js'

const HEX = /^#[0-9a-f]{6}$/i

const readFixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./__fixtures__/omarchy/${name}`, import.meta.url)), 'utf8')

const osakaJadeToml = readFixture('osaka-jade-4.colors.toml')
const upstreamLatteToml = readFixture('upstream-latte.colors.toml')

function expectParsed(toml: string, mode: 'dark' | 'light'): OmarchyColors {
  const c = parseOmarchyColors(toml)
  expect(c).not.toBeNull()
  if (!c) throw new Error('expected colors')
  expect(c.mode).toBe(mode)
  return c
}

describe('omarchyToOpencodeTheme', () => {
  it('covers every opencode theme color key', () => {
    const c = expectParsed(osakaJadeToml, 'dark')
    const theme = omarchyToOpencodeTheme(c)
    expect(Object.keys(theme).sort()).toEqual([...OPENCODE_THEME_KEYS].sort())
  })

  it('maps the omarchy canvas, accent, and status colors onto the app tokens', () => {
    const c = expectParsed(osakaJadeToml, 'dark')
    const theme = omarchyToOpencodeTheme(c)
    // osaka-jade: bg #111c18, fg #c1c497, accent #509475, ansi red #ff5345
    expect(theme.background).toBe('#111c18')
    expect(theme.text).toBe('#c1c497')
    expect(theme.primary).toBe('#509475')
    expect(theme.accent).toBe('#509475')
    expect(theme.error).toBe('#ff5345')
  })

  it('paints panels lighter than the canvas and selects ink-on-accent', () => {
    const c = expectParsed(osakaJadeToml, 'dark')
    const theme = omarchyToOpencodeTheme(c)
    expect(theme.backgroundPanel).not.toBe(theme.background)
    expect(theme.backgroundElement).not.toBe(theme.background)
    // Selected rows use the accent as their background; the label must stay legible.
    expect(theme.selectedListItemText).toBe(theme.background)
    expect(theme.borderSubtle).toBe(theme.border)
  })

  it('every emitted color is a hex value', () => {
    const c = expectParsed(osakaJadeToml, 'dark')
    const theme = omarchyToOpencodeTheme(c)
    for (const value of Object.values(theme)) expect(value).toMatch(HEX)
  })

  it('transparent mode keeps chrome hex but drops canvas surfaces to none', () => {
    const c = expectParsed(osakaJadeToml, 'dark')
    const theme = omarchyToOpencodeTheme(c, { transparent: true })
    expect(theme.background).toBe('none')
    expect(theme.backgroundPanel).toBe('none')
    expect(theme.diffContextBg).toBe('none')
    // Text/accent/diff colors still resolve so the UI stays readable.
    expect(theme.primary).toMatch(HEX)
    expect(theme.text).toMatch(HEX)
    expect(theme.diffAddedBg).toMatch(HEX)
    expect(theme.backgroundElement).toMatch(HEX)
  })

  it('handles the upstream (schema B) light snapshot', () => {
    const c = expectParsed(upstreamLatteToml, 'light')
    const theme = omarchyToOpencodeTheme(c)
    expect(theme.background).toBe(c.background)
    expect(theme.text).toMatch(HEX)
    expect(theme.primary).toBe(c.accent)
    for (const value of Object.values(theme)) expect(value).toMatch(HEX)
  })
})

describe('omarchyOpencodeThemeDoc', () => {
  it('wraps the theme with the opencode schema reference', () => {
    const c = expectParsed(osakaJadeToml, 'dark')
    const doc = omarchyOpencodeThemeDoc(c)
    expect(doc.$schema).toBe('https://opencode.ai/theme.json')
    expect(Object.keys(doc)).toEqual(['$schema', 'theme'])
    expect(doc.theme.background).toBe('#111c18')
  })
})
