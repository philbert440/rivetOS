/**
 * Load `~/.rivetos/.env` (or `$RIVETOS_ENV_FILE`) into `process.env`.
 *
 * Merge is non-overriding (`override: false`) so a shell-exported value and
 * systemd `EnvironmentFile=` stay identical: keys already present in the
 * process environment win. Never log values.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'

export interface LoadRivetEnvOptions {
  /** When true, file values replace already-set keys. Default false. */
  override?: boolean
}

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Default env file: `$RIVETOS_ENV_FILE` or `~/.rivetos/.env`. */
export function defaultRivetEnvPath(): string {
  const fromEnv = process.env.RIVETOS_ENV_FILE?.trim()
  if (fromEnv) return expandLeadingTilde(fromEnv)
  return resolve(homedir(), '.rivetos', '.env')
}

/**
 * Parse a dotenv body into key/value pairs.
 * Last assignment of a key wins. Malformed lines are skipped.
 */
export function parseRivetEnv(contents: string): Record<string, string> {
  const text = contents.replace(/^\uFEFF/, '')
  const out: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const parsed = parseEnvLine(raw)
    if (!parsed) continue
    out[parsed.key] = parsed.value
  }
  return out
}

/**
 * Read `path` and merge into `process.env`. Returns the keys that were
 * actually applied (not ones skipped because they were already set).
 */
export function loadRivetEnv(
  path: string = defaultRivetEnvPath(),
  opts: LoadRivetEnvOptions = {},
): string[] {
  const override = opts.override ?? false
  if (!existsSync(path)) return []

  let contents: string
  try {
    contents = readFileSync(path, 'utf8')
  } catch {
    return []
  }

  debugEnv(`loaded ${path}`)

  const parsed = parseRivetEnv(contents)
  const applied: string[] = []
  for (const [key, value] of Object.entries(parsed)) {
    if (!override && process.env[key] !== undefined) continue
    process.env[key] = value
    applied.push(key)
  }
  return applied
}

function debugEnv(message: string): void {
  if ((process.env.RIVETOS_LOG_LEVEL ?? '').toLowerCase() === 'debug') {
    console.error(`[env] ${message}`)
  }
}

function expandLeadingTilde(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2))
  return p
}

function parseEnvLine(raw: string): { key: string; value: string } | undefined {
  const line = raw.trim()
  if (!line || line.startsWith('#')) return undefined

  const rest = line.startsWith('export') && /^\s/.test(line.slice(6)) ? line.slice(6).trim() : line
  const eq = rest.indexOf('=')
  if (eq <= 0) return undefined

  const key = rest.slice(0, eq).trim()
  if (!KEY.test(key)) return undefined

  return { key, value: unquoteEnvValue(rest.slice(eq + 1)) }
}

function unquoteEnvValue(raw: string): string {
  const s = raw.trim()
  if (s.startsWith('#')) return '' // `KEY= # disabled` is an intentionally empty value
  if (s.startsWith('"')) return decodeDoubleQuoted(s)
  if (s.startsWith("'")) {
    const end = s.indexOf("'", 1)
    return end === -1 ? s.slice(1) : s.slice(1, end)
  }
  return s.replace(/\s+#.*$/, '').trim()
}

function decodeDoubleQuoted(s: string): string {
  let out = ''
  for (let i = 1; i < s.length; i++) {
    const c = s[i]
    if (c === '"') break
    if (c === '\\' && i + 1 < s.length) {
      const n = s[i + 1]
      if (n === 'n') out += '\n'
      else if (n === 't') out += '\t'
      else if (n === 'r') out += '\r'
      else out += n
      i++
      continue
    }
    out += c
  }
  return out
}

export interface EnvDiffEntry {
  key: string
  from: string | undefined
  to: string
}

export interface UpsertEnvVarsResult {
  created: boolean
  written: boolean
  diff: EnvDiffEntry[]
  next: string
}

function encodeEnvValue(value: string): string {
  if (/[\s#"']/.test(value)) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  }
  return value
}

function envAssignment(key: string, value: string, exportPrefix: boolean): string {
  const line = `${key}=${encodeEnvValue(value)}`
  return exportPrefix ? `export ${line}` : line
}

/**
 * Create or update `path` with the given keys. Existing unrelated lines are
 * kept. The file is created 0600 (directory 0700) when missing.
 */
export function upsertEnvVars(
  path: string,
  vars: Record<string, string>,
  opts: { dryRun?: boolean } = {},
): UpsertEnvVarsResult {
  const existed = existsSync(path)
  const previous = existed ? readFileSync(path, 'utf8') : ''
  const parsed = parseRivetEnv(previous)
  const keys = Object.keys(vars)
  const replaced = new Set<string>()
  const diff: EnvDiffEntry[] = []

  const rawLines = previous.length === 0 ? [] : previous.split(/\r?\n/)
  // drop a single trailing empty line from split so we can re-add a final newline
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop()

  const outLines: string[] = []
  for (const line of rawLines) {
    const parsedLine = parseEnvLine(line)
    if (parsedLine && Object.prototype.hasOwnProperty.call(vars, parsedLine.key)) {
      if (!replaced.has(parsedLine.key)) {
        const to = vars[parsedLine.key]
        diff.push({ key: parsedLine.key, from: parsedLine.value, to })
        const exportPrefix = /^\s*export\s/.test(line)
        outLines.push(envAssignment(parsedLine.key, to, exportPrefix))
        replaced.add(parsedLine.key)
      }
      continue
    }
    outLines.push(line)
  }

  for (const key of keys) {
    if (replaced.has(key)) continue
    const to = vars[key]
    diff.push({ key, from: parsed[key], to })
    if (outLines.length > 0 && outLines[outLines.length - 1] !== '') outLines.push('')
    outLines.push(envAssignment(key, to, false))
    replaced.add(key)
  }

  const next = outLines.length > 0 ? `${outLines.join('\n')}\n` : ''
  const changed =
    !existed ||
    next !== (previous.endsWith('\n') || previous.length === 0 ? previous : `${previous}\n`)

  if (!opts.dryRun && changed) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(path, next, { encoding: 'utf8', mode: 0o600 })
    try {
      chmodSync(path, 0o600)
    } catch {
      // Windows may ignore mode bits
    }
  }

  return { created: !existed, written: Boolean(!opts.dryRun && changed), diff, next }
}

/** One line per changed key. Callers redact secret values before printing. */
export function formatEnvDiff(diff: EnvDiffEntry[]): string {
  return diff
    .map((d) => `${d.key}: ${d.from === undefined || d.from === '' ? '(unset)' : d.from} → ${d.to}`)
    .join('\n')
}
