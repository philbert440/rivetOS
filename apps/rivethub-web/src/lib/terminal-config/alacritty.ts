/**
 * Alacritty — TOML (`alacritty.toml`, 0.13+) and the legacy YAML shape
 * (`alacritty.yml`), which are the same tree in two syntaxes, so both decode
 * to a plain object and share one extractor.
 *
 * YAML goes through the `yaml` package the hub already depends on; TOML uses
 * the small reader in ./toml.ts (no new dependency for one config format).
 * `import` entries are treated as the BASE layer — Alacritty applies them
 * first and lets the importing file override, which is exactly how a theme
 * import is meant to work.
 */

import { parse as parseYaml } from 'yaml'
import {
  finishPalette,
  fontStack,
  isUnsafeKey,
  lookupInclude,
  MAX_PARSER_CHARS,
  newPaletteDraft,
  normalizeHex,
  oversizedWarning,
  positiveNumber,
  setAnsi,
  stripBom,
  type PaletteDraft,
} from './common.js'
import { parseToml } from './toml.js'
import type { TerminalImport } from './types.js'

type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

function newObj(): Obj {
  return Object.create(null) as Obj
}

function get(root: unknown, path: string[]): unknown {
  let node: unknown = root
  for (const key of path) {
    if (!isObj(node) || !Object.hasOwn(node, key)) return undefined
    node = node[key]
  }
  return node
}

/** Deep merge with `over` winning — used to lay the config over its imports. */
function merge(base: Obj, over: Obj): Obj {
  const out = newObj()
  for (const [k, v] of Object.entries(base)) {
    if (isUnsafeKey(k)) continue
    out[k] = v
  }
  for (const [k, v] of Object.entries(over)) {
    if (isUnsafeKey(k)) continue
    const prev = Object.hasOwn(out, k) ? out[k] : undefined
    out[k] = isObj(prev) && isObj(v) ? merge(prev, v) : v
  }
  return out
}

/** Copy onto a null-prototype object, dropping keys that would pollute. */
function copySafe(v: unknown, warnings: string[]): unknown {
  if (typeof v === 'function') return undefined
  if (Array.isArray(v)) return v.map((item) => copySafe(item, warnings))
  if (!isObj(v)) return v
  const out = newObj()
  for (const [k, val] of Object.entries(v)) {
    if (isUnsafeKey(k)) {
      warnings.push(`Ignoring unsafe key \`${k}\`.`)
      continue
    }
    out[k] = copySafe(val, warnings)
  }
  return out
}

export type AlacrittyFormat = 'toml' | 'yaml'

/**
 * Which syntax a config is written in. The file extension decides when the
 * caller knows it; otherwise the tell is `key = value` / `[table]` (TOML)
 * versus `key:` (YAML), counted over the whole file so a stray line either
 * way can't flip the verdict.
 */
export function detectAlacrittyFormat(text: string, path?: string): AlacrittyFormat {
  if (path) {
    if (/\.toml$/i.test(path)) return 'toml'
    if (/\.ya?ml$/i.test(path)) return 'yaml'
  }
  let toml = 0
  let yaml = 0
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (/^\[.+\]$/.test(line) || /^[\w"'.-]+\s*=/.test(line)) toml++
    else if (/^[\w"'-][\w"'. -]*:/.test(line)) yaml++
  }
  return yaml > toml ? 'yaml' : 'toml'
}

const NORMAL_KEYS = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const

function readColors(root: unknown, draft: PaletteDraft, warnings: string[]): void {
  const color = (path: string[]): string | undefined => {
    const raw = get(root, path)
    if (raw === undefined) return undefined
    // Quoted colour strings must stay strings — `Number("0x1d1f21")` is an
    // integer, not a colour. normalizeHex already accepts the `0x` spelling.
    if (typeof raw !== 'string') {
      warnings.push(`Could not read \`${path.join('.')}\` as a color.`)
      return undefined
    }
    const hex = normalizeHex(raw, warnings)
    if (!hex) warnings.push(`Could not read \`${path.join('.')}\` as a color.`)
    return hex
  }
  draft.foreground = color(['colors', 'primary', 'foreground'])
  draft.background = color(['colors', 'primary', 'background'])
  // `colors.cursor.cursor` is the cursor's own color; `.text` is the glyph
  // under it, which xterm derives itself.
  draft.cursor = color(['colors', 'cursor', 'cursor'])
  draft.selectionBackground = color(['colors', 'selection', 'background'])
  NORMAL_KEYS.forEach((key, i) => {
    setAnsi(draft, i, color(['colors', 'normal', key]))
    setAnsi(draft, i + 8, color(['colors', 'bright', key]))
  })
}

function asStringList(v: unknown): string[] {
  if (typeof v === 'string') return [v]
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

function importPaths(root: unknown, warnings: string[]): string[] {
  // 0.14 moved `import` under `[general]`. Prefer that spelling when both
  // exist so a leftover top-level key does not double-import the same theme.
  const general = get(root, ['general', 'import'])
  const top = get(root, ['import'])
  if (general !== undefined && top !== undefined) {
    warnings.push('Ignoring top-level `import` because `[general].import` is set.')
  }
  if (general !== undefined) return asStringList(general)
  return asStringList(top)
}

function hasImport(root: unknown): boolean {
  return (
    asStringList(get(root, ['import'])).length > 0 ||
    asStringList(get(root, ['general', 'import'])).length > 0
  )
}

function decode(text: string, format: AlacrittyFormat, warnings: string[]): Obj {
  if (format === 'yaml') {
    let parsed: unknown
    try {
      parsed = parseYaml(text, { maxAliasCount: 10 })
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err), { cause: err })
    }
    if (!isObj(parsed)) {
      throw new Error('YAML config did not contain a mapping.')
    }
    return copySafe(parsed, warnings) as Obj
  }
  return parseToml(text, warnings)
}

export function parseAlacritty(
  text: string,
  opts: {
    includes?: Record<string, string | undefined>
    format?: AlacrittyFormat
    path?: string
  } = {},
): TerminalImport {
  text = stripBom(text)
  if (text.length > MAX_PARSER_CHARS) return { warnings: [oversizedWarning('config')] }
  const warnings: string[] = []
  const format = opts.format ?? detectAlacrittyFormat(text, opts.path)
  let root: Obj
  try {
    root = decode(text, format, warnings)
  } catch (err) {
    return {
      warnings: [
        `Could not read this ${format.toUpperCase()} config: ${err instanceof Error ? err.message : String(err)}`,
      ],
    }
  }

  // Imports first, then the config itself on top — one level deep only, so a
  // theme file that imports another theme stops here.
  const includes = opts.includes ?? {}
  let base = newObj()
  for (const target of importPaths(root, warnings)) {
    const included = lookupInclude(includes, target)
    if (included === undefined) {
      warnings.push(`Could not read imported config \`${target}\`.`)
      continue
    }
    if (included.length > MAX_PARSER_CHARS) {
      warnings.push(`Imported config \`${target}\` is larger than 1 MB and was not parsed.`)
      continue
    }
    try {
      const body = stripBom(included)
      const nested = decode(body, detectAlacrittyFormat(body, target), warnings)
      if (hasImport(nested)) {
        warnings.push(`Nested imports not followed in \`${target}\`.`)
      }
      base = merge(base, nested)
    } catch (err) {
      warnings.push(
        `Could not read imported config \`${target}\`: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
  const config = merge(base, root)

  const draft = newPaletteDraft()
  readColors(config, draft, warnings)

  const families: string[] = []
  const family = get(config, ['font', 'normal', 'family'])
  if (typeof family === 'string') families.push(family)

  const result: TerminalImport = { warnings }
  const stack = fontStack(families)
  if (stack) result.fontFamily = stack
  const size = positiveNumber(get(config, ['font', 'size']))
  if (size !== undefined) result.fontSize = size
  const palette = finishPalette(draft, warnings)
  if (palette) result.palette = palette
  return result
}
