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
 *                  (default: ~/.config/opencode/themes/rivethub-omarchy.json)
 *   --no-set       Do not point ~/.config/opencode/tui.json at the new theme
 *   --transparent  Emit "none" for canvas/panel surfaces so the terminal's own
 *                  background shows through
 *
 * opencode loads config once at startup — restart the TUI after generating.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { parseOmarchyColors, isOmarchyColors } from '../src/lib/omarchy-theme.js'
import { omarchyOpencodeThemeDoc } from '../src/lib/opencode-theme.js'

const argv = process.argv.slice(2)
const flags = new Set(argv.filter((a) => a.startsWith('--')))
const transparent = flags.has('--transparent')
const noSet = flags.has('--no-set')
const outIdx = argv.indexOf('--out')
const outArg = outIdx !== -1 ? argv[outIdx + 1] : undefined
const home = process.env.HOME ?? homedir()
const outPath = outArg ? resolve(outArg) : resolve(home, '.config/opencode/themes/rivethub-omarchy.json')
const tuiPath = resolve(home, '.config/opencode/tui.json')

const positional = argv.filter((a, i) => !a.startsWith('--') && i !== outIdx && i !== outIdx + 1)
if (positional.length !== 1 || (outIdx !== -1 && !outArg)) {
  console.error(
    'usage: rivethub-opencode-theme <colors.toml | snapshot.json> [--out FILE] [--no-set] [--transparent]',
  )
  process.exit(1)
}

const inputPath = resolve(positional[0])
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
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    console.error(`not valid JSON: ${inputPath}`)
    process.exit(1)
  }
  const obj = parsed as { name?: unknown; colors?: unknown }
  const colors = obj.colors ?? parsed
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

if (!noSet) {
  if (!existsSync(tuiPath)) {
    console.error(`no tui config at ${tuiPath} — set "theme" manually to the basename of --out`)
    process.exit(1)
  }
  let tui: Record<string, unknown>
  try {
    tui = JSON.parse(readFileSync(tuiPath, 'utf8')) as Record<string, unknown>
  } catch {
    console.error(`not valid JSON: ${tuiPath}`)
    process.exit(1)
  }
  tui.$schema = tui.$schema ?? 'https://opencode.ai/tui.json'
  const themeKey = outPath.replace(/\.json$/, '').split('/').pop() ?? 'rivethub-omarchy'
  tui.theme = themeKey
  writeFileSync(tuiPath, JSON.stringify(tui, null, 2) + '\n')
  console.log(`set "${themeKey}" as the active theme in ${tuiPath}`)
}

console.log('restart opencode to pick up the new theme')
