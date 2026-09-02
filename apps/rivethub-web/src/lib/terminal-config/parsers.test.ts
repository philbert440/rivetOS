import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  canApply,
  combineImports,
  detectAlacrittyFormat,
  detectAndParse,
  importPatch,
  MAX_IMPORT_TEXT_BYTES,
  omarchyFontPartner,
  parseAlacritty,
  parseGhostty,
  parseKitty,
  parsePastedPalette,
  parseWindowsTerminal,
  sanitizeConfigFiles,
  type EmulatorKind,
  type TerminalConfigFile,
  type TerminalImport,
} from './index.js'
import {
  finishPalette,
  fontStack,
  hexTokens,
  lineHeightFromPercent,
  MAX_PARSER_CHARS,
  newPaletteDraft,
  normalizeHex,
} from './common.js'
import { parseToml } from './toml.js'
import { parseJsonc, stripJsonComments } from './jsonc.js'
import { isTerminalPalette } from '../terminal-schemes.js'
import { TERMINAL_LIMITS } from '../../stores/terminal-settings.js'

const fixture = (name: string): string =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8')

const HEX = /^#[0-9a-f]{6}$/

/** Every color a parser emits must already be lower-case #rrggbb — the store
 *  and xterm both refuse anything else. */
function expectNormalized(imp: TerminalImport): void {
  expect(imp.palette).toBeDefined()
  const p = imp.palette!
  for (const c of [p.foreground, p.background, p.cursor, p.selectionBackground, ...p.ansi]) {
    if (c !== undefined) expect(c).toMatch(HEX)
  }
  expect(isTerminalPalette(p)).toBe(true)
}

describe('normalizeHex', () => {
  it('accepts every dialect the emulators write', () => {
    expect(normalizeHex('#1E1E2E')).toBe('#1e1e2e')
    expect(normalizeHex('1e1e2e')).toBe('#1e1e2e')
    expect(normalizeHex('0x1d1f21')).toBe('#1d1f21')
    expect(normalizeHex('0X1d1f21')).toBe('#1d1f21')
    expect(normalizeHex('"#abc"')).toBe('#aabbcc')
    expect(normalizeHex('#11223344')).toBe('#112233')
    expect(normalizeHex('#abcd')).toBe('#aabbcc')
    expect(normalizeHex('#112233ff')).toBe('#112233')
  })

  it('drops non-opaque alpha with a warning', () => {
    const a8: string[] = []
    expect(normalizeHex('#11223344', a8)).toBe('#112233')
    expect(a8.some((w) => /44/.test(w))).toBe(true)
    const a4: string[] = []
    expect(normalizeHex('#abcd', a4)).toBe('#aabbcc')
    expect(a4.some((w) => /d/.test(w))).toBe(true)
    expect(normalizeHex('#112233ff', [])).toBe('#112233')
  })

  it('parses kitty/X11 rgb:rr/gg/bb and 16-bit rgb:rrrr/gggg/bbbb', () => {
    expect(normalizeHex('rgb:1d/1f/21')).toBe('#1d1f21')
    expect(normalizeHex('rgb:1d1d/1f1f/2121')).toBe('#1d1f21')
    const w: string[] = []
    expect(normalizeHex('rgb:nope', w)).toBeUndefined()
    expect(w.some((x) => /rgb:/.test(x))).toBe(true)
  })

  it('refuses names, junk, and non-strings rather than guessing', () => {
    expect(normalizeHex('rebeccapurple')).toBeUndefined()
    expect(normalizeHex('#12345')).toBeUndefined()
    expect(normalizeHex(undefined)).toBeUndefined()
    expect(normalizeHex(12)).toBeUndefined()
    expect(normalizeHex(null)).toBeUndefined()
  })
})

describe('hexTokens', () => {
  it('keeps #rgb/#rgba/#rrggbb/#rrggbbaa and 6/8-digit 0x, not 3-digit 0x', () => {
    expect(hexTokens('#add #abcd #112233 #11223344')).toEqual([
      '#aadddd',
      '#aabbcc',
      '#112233',
      '#112233',
    ])
    expect(hexTokens('0x1d1f21 0Xff00aa 0x100 #fff')).toEqual(['#1d1f21', '#ff00aa', '#ffffff'])
    expect(hexTokens('note 0x100 in a comment')).toEqual([])
  })
})

describe('finishPalette', () => {
  it('returns a complete palette and names the empty / fg+bg-only cases', () => {
    const complete = newPaletteDraft()
    complete.foreground = '#eeeeee'
    complete.background = '#111111'
    for (let i = 0; i < 16; i++) complete.ansi[i] = `#${i.toString(16).repeat(6).slice(0, 6)}`
    const none: string[] = []
    expect(finishPalette(complete, none)).toBeDefined()
    expect(none).toEqual([])

    const emptyW: string[] = []
    expect(finishPalette(newPaletteDraft(), emptyW)).toBeUndefined()
    expect(emptyW[0]).toMatch(/^No palette found/)

    const named = newPaletteDraft()
    named.foreground = '#eeeeee'
    named.background = '#111111'
    const namedW: string[] = []
    expect(finishPalette(named, namedW)).toBeUndefined()
    expect(namedW[0]).toMatch(/Incomplete palette/)
    expect(namedW[0]).not.toMatch(/^No palette found/)
  })
})

describe('fontStack', () => {
  it("escapes quotes and backslashes so O'Reilly Mono is valid CSS", () => {
    expect(fontStack(["O'Reilly Mono"])).toBe("'O\\'Reilly Mono', monospace")
    expect(fontStack(['C:\\Fonts\\Mono'])).toBe("'C:\\\\Fonts\\\\Mono', monospace")
  })
})

describe('lineHeightFromPercent', () => {
  it('pins Ghostty relative 10% → 1.1 and kitty absolute 110% → 1.1', () => {
    expect(lineHeightFromPercent('10%', 'relative')).toBeCloseTo(1.1)
    expect(lineHeightFromPercent('110%', 'absolute')).toBeCloseTo(1.1)
    expect(lineHeightFromPercent('0%', 'relative')).toBe(1)
    expect(lineHeightFromPercent('0%', 'absolute')).toBeUndefined()
    expect(lineHeightFromPercent('-10%', 'absolute')).toBeUndefined()
    expect(lineHeightFromPercent('12', 'relative')).toBeUndefined()
    expect(lineHeightFromPercent('10px', 'relative')).toBeUndefined()
    expect(lineHeightFromPercent('NaN%', 'relative')).toBeUndefined()
  })

  it('clamps results outside 0.5–3 and warns', () => {
    const w: string[] = []
    expect(lineHeightFromPercent('400%', 'relative', w)).toBe(3)
    expect(w.some((x) => /clamped/.test(x))).toBe(true)
    const w2: string[] = []
    expect(lineHeightFromPercent('10%', 'absolute', w2)).toBe(0.5)
    expect(w2.some((x) => /clamped/.test(x))).toBe(true)
  })
})

describe('ghostty', () => {
  const text = fixture('ghostty-config')
  const includes = { 'local.conf': fixture('ghostty-local.conf') }

  it('parses the fixture with its config-file include spliced in', () => {
    const imp = parseGhostty(text, { includes })
    expect(imp.warnings).toEqual([])
    expect(imp.fontFamily).toBe("'JetBrains Mono', 'Symbols Nerd Font Mono', monospace")
    // The include is processed where the directive sits — last line, so its
    // font-size and palette entry win.
    expect(imp.fontSize).toBe(14)
    expect(imp.lineHeight).toBeCloseTo(1.08)
    expectNormalized(imp)
    expect(imp.palette!.foreground).toBe('#cdd6f4')
    expect(imp.palette!.background).toBe('#1e1e2e')
    expect(imp.palette!.cursor).toBe('#f5e0dc')
    expect(imp.palette!.selectionBackground).toBe('#353749')
    expect(imp.palette!.ansi[1]).toBe('#ff5555')
    expect(imp.palette!.ansi[15]).toBe('#a6adc8')
  })

  it('warns and keeps going when an include could not be read', () => {
    const imp = parseGhostty(text)
    expect(imp.warnings).toContain('Could not read included config `local.conf`.')
    expect(imp.fontSize).toBe(13)
    expect(imp.palette!.ansi[1]).toBe('#f38ba8')
  })

  it('resolves a theme name we ship as the base layer', () => {
    const imp = parseGhostty('theme = Catppuccin Mocha\nbackground = #000000\n')
    expect(imp.warnings).toEqual([])
    expect(imp.palette!.background).toBe('#000000')
    expect(imp.palette!.foreground).toBe('#cdd6f4')
    expect(imp.palette!.ansi[1]).toBe('#f38ba8')
  })

  it('takes the dark half of a light/dark theme pair', () => {
    const imp = parseGhostty('theme = light:catppuccin-latte,dark:nord\n')
    expect(imp.palette!.background).toBe('#2e3440')
  })

  it('warns instead of inventing colors for a theme it does not ship', () => {
    const imp = parseGhostty('theme = "Kanagawa Dragon"\nfont-size = 12\n')
    expect(imp.palette).toBeUndefined()
    expect(imp.warnings.some((w) => w.includes('Kanagawa Dragon'))).toBe(true)
    expect(imp.fontSize).toBe(12)
  })

  it('does not follow a nested include', () => {
    const nested = [
      'font-size = 99',
      'foreground = #ff00ff',
      'background = #00ff00',
      ...Array.from({ length: 16 }, (_, i) => `palette = ${i}=#ff00ff`),
    ].join('\n')
    const imp = parseGhostty('font-size = 13\nconfig-file = a.conf\nfont-size = 14\n', {
      includes: {
        'a.conf': 'config-file = b.conf\nfont-size = 20\n',
        'b.conf': nested,
      },
    })
    expect(imp.fontSize).toBe(14)
    expect(imp.warnings).toContain('Nested include in `a.conf` was not followed.')
    expect(imp.palette).toBeUndefined()
    expect(JSON.stringify(imp)).not.toContain('#ff00ff')
  })

  it('does not loop on a cyclic include a → b → a', () => {
    const imp = parseGhostty('config-file = a.conf\nfont-size = 13\n', {
      includes: {
        'a.conf': 'config-file = b.conf\nfont-size = 11\n',
        'b.conf': 'config-file = a.conf\nfont-size = 99\n',
      },
    })
    expect(imp.fontSize).toBe(13)
    expect(imp.warnings).toContain('Nested include in `a.conf` was not followed.')
  })

  it('splices config-file = ?path keyed without the ? and stays quiet if missing', () => {
    const present = parseGhostty('font-size = 10\nconfig-file = ?ghostty-optional.conf\n', {
      includes: { 'ghostty-optional.conf': fixture('ghostty-optional.conf') },
    })
    expect(present.fontSize).toBe(16)
    expect(present.warnings).toEqual([])
    expectNormalized(present)

    const missing = parseGhostty('font-size = 10\nconfig-file = ?does-not-exist.conf\n')
    expect(missing.fontSize).toBe(10)
    expect(missing.warnings.every((w) => !/included config/.test(w))).toBe(true)
  })

  it('warns on a palette entry with no =, a bad index, or bad hex', () => {
    const imp = parseGhostty('palette = 1\npalette = 99=#ffffff\npalette = 1=#zzzzzz\n')
    expect(imp.warnings.filter((w) => w.includes('palette entry'))).toHaveLength(3)
  })

  it('refuses palette = =#hex and palette = 0xN=#hex rather than writing a slot', () => {
    const ansi = Array.from({ length: 16 }, (_, i) => `palette = ${i}=#111111`).join('\n')
    const imp = parseGhostty(
      `foreground = #eeeeee\nbackground = #000000\n${ansi}\npalette = =#ffffff\npalette = 0x2=#abcdef\n`,
    )
    expect(imp.warnings.filter((w) => w.includes('palette entry'))).toHaveLength(2)
    expect(imp.palette!.ansi[0]).toBe('#111111')
    expect(imp.palette!.ansi[2]).toBe('#111111')
  })

  it('tries a comma-separated theme list in order and uses the first shipped name', () => {
    const imp = parseGhostty('theme = unknown-theme, nord, dracula\n')
    expect(imp.palette!.background).toBe('#2e3440')
  })

  it('strips a leading BOM', () => {
    expect(parseGhostty('\uFEFFfont-size = 12\n').fontSize).toBe(12)
  })

  it('parses an Omarchy ghostty.conf fixture with bare-hex values', () => {
    const imp = parseGhostty(fixture('omarchy/ghostty.conf'))
    expect(imp.warnings).toEqual([])
    expectNormalized(imp)
    expect(imp.palette!.background).toBe('#111c18')
    expect(imp.palette!.foreground).toBe('#c4d0c8')
    expect(imp.palette!.cursor).toBe('#d3e0d8')
    expect(imp.palette!.selectionBackground).toBe('#2a3f36')
    expect(imp.palette!.ansi[0]).toBe('#0e1714')
    expect(imp.palette!.ansi[15]).toBe('#e8f0ec')
  })

  it('splices config-file = ?"~/.local/state/..." keyed without quotes or ?', () => {
    const key = '~/.local/state/omarchy/current/theme/ghostty.conf'
    const imp = parseGhostty(`font-size = 9\nconfig-file = ?"${key}"\n`, {
      includes: { [key]: fixture('omarchy/ghostty.conf') },
    })
    expect(imp.fontSize).toBe(9)
    expect(imp.warnings).toEqual([])
    expectNormalized(imp)
    expect(imp.palette!.background).toBe('#111c18')
  })
})

describe('omarchy fixtures', () => {
  it('parses the Alacritty and kitty Omarchy theme shapes', () => {
    const al = parseAlacritty(fixture('omarchy/alacritty.toml'), {
      path: 'alacritty.toml',
    })
    expect(al.warnings).toEqual([])
    expectNormalized(al)
    expect(al.palette!.background).toBe('#111c18')
    expect(al.palette!.ansi[1]).toBe('#c45c5c')

    const kt = parseKitty(fixture('omarchy/kitty.conf'))
    expect(kt.warnings).toEqual([])
    expectNormalized(kt)
    expect(kt.palette!.background).toBe('#111c18')
    expect(kt.palette!.cursor).toBe('#d3e0d8')
  })
})

describe('kitty', () => {
  const text = fixture('kitty.conf')
  const includes = { './current-theme.conf': fixture('kitty-theme.conf') }

  it('parses the fixture with its theme include', () => {
    const imp = parseKitty(text, { includes })
    expect(imp.warnings).toEqual([])
    expect(imp.fontFamily).toBe("'FiraCode Nerd Font', monospace")
    expect(imp.fontSize).toBe(12)
    expect(imp.lineHeight).toBeCloseTo(1.1)
    expectNormalized(imp)
    expect(imp.palette!.background).toBe('#282828')
    expect(imp.palette!.cursor).toBe('#ebdbb2')
    expect(imp.palette!.selectionBackground).toBe('#504945')
    expect(imp.palette!.ansi[9]).toBe('#fb4934')
  })

  it('imports the font but no colors when the theme include is missing', () => {
    const imp = parseKitty(text)
    expect(imp.fontFamily).toBe("'FiraCode Nerd Font', monospace")
    expect(imp.palette).toBeUndefined()
    expect(imp.warnings).toContain('Could not read included config `./current-theme.conf`.')
  })

  it('ignores 256-color entries that have no xterm slot', () => {
    const imp = parseKitty('color16 #ff0000\ncolor255 #00ff00\n')
    expect(imp.palette).toBeUndefined()
    expect(imp.warnings.some((w) => w.includes('No palette found'))).toBe(true)
  })

  it('lets a later font_family replace the earlier one and skips family=""', () => {
    const replaced = parseKitty('font_family First\nfont_family Second\n')
    expect(replaced.fontFamily).toBe("'Second', monospace")
    const empty = parseKitty('font_family family="Fira Code"\nfont_family family=""\n')
    expect(empty.fontFamily).toBe("'Fira Code', monospace")
  })

  it('does not follow a nested include; outer font-size wins', () => {
    const nested = [
      'font_size 99',
      'foreground #ff00ff',
      'background #00ff00',
      ...Array.from({ length: 16 }, (_, i) => `color${i} #ff00ff`),
    ].join('\n')
    const imp = parseKitty('include a.conf\nfont_size 14\n', {
      includes: {
        'a.conf': 'include b.conf\nfont_size 20\n',
        'b.conf': nested,
      },
    })
    expect(imp.fontSize).toBe(14)
    expect(imp.warnings).toContain('Nested include in `a.conf` was not followed.')
    expect(imp.palette).toBeUndefined()
    expect(JSON.stringify(imp)).not.toContain('#ff00ff')
  })

  it('does not loop on a cyclic include a → b → a', () => {
    const imp = parseKitty('include a.conf\nfont_size 13\n', {
      includes: {
        'a.conf': 'include b.conf\nfont_size 11\n',
        'b.conf': 'include a.conf\nfont_size 99\n',
      },
    })
    expect(imp.fontSize).toBe(13)
    expect(imp.warnings).toContain('Nested include in `a.conf` was not followed.')
  })

  it('refuses globinclude and envinclude rather than expanding them', () => {
    const imp = parseKitty('globinclude themes/*.conf\nenvinclude KITTY_THEME\nfont_size 12\n', {
      includes: {
        'themes/*.conf': 'font_size 99\n',
        KITTY_THEME: 'font_size 88\n',
      },
    })
    expect(imp.fontSize).toBe(12)
    expect(imp.warnings.some((w) => w.includes('globinclude'))).toBe(true)
    expect(imp.warnings.some((w) => w.includes('envinclude'))).toBe(true)
  })

  it('reads modify_font cell_height 110% as an absolute 1.1', () => {
    expect(parseKitty('modify_font cell_height 110%\n').lineHeight).toBeCloseTo(1.1)
  })
})

describe('alacritty', () => {
  it('parses the TOML fixture with its theme import as the base layer', () => {
    const imp = parseAlacritty(fixture('alacritty.toml'), {
      path: '/home/u/.config/alacritty/alacritty.toml',
      includes: { 'themes/tokyonight.toml': fixture('alacritty-theme.toml') },
    })
    expect(imp.warnings).toEqual([])
    expect(imp.fontFamily).toBe("'JetBrains Mono', monospace")
    expect(imp.fontSize).toBe(11.5)
    expectNormalized(imp)
    // The importing file overrides the theme it imported.
    expect(imp.palette!.background).toBe('#16161e')
    expect(imp.palette!.foreground).toBe('#c0caf5')
    expect(imp.palette!.cursor).toBe('#c0caf5')
    expect(imp.palette!.selectionBackground).toBe('#283457')
    expect(imp.palette!.ansi[5]).toBe('#bb9af7')
    expect(imp.palette!.ansi[8]).toBe('#414868')
  })

  it('warns when the imported theme is unavailable', () => {
    const imp = parseAlacritty(fixture('alacritty.toml'), { path: 'alacritty.toml' })
    expect(imp.palette).toBeUndefined()
    expect(imp.warnings).toContain('Could not read imported config `themes/tokyonight.toml`.')
  })

  it('parses the legacy YAML shape, 0x colors and all', () => {
    const imp = parseAlacritty(fixture('alacritty.yml'), { path: 'alacritty.yml' })
    expect(imp.warnings).toEqual([])
    expect(imp.fontFamily).toBe("'Fira Code', monospace")
    expect(imp.fontSize).toBe(12)
    expectNormalized(imp)
    expect(imp.palette!.background).toBe('#1d1f21')
    expect(imp.palette!.ansi[3]).toBe('#f0c674')
  })

  it('detects the format from the extension, then from the content', () => {
    expect(detectAlacrittyFormat('anything', 'a/alacritty.yml')).toBe('yaml')
    expect(detectAlacrittyFormat('anything', 'a/alacritty.toml')).toBe('toml')
    expect(detectAlacrittyFormat(fixture('alacritty.yml'))).toBe('yaml')
    expect(detectAlacrittyFormat(fixture('alacritty.toml'))).toBe('toml')
  })

  it('reports a broken config as a warning rather than throwing', () => {
    const imp = parseAlacritty('[font\nsize = ', { format: 'toml' })
    expect(imp.palette).toBeUndefined()
    expect(imp.warnings).toHaveLength(1)
    expect(imp.warnings[0]).toContain('Could not read this TOML config')
  })

  it('splices import = ["./themes/x.toml"] using the same key main records', () => {
    const imp = parseAlacritty('import = ["./themes/x.toml"]\n', {
      format: 'toml',
      includes: { './themes/x.toml': fixture('alacritty-theme.toml') },
    })
    expect(imp.palette!.background).toBe('#1a1b26')
    expect(imp.palette!.ansi[5]).toBe('#bb9af7')
  })

  it('normalises quoted 0x colours in TOML and never Number()s them', () => {
    const imp = parseAlacritty(
      '[colors.primary]\nbackground = "0x1d1f21"\nforeground = "0xc5c8c6"\n',
      { format: 'toml' },
    )
    expect(imp.warnings.some((w) => w.includes('colors.primary.background'))).toBe(false)
    expect(imp.warnings.some((w) => w.includes('colors.primary.foreground'))).toBe(false)
  })

  it('warns when an included file names its own import', () => {
    const imp = parseAlacritty('import = ["theme.toml"]\n', {
      format: 'toml',
      includes: { 'theme.toml': 'import = ["other.toml"]\n' },
    })
    expect(imp.warnings.some((w) => /nested imports not followed/i.test(w))).toBe(true)
  })

  it('prefers [general].import over a leftover top-level import', () => {
    const imp = parseAlacritty(
      'import = ["top.toml"]\n[general]\nimport = ["themes/tokyonight.toml"]\n',
      {
        format: 'toml',
        includes: {
          'themes/tokyonight.toml': fixture('alacritty-theme.toml'),
          'top.toml': '[font.normal]\nfamily = "TopFont"\n',
        },
      },
    )
    expect(imp.warnings.some((w) => w.includes('top-level'))).toBe(true)
    expect(imp.palette!.background).toBe('#1a1b26')
    // top.toml must not be merged — that would leak TopFont into the result.
    expect(imp.fontFamily).toBeUndefined()
  })

  it('warns when YAML parses to a non-object', () => {
    const imp = parseAlacritty('[]\n', { format: 'yaml' })
    expect(imp.warnings.some((w) => /mapping/i.test(w))).toBe(true)
  })

  it('does not follow a nested import; outer font size wins', () => {
    const nested = [
      '[font]',
      'size = 99',
      '[font.normal]',
      'family = "Nested"',
      '[colors.primary]',
      'background = "#ff00ff"',
      'foreground = "#00ff00"',
    ].join('\n')
    const imp = parseAlacritty('import = ["a.toml"]\n[font]\nsize = 14\n', {
      format: 'toml',
      includes: {
        'a.toml': 'import = ["b.toml"]\n[font]\nsize = 20\n',
        'b.toml': nested,
      },
    })
    expect(imp.fontSize).toBe(14)
    expect(imp.warnings.some((w) => /nested imports not followed/i.test(w))).toBe(true)
    expect(imp.fontFamily).toBeUndefined()
    expect(JSON.stringify(imp)).not.toContain('#ff00ff')
  })

  it('does not loop on a cyclic import a → b → a', () => {
    const imp = parseAlacritty('import = ["a.toml"]\n[font]\nsize = 13\n', {
      format: 'toml',
      includes: {
        'a.toml': 'import = ["b.toml"]\n[font]\nsize = 11\n',
        'b.toml': 'import = ["a.toml"]\n[font]\nsize = 99\n',
      },
    })
    expect(imp.fontSize).toBe(13)
    expect(imp.warnings.some((w) => /nested imports not followed/i.test(w))).toBe(true)
  })

  it('accepts import = "single.toml" (string form)', () => {
    const imp = parseAlacritty('import = "themes/tokyonight.toml"\n', {
      format: 'toml',
      includes: { 'themes/tokyonight.toml': fixture('alacritty-theme.toml') },
    })
    expect(imp.palette!.background).toBe('#1a1b26')
  })

  it('does not apply extra include-map keys that look like path escapes', () => {
    const poison = '[font.normal]\nfamily = "Escaped"\n[font]\nsize = 99\n'
    const imp = parseAlacritty('[font]\nsize = 12\n', {
      format: 'toml',
      includes: {
        '../x.toml': poison,
        '/etc/x.toml': poison,
        '~/x.toml': poison,
      },
    })
    expect(imp.fontSize).toBe(12)
    expect(imp.fontFamily).toBeUndefined()
  })

  it('reports broken YAML as a warning rather than throwing', () => {
    const imp = parseAlacritty(':\n!!\n{{{', { format: 'yaml', path: 'alacritty.yml' })
    expect(imp.palette).toBeUndefined()
    expect(imp.warnings).toHaveLength(1)
    expect(imp.warnings[0]).toMatch(/YAML/i)
  })

  it('ignores !!js/function rather than executing an unsafe tag', () => {
    const imp = parseAlacritty("fn: !!js/function 'function () { return 1 }'\n", {
      format: 'yaml',
      path: 'alacritty.yml',
    })
    expect(imp.palette).toBeUndefined()
    expect(imp.warnings.length).toBeGreaterThanOrEqual(1)
    expect(typeof (imp as { fn?: unknown }).fn).not.toBe('function')
  })
})

describe('toml reader', () => {
  it('handles the subset Alacritty writes', () => {
    const t = parseToml(
      [
        '# comment',
        'import = ["a.toml", "b.toml"]',
        '[window]',
        'padding = { x = 6, y = 6 }',
        'opacity = 0.95',
        'decorations = "none" # trailing comment',
        'live = true',
        '[[keyboard.bindings]]',
        'key = "N"',
      ].join('\n'),
    )
    expect(t.import).toEqual(['a.toml', 'b.toml'])
    expect(t.window).toEqual({
      padding: { x: 6, y: 6 },
      opacity: 0.95,
      decorations: 'none',
      live: true,
    })
    expect(t.keyboard).toEqual({ bindings: [{ key: 'N' }] })
  })

  it('does not pollute Object.prototype via a __proto__ key', () => {
    const warnings: string[] = []
    parseToml('__proto__ = { polluted = true }\n', warnings)
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined()
    expect(Object.prototype.hasOwnProperty.call({}, 'polluted')).toBe(false)
  })

  it('warns on a constructor key rather than writing it', () => {
    const warnings: string[] = []
    const t = parseToml('constructor = "nope"\nfoo = 1\n', warnings)
    expect(warnings.some((w) => w.includes('constructor'))).toBe(true)
    expect(t.foo).toBe(1)
    expect(Object.hasOwn(t, 'constructor')).toBe(false)
  })

  it('rejects invalid \\u/\\U escapes, a trailing backslash, and unknown escapes', () => {
    expect(parseToml('a = "\\u0041"\n').a).toBe('A')
    expect(() => parseToml('a = "\\U00110000"\n')).toThrow(/unicode/)
    expect(() => parseToml('a = "\\u12"\n')).toThrow(/unicode/)
    expect(() => parseToml('a = "foo\\')).toThrow(/unterminated/)
    expect(() => parseToml('a = "\\q"\n')).toThrow(/unknown escape/)
  })

  it('errors on double assignment and on [[a]] over an existing table', () => {
    expect(() => parseToml('a = 1\na = 2\n')).toThrow(/duplicate/)
    expect(() => parseToml('[a]\nb = 1\n[[a]]\nc = 2\n')).toThrow(/existing table/)
  })

  it('fails when values nest more than 32 deep', () => {
    let s = '0'
    for (let i = 0; i < 34; i++) s = `[${s}]`
    expect(() => parseToml(`x = ${s}\n`)).toThrow(/nested too deeply/)
  })
})

describe('windows terminal', () => {
  const text = fixture('windows-terminal-settings.json')

  it('parses the commented settings.json and resolves the named scheme', () => {
    const imp = parseWindowsTerminal(text)
    expect(imp.warnings).toEqual([])
    expect(imp.fontFamily).toBe("'Cascadia Mono', monospace")
    expect(imp.fontSize).toBe(12)
    expect(imp.lineHeight).toBe(1.2)
    expectNormalized(imp)
    // "One Half Dark", not the first scheme in the array.
    expect(imp.palette!.background).toBe('#282c34')
    expect(imp.palette!.selectionBackground).toBe('#474e5d')
    // WT's `purple` is xterm's magenta slot.
    expect(imp.palette!.ansi[5]).toBe('#c678dd')
    expect(imp.palette!.ansi[13]).toBe('#c678dd')
  })

  it('keeps // inside a string value', () => {
    expect(stripJsonComments('{"a": "https://x/y", // c\n "b": 1}')).toBe(
      '{"a": "https://x/y", \n "b": 1}',
    )
  })

  it('does not rewrite ", }" or https:// inside strings, and drops real trailing commas', () => {
    expect(parseJsonc('{"a": "foo, } bar", "b": "https://example.com",}')).toEqual({
      a: 'foo, } bar',
      b: 'https://example.com',
    })
    expect(parseJsonc('{"a": 1,}')).toEqual({ a: 1 })
    expect(parseJsonc('[1, 2,]')).toEqual([1, 2])
  })

  it('replaces a block comment with a space so tokens cannot fuse', () => {
    expect(parseJsonc('{"a"/*x*/:1}')).toEqual({ a: 1 })
    expect(stripJsonComments('1/*x*/2')).toBe('1 2')
  })

  it('fails an unclosed block comment rather than returning truncated JSON', () => {
    expect(() => parseJsonc('{"a": 1 /* unterminated')).toThrow(/Unclosed block comment/)
    const imp = parseWindowsTerminal('{"profiles":{"defaults":{}} /*')
    expect(imp.palette).toBeUndefined()
    expect(imp.warnings).toHaveLength(1)
    expect(imp.warnings[0]).toMatch(/Unclosed block comment/)
  })

  it('parses a stock settings.json (empty defaults, defaultProfile + list scheme)', () => {
    const imp = parseWindowsTerminal(fixture('windows-terminal-stock.json'))
    expect(imp.warnings).toEqual([])
    expect(imp.fontFamily).toBe("'Cascadia Code', monospace")
    expect(imp.fontSize).toBe(14)
    expectNormalized(imp)
    // Built-in One Half Dark — schemes array is empty.
    expect(imp.palette!.background).toBe('#282c34')
    expect(imp.palette!.selectionBackground).toBe('#ffffff')
    expect(imp.palette!.ansi[5]).toBe('#c678dd')
  })

  it('reads font.face / font.size from the nested font object', () => {
    const imp = parseWindowsTerminal(
      '{"profiles":{"defaults":{"font":{"face":"Iosevka","size":16,"cellHeight":1.2}},"list":[]}}',
    )
    expect(imp.fontFamily).toBe("'Iosevka', monospace")
    expect(imp.fontSize).toBe(16)
    expect(imp.lineHeight).toBe(1.2)
  })

  it('accepts cellHeight as a number, "120%", or ".9", and warns on px', () => {
    expect(
      parseWindowsTerminal('{"profiles":{"defaults":{"font":{"cellHeight":"120%"}}}}').lineHeight,
    ).toBeCloseTo(1.2)
    expect(
      parseWindowsTerminal('{"profiles":{"defaults":{"font":{"cellHeight":".9"}}}}').lineHeight,
    ).toBeCloseTo(0.9)
    const px = parseWindowsTerminal('{"profiles":{"defaults":{"font":{"cellHeight":"20px"}}}}')
    expect(px.lineHeight).toBeUndefined()
    expect(px.warnings.some((w) => /pixels/.test(w))).toBe(true)
  })

  it('resolves a built-in scheme by name when the user schemes array has no match', () => {
    const imp = parseWindowsTerminal(
      '{"profiles":{"defaults":{"colorScheme":"Vintage"}},"schemes":[]}',
    )
    expect(imp.warnings).toEqual([])
    expect(imp.palette!.background).toBe('#000000')
    expect(imp.palette!.foreground).toBe('#c0c0c0')
    expect(imp.palette!.ansi[1]).toBe('#800000')
  })

  it('defaults to Campbell when no colorScheme is named', () => {
    const imp = parseWindowsTerminal('{"profiles":{"defaults":{},"list":[]}}')
    expect(imp.palette!.background).toBe('#0c0c0c')
    expect(imp.palette!.foreground).toBe('#cccccc')
  })

  it('warns when the named scheme is not defined', () => {
    const imp = parseWindowsTerminal(
      '{"profiles":{"defaults":{"colorScheme":"Nope"}},"schemes":[]}',
    )
    expect(imp.palette).toBeUndefined()
    expect(imp.warnings).toContain(
      'Color scheme `Nope` matches neither a built-in scheme nor one in this settings.json.',
    )
  })

  it('does not treat Object.prototype names as built-in schemes', () => {
    const imp = parseWindowsTerminal(
      '{"profiles":{"defaults":{"colorScheme":"toString"}},"schemes":[]}',
    )
    expect(imp.palette).toBeUndefined()
    expect(imp.warnings).toContain(
      'Color scheme `toString` matches neither a built-in scheme nor one in this settings.json.',
    )
  })

  it('takes the dark half of a light/dark colorScheme pair and warns that light was ignored', () => {
    const imp = parseWindowsTerminal(
      JSON.stringify({
        profiles: { defaults: { colorScheme: { dark: 'Campbell', light: 'One Half Dark' } } },
        schemes: (parseJsonc(text) as { schemes: unknown[] }).schemes,
      }),
    )
    expect(imp.palette!.background).toBe('#0c0c0c')
    expect(
      imp.warnings.some(
        (w) => w.includes('Campbell') && w.includes('One Half Dark') && /light/.test(w),
      ),
    ).toBe(true)
  })
})

describe('detectAndParse', () => {
  it('routes each kind to its parser', () => {
    expect(
      detectAndParse('ghostty', {
        text: fixture('ghostty-config'),
        includes: { 'local.conf': fixture('ghostty-local.conf') },
      }).fontSize,
    ).toBe(14)
    expect(detectAndParse('kitty', { text: fixture('kitty.conf') }).fontSize).toBe(12)
    expect(
      detectAndParse('alacritty', { text: fixture('alacritty.yml'), path: 'alacritty.yml' })
        .fontSize,
    ).toBe(12)
    expect(
      detectAndParse('windows-terminal', { text: fixture('windows-terminal-settings.json') })
        .fontSize,
    ).toBe(12)
    expect(
      detectAndParse('omarchy', {
        text: fixture('omarchy/ghostty.conf'),
        path: '/home/u/.local/state/omarchy/current/theme/ghostty.conf',
      }).palette?.background,
    ).toBe('#111c18')
    expect(
      detectAndParse('omarchy', {
        text: fixture('omarchy/alacritty.toml'),
        path: '/home/u/.local/state/omarchy/current/theme/alacritty.toml',
      }).palette?.background,
    ).toBe('#111c18')
    expect(
      detectAndParse('omarchy', {
        text: fixture('omarchy/kitty.conf'),
        path: '/home/u/.local/state/omarchy/current/theme/kitty.conf',
      }).palette?.background,
    ).toBe('#111c18')
  })

  it('maps a throw to a warning import with no fields', () => {
    const imp = detectAndParse('ghostty', { text: null as unknown as string })
    expect(imp.fontFamily).toBeUndefined()
    expect(imp.fontSize).toBeUndefined()
    expect(imp.palette).toBeUndefined()
    expect(imp.warnings[0]).toMatch(/Could not read this config/)
  })

  it('returns a warning for an unknown kind rather than undefined', () => {
    const imp = detectAndParse('nope' as EmulatorKind, { text: '' })
    expect(imp).toEqual({ warnings: ['Unknown emulator config kind `nope`.'] })
  })
})

describe('sanitizeConfigFiles', () => {
  it('drops a malformed IPC payload before parsing', () => {
    expect(sanitizeConfigFiles(null)).toEqual([])
    expect(sanitizeConfigFiles({})).toEqual([])
    expect(sanitizeConfigFiles([{ kind: 'bogus', path: '/x', text: 'a', includes: {} }])).toEqual(
      [],
    )
    expect(sanitizeConfigFiles([{ kind: 'ghostty', path: '/x', text: 1, includes: {} }])).toEqual(
      [],
    )
    expect(
      sanitizeConfigFiles([
        {
          kind: 'ghostty',
          path: '/x',
          text: 'a'.repeat(MAX_IMPORT_TEXT_BYTES + 1),
          includes: {},
        },
      ]),
    ).toEqual([])
  })

  it('keeps a well-shaped file and caps include text', () => {
    const files = sanitizeConfigFiles([
      {
        kind: 'ghostty',
        path: '/cfg/config',
        text: 'font-size = 12\n',
        includes: { 'a.conf': 'ok', 'b.conf': 1, 'c.conf': 'x'.repeat(MAX_IMPORT_TEXT_BYTES + 1) },
      },
    ])
    expect(files).toHaveLength(1)
    expect(files[0].includes).toEqual({ 'a.conf': 'ok' })
  })

  it('keeps an Omarchy themeName and drops a non-string one', () => {
    const files = sanitizeConfigFiles([
      {
        kind: 'omarchy',
        path: '/home/u/.local/state/omarchy/current/theme/ghostty.conf',
        text: 'background = #111c18\n',
        includes: {},
        themeName: 'tokyo-night',
      },
      {
        kind: 'omarchy',
        path: '/x/ghostty.conf',
        text: 'a',
        includes: {},
        themeName: 12,
      },
    ])
    expect(files[0].themeName).toBe('tokyo-night')
    expect(files[1].themeName).toBeUndefined()
  })

  it('keeps usesOmarchy only when it is the boolean true', () => {
    const files = sanitizeConfigFiles([
      {
        kind: 'alacritty',
        path: '/cfg/alacritty.toml',
        text: 'x',
        includes: {},
        usesOmarchy: true,
      },
      {
        kind: 'ghostty',
        path: '/cfg/config',
        text: 'x',
        includes: {},
        usesOmarchy: false,
      },
      {
        kind: 'kitty',
        path: '/cfg/kitty.conf',
        text: 'x',
        includes: {},
        usesOmarchy: 'yes',
      },
    ])
    expect(files[0].usesOmarchy).toBe(true)
    expect(files[1].usesOmarchy).toBeUndefined()
    expect(files[2].usesOmarchy).toBeUndefined()
  })
})

describe('pasted palettes', () => {
  it('reads Ghostty palette lines', () => {
    const lines = [
      'background = #1e1e2e',
      'foreground = #cdd6f4',
      ...Array.from(
        { length: 16 },
        (_, i) => `palette = ${i}=#0000${i.toString(16)}${i.toString(16)}`,
      ),
    ].join('\n')
    const imp = parsePastedPalette(lines)
    expectNormalized(imp)
    expect(imp.palette!.ansi[10]).toBe('#0000aa')
  })

  it('reads a bare 16-line hex list, deriving only the missing fg/bg slots', () => {
    const list = fixture('kitty-theme.conf')
      .split('\n')
      .filter((l) => /^color\d+\s/.test(l))
      .map((l) => l.split(/\s+/)[1])
      .join('\n')
    const imp = parsePastedPalette(list)
    expectNormalized(imp)
    expect(imp.palette!.background).toBe('#282828')
    expect(imp.palette!.foreground).toBe('#a89984')
    expect(imp.warnings.some((w) => w.includes('No foreground') && w.includes('ANSI white'))).toBe(
      true,
    )
    expect(imp.warnings.some((w) => w.includes('No background') && w.includes('ANSI black'))).toBe(
      true,
    )
  })

  it('reads a one-line 16-hex paste that starts with #', () => {
    const colors = [
      '#1d1f21',
      '#cc342b',
      '#198844',
      '#fba922',
      '#3971ed',
      '#a36ac7',
      '#3971ed',
      '#c5c8c6',
      '#969896',
      '#cc342b',
      '#198844',
      '#fba922',
      '#3971ed',
      '#a36ac7',
      '#3971ed',
      '#ffffff',
    ]
    const imp = parsePastedPalette(colors.join(' '))
    expectNormalized(imp)
    expect(imp.palette!.background).toBe('#1d1f21')
    expect(imp.palette!.foreground).toBe('#c5c8c6')
    expect(imp.palette!.ansi[15]).toBe('#ffffff')
  })

  it('reads kitty colorN #hex and colorN hex without a hash', () => {
    const lines = [
      'foreground #eeeeee',
      'background #111111',
      ...Array.from({ length: 8 }, (_, i) => `color${i} #${'0'.repeat(6)}`),
      ...Array.from({ length: 8 }, (_, i) => `color${i + 8} ${'a'.repeat(6)}`),
    ].join('\n')
    const imp = parsePastedPalette(lines)
    expectNormalized(imp)
    expect(imp.palette!.ansi[0]).toBe('#000000')
    expect(imp.palette!.ansi[8]).toBe('#aaaaaa')
  })

  it('does not treat a bare N = #hex as indexed, and does not skip named slots after a failed index', () => {
    const lines = [
      '0 = #ff0000',
      'selection_bg #123456 color16 #abcdef',
      'foreground = #cdd6f4',
      'background = #1e1e2e',
      ...Array.from(
        { length: 16 },
        (_, i) => `palette = ${i}=#${(i + 1).toString(16).repeat(6).slice(0, 6)}`,
      ),
    ]
    const imp = parsePastedPalette(lines.join('\n'))
    expectNormalized(imp)
    expect(imp.palette!.ansi[0]).not.toBe('#ff0000')
    expect(imp.palette!.selectionBackground).toBe('#123456')
  })

  it('ignores selection_foreground / cursor_fg / cursor_text_color', () => {
    const imp = parsePastedPalette(`
      foreground = #cdd6f4
      background = #1e1e2e
      cursor_fg = #ff0000
      cursor_text_color = #00ff00
      selection_foreground = #0000ff
      selection_fg = #ffffff
      ${Array.from({ length: 16 }, (_, i) => `palette = ${i}=#${i.toString(16).repeat(6).slice(0, 6)}`).join('\n')}
    `)
    expectNormalized(imp)
    expect(imp.palette!.cursor).toBeUndefined()
    expect(imp.palette!.selectionBackground).toBeUndefined()
  })

  it('reads Ghostty selection-background before foreground/background', () => {
    const ansi = Array.from(
      { length: 16 },
      (_, i) => `palette = ${i}=#${i.toString(16).repeat(6).slice(0, 6)}`,
    ).join('\n')
    const imp = parsePastedPalette(`
      ${ansi}
      selection-background = #111111
      selection-foreground = #222222
      foreground = #cdd6f4
      background = #1e1e2e
    `)
    expectNormalized(imp)
    expect(imp.palette!.foreground).toBe('#cdd6f4')
    expect(imp.palette!.background).toBe('#1e1e2e')
    expect(imp.palette!.selectionBackground).toBe('#111111')
  })

  it('derives only the missing fg or bg slot and names it', () => {
    const colors = Array.from(
      { length: 16 },
      (_, i) => `#${(i + 1).toString(16).repeat(6).slice(0, 6)}`,
    )
    const withFg = parsePastedPalette(`foreground = #cdd6f4\n${colors.join('\n')}`)
    expect(withFg.palette!.foreground).toBe('#cdd6f4')
    expect(withFg.palette!.background).toBe(colors[0])
    expect(withFg.warnings.some((w) => w.includes('No background'))).toBe(true)
    expect(withFg.warnings.some((w) => w.includes('No foreground'))).toBe(false)
  })

  it('reads a WezTerm colors block (the Lua escape hatch)', () => {
    const imp = parsePastedPalette(`
      -- wezterm.lua
      config.colors = {
        foreground = '#cdd6f4',
        background = '#1e1e2e',
        cursor_bg = '#f5e0dc',
        selection_bg = '#353749',
        ansi = { '#45475a', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#bac2de' },
        brights = { '#585b70', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#a6adc8' },
      }
    `)
    expect(imp.warnings).toEqual([])
    expectNormalized(imp)
    expect(imp.palette!.foreground).toBe('#cdd6f4')
    expect(imp.palette!.cursor).toBe('#f5e0dc')
    expect(imp.palette!.selectionBackground).toBe('#353749')
    expect(imp.palette!.ansi[8]).toBe('#585b70')
  })

  it('refuses a partial paste rather than half-applying it', () => {
    const imp = parsePastedPalette('#ff0000\n#00ff00\n#0000ff\n')
    expect(imp.palette).toBeUndefined()
    expect(imp.warnings[0]).toContain('Incomplete pasted palette')
    expect(imp.warnings[0]).toMatch(/missing:/)
    expect(imp.warnings.slice(1).some((w) => w.includes('No background'))).toBe(true)
  })

  it('maps a throw to a warning import with no fields', () => {
    const imp = parsePastedPalette(null as unknown as string)
    expect(imp.palette).toBeUndefined()
    expect(imp.warnings[0]).toMatch(/Could not read this config/)
  })
})

describe('importPatch', () => {
  it('carries font settings and the palette, and names the source', () => {
    const imp = parseGhostty(fixture('ghostty-config'), {
      includes: { 'local.conf': fixture('ghostty-local.conf') },
    })
    const patch = importPatch(imp)
    expect(patch.fontSize).toBe(14)
    expect(patch.themeSource).toBe('imported')
    expect(patch.imported).toEqual(imp.palette)
    expect(canApply(imp)).toBe(true)
  })

  it('never claims an imported theme source without a palette', () => {
    const patch = importPatch({ fontSize: 11, warnings: [] })
    expect(patch).toEqual({ fontSize: 11 })
    expect(canApply({ fontSize: 11, warnings: [] })).toBe(true)
  })

  it('has nothing to apply for a config that yielded nothing', () => {
    expect(canApply({ warnings: ['nope'] })).toBe(false)
    expect(importPatch({ warnings: [] })).toEqual({})
  })

  it('omits 0, NaN, Infinity and negative sizes; clamps the rest to store limits', () => {
    expect(importPatch({ fontSize: 0, warnings: [] })).toEqual({})
    expect(importPatch({ fontSize: Number.NaN, warnings: [] })).toEqual({})
    expect(importPatch({ fontSize: Number.POSITIVE_INFINITY, warnings: [] })).toEqual({})
    expect(importPatch({ fontSize: -3, warnings: [] })).toEqual({})
    expect(importPatch({ lineHeight: 0, warnings: [] })).toEqual({})
    expect(importPatch({ lineHeight: Number.NaN, warnings: [] })).toEqual({})
    expect(importPatch({ lineHeight: Number.POSITIVE_INFINITY, warnings: [] })).toEqual({})
    expect(importPatch({ lineHeight: -1, warnings: [] })).toEqual({})
    expect(importPatch({ fontSize: 4, warnings: [] }).fontSize).toBe(TERMINAL_LIMITS.fontSize.min)
    expect(importPatch({ fontSize: 99, warnings: [] }).fontSize).toBe(TERMINAL_LIMITS.fontSize.max)
    expect(importPatch({ lineHeight: 0.5, warnings: [] }).lineHeight).toBe(
      TERMINAL_LIMITS.lineHeight.min,
    )
    expect(importPatch({ lineHeight: 9, warnings: [] }).lineHeight).toBe(
      TERMINAL_LIMITS.lineHeight.max,
    )
  })
})

describe('combineImports', () => {
  it('keeps emulator fonts and overlays the Omarchy palette', () => {
    const emulator = parseGhostty(
      'font-family = "JetBrainsMono Nerd Font"\nfont-size = 9\nforeground = #ffffff\nbackground = #000000\n' +
        Array.from({ length: 16 }, (_, i) => `palette = ${i}=#111111`).join('\n'),
    )
    const omarchy = parseGhostty(fixture('omarchy/ghostty.conf'))
    const combined = combineImports(emulator, omarchy, 'ghostty')
    expect(combined.fontFamily).toBe("'JetBrainsMono Nerd Font', monospace")
    expect(combined.fontSize).toBe(9)
    expect(combined.palette!.background).toBe('#111c18')
    expect(combined.palette!.foreground).toBe('#c4d0c8')
    expect(combined.palette!.ansi[1]).toBe('#c45c5c')
    expect(combined.warnings).toEqual([])
  })

  it('does not let an Omarchy font override the emulator, and falls back either way', () => {
    const emulator: TerminalImport = {
      fontFamily: "'Emu', monospace",
      fontSize: 9,
      warnings: ['emu'],
    }
    const omarchy: TerminalImport = {
      fontFamily: "'Omar', monospace",
      fontSize: 12,
      palette: parseGhostty(fixture('omarchy/ghostty.conf')).palette,
      warnings: ['omar'],
    }
    const combined = combineImports(emulator, omarchy, 'ghostty')
    expect(combined.fontFamily).toBe("'Emu', monospace")
    expect(combined.fontSize).toBe(9)
    expect(combined.palette!.background).toBe('#111c18')
    expect(combined.warnings).toEqual(['[ghostty] emu', '[omarchy] omar'])

    const fontsOnly = combineImports(
      { fontFamily: "'Emu', monospace", warnings: [] },
      { warnings: [] },
      'ghostty',
    )
    expect(fontsOnly.fontFamily).toBe("'Emu', monospace")
    expect(fontsOnly.palette).toBeUndefined()

    const paletteOnly = combineImports({ warnings: [] }, omarchy, 'ghostty')
    expect(paletteOnly.fontFamily).toBe("'Omar', monospace")
    expect(paletteOnly.palette!.background).toBe('#111c18')
  })

  it('drops emulator palette warnings when the Omarchy palette wins, and tags the rest', () => {
    const emulator = parseGhostty('font-family = "JetBrains Mono"\nfont-size = 9\n')
    expect(emulator.warnings.some((w) => /No palette found/.test(w))).toBe(true)
    const omarchy = parseGhostty(fixture('omarchy/ghostty.conf'))
    const combined = combineImports(emulator, omarchy, 'ghostty')
    expect(combined.palette!.background).toBe('#111c18')
    expect(combined.warnings.some((w) => /No palette found/.test(w))).toBe(false)
    expect(combined.fontFamily).toBe("'JetBrains Mono', monospace")

    const partial: TerminalImport = {
      fontFamily: "'Emu', monospace",
      warnings: [
        'Incomplete palette — missing: 14 of 16 ANSI colors. Colors were not imported.',
        'font-size ignored',
      ],
    }
    const tagged = combineImports(partial, omarchy, 'alacritty')
    expect(tagged.warnings).toEqual(['[alacritty] font-size ignored'])
  })

  it('keeps emulator palette warnings when Omarchy has no palette', () => {
    const combined = combineImports(
      { warnings: ['No palette found in this config.'] },
      { warnings: ['No palette found in this config.'] },
      'kitty',
    )
    expect(combined.warnings).toEqual([
      '[kitty] No palette found in this config.',
      '[omarchy] No palette found in this config.',
    ])
  })
})

describe('omarchyFontPartner', () => {
  const file = (
    kind: TerminalConfigFile['kind'],
    over: Partial<TerminalConfigFile> = {},
  ): TerminalConfigFile => ({
    kind,
    path: `/cfg/${kind}`,
    text: 'x',
    includes: {},
    ...over,
  })

  it('prefers the emulator flagged usesOmarchy over candidate order', () => {
    const ghostty = file('ghostty')
    const alacritty = file('alacritty', { usesOmarchy: true })
    const kitty = file('kitty')
    const omarchy = file('omarchy', { themeName: 'tokyo-night' })
    expect(omarchyFontPartner([omarchy, ghostty, alacritty, kitty])).toBe(alacritty)
  })

  it('falls back to the first non-omarchy config when none include the theme', () => {
    const ghostty = file('ghostty')
    const alacritty = file('alacritty')
    expect(omarchyFontPartner([file('omarchy'), ghostty, alacritty])).toBe(ghostty)
    expect(omarchyFontPartner([file('omarchy')])).toBeUndefined()
    expect(omarchyFontPartner([])).toBeUndefined()
  })
})

describe('parser input caps', () => {
  it('stops at 1 MB rather than walking the rest', () => {
    const huge = 'x'.repeat(MAX_PARSER_CHARS + 1)
    expect(parseGhostty(huge).warnings[0]).toMatch(/1 MB/)
    expect(parseKitty(huge).warnings[0]).toMatch(/1 MB/)
    expect(parseAlacritty(huge).warnings[0]).toMatch(/1 MB/)
    expect(parseWindowsTerminal(huge).warnings[0]).toMatch(/1 MB/)
    expect(parsePastedPalette(huge).warnings[0]).toMatch(/1 MB/)
    expect(() => parseJsonc(huge)).toThrow(/1 MB/)
  })

  it('refuses an oversize include body with one warning and no palette', () => {
    const huge = 'x'.repeat(MAX_PARSER_CHARS + 1)
    const ghostty = parseGhostty('config-file = a.conf\n', { includes: { 'a.conf': huge } })
    expect(ghostty.palette).toBeUndefined()
    expect(ghostty.warnings).toHaveLength(1)
    expect(ghostty.warnings[0]).toMatch(/1 MB/)

    const kitty = parseKitty('include a.conf\n', { includes: { 'a.conf': huge } })
    expect(kitty.palette).toBeUndefined()
    expect(kitty.warnings).toHaveLength(1)
    expect(kitty.warnings[0]).toMatch(/1 MB/)

    const alacritty = parseAlacritty('import = ["a.toml"]\n', {
      format: 'toml',
      includes: { 'a.toml': huge },
    })
    expect(alacritty.palette).toBeUndefined()
    expect(alacritty.warnings).toHaveLength(1)
    expect(alacritty.warnings[0]).toMatch(/1 MB/)
  })
})
