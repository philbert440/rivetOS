#!/usr/bin/env -S npx tsx
/**
 * rivethub-opencode-theme — generate an opencode custom theme from the
 * RivetHub desktop app's Omarchy color snapshot.
 *
 * The desktop app resolves its palette in src/lib/omarchy-theme.ts (either an
 * Omarchy colors.toml or the live localStorage snapshot). This CLI runs the
 * same resolver and writes the result as an opencode user theme, so a
 * terminal-side opencode TUI paints with the palette the app already shows.
 *
 * Usage:
 *   npx tsx scripts/rivethub-opencode-theme.ts <input> [--out FILE]
 *                                              [--no-set] [--transparent]
 *
 *   <input>        Path to an Omarchy colors.toml, or to a JSON file holding
 *                  the app's `rivethub.omarchy-theme` localStorage snapshot
 *                  ({ name?: string, colors: OmarchyColors }).
 *   --out FILE     Destination theme file
 *                  (default: $XDG_CONFIG_HOME/opencode/themes/rivethub-omarchy.json
 *                  or ~/.config/opencode/themes/rivethub-omarchy.json)
 *   --no-set       Do not point opencode tui.json at the new theme
 *   --transparent  Emit "none" for canvas/panel surfaces so the terminal's own
 *                  background shows through
 *
 * opencode loads config once at startup — restart the TUI after generating.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, relative, resolve, sep } from 'node:path'
import { parseOmarchyColors, isOmarchyColors } from '../src/lib/omarchy-theme.js'
import { omarchyOpencodeThemeDoc } from '../src/lib/opencode-theme.js'
import { parseArgs, USAGE } from '../src/lib/opencode-theme-cli.js'

const TUI_SCHEMA = 'https://opencode.ai/tui.json'

const parsed = parseArgs(process.argv.slice(2))
if (!parsed.ok) {
  console.error(USAGE)
  process.exit(1)
}

const { input, out: outArg, noSet, transparent } = parsed

const home = process.env.HOME ?? homedir()
const configHome = process.env.XDG_CONFIG_HOME || resolve(home, '.config')
const themeDir = resolve(configHome, 'opencode/themes')
const tuiPath = resolve(configHome, 'opencode/tui.json')
const outPath = outArg ? resolve(outArg) : resolve(themeDir, 'rivethub-omarchy.json')

const inputPath = resolve(input)
if (!existsSync(inputPath)) {
  console.error(`no such file: ${inputPath}`)
  process.exit(1)
}
const raw = readFileSync(inputPath, 'utf8')

let themeName: string | undefined
let mode: 'dark' | 'light'
let doc: ReturnType<typeof omarchyOpencodeThemeDoc>

if (inputPath.endsWith('.toml')) {
  const colors = parseOmarchyColors(raw)
  if (!colors) {
    console.error(`not a parseable Omarchy colors.toml: ${inputPath}`)
    process.exit(1)
  }
  mode = colors.mode
  doc = omarchyOpencodeThemeDoc(colors, { transparent })
} else {
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(raw) as unknown
  } catch {
    console.error(`not valid JSON: ${inputPath}`)
    process.exit(1)
  }
  const obj = parsedJson as { name?: unknown; colors?: unknown }
  const colors = obj.colors ?? parsedJson
  if (!isOmarchyColors(colors)) {
    console.error(`JSON does not match the app's OmarchyColors shape: ${inputPath}`)
    process.exit(1)
  }
  if (typeof obj.name === 'string') themeName = obj.name
  mode = colors.mode
  doc = omarchyOpencodeThemeDoc(colors, { transparent })
}

mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, JSON.stringify(doc, null, 2) + '\n')
console.log(`wrote ${outPath} (mode: ${mode}${themeName ? `, omarchy theme: ${themeName}` : ''})`)

function isInsideThemeDir(file: string, dir: string): boolean {
  const rel = relative(dir, file)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`)
}

if (!noSet) {
  const themeKey = outPath.replace(/\.json$/, '').split('/').pop() ?? 'rivethub-omarchy'
  if (!isInsideThemeDir(outPath, themeDir)) {
    console.warn(
      `skipping tui.theme: ${outPath} is outside ${themeDir}; ` +
        'opencode cannot resolve a basename from a file outside the theme dir',
    )
  } else if (!existsSync(tuiPath)) {
    mkdirSync(dirname(tuiPath), { recursive: true })
    const tui = { $schema: TUI_SCHEMA, theme: themeKey }
    writeFileSync(tuiPath, JSON.stringify(tui, null, 2) + '\n')
    console.log(`created ${tuiPath} with theme "${themeKey}"`)
  } else {
    let tui: Record<string, unknown>
    try {
      tui = JSON.parse(readFileSync(tuiPath, 'utf8')) as Record<string, unknown>
    } catch {
      console.error(`not valid JSON: ${tuiPath}`)
      process.exit(1)
    }
    tui.$schema = tui.$schema ?? TUI_SCHEMA
    tui.theme = themeKey
    writeFileSync(tuiPath, JSON.stringify(tui, null, 2) + '\n')
    console.log(`set "${themeKey}" as the active theme in ${tuiPath}`)
  }
}

console.log('restart opencode to pick up the new theme')
