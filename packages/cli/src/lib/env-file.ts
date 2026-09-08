/**
 * Load `~/.rivetos/.env` (or `$RIVETOS_ENV_FILE`) into `process.env`.
 *
 * Merge is non-overriding (`override: false`) so a shell-exported value and
 * systemd `EnvironmentFile=` stay identical: keys already present in the
 * process environment win. Never log values.
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

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
