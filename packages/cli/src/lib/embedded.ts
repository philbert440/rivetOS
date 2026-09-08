/**
 * Acquire-or-attach the embedded PGlite engine for CLI commands.
 *
 * The host process must never block on a child that talks to the socket
 * (`spawnSync` deadlocks the multiplexer). Callers run in-process work
 * while `owned`, and only `spawn` (async) when attaching to a live owner.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { join, resolve } from 'node:path'
import {
  acquireEmbeddedPg,
  applyEmbeddedPgUrl,
  loadConfig,
  resolveEmbeddedPg,
  resolveEnvVars,
  type EmbeddedPgHandle,
  type RivetConfig,
} from '@rivetos/boot'

export type { EmbeddedPgHandle }

export function findRivetConfigPath(explicit?: string): string | undefined {
  if (explicit) return explicit
  const home = process.env.HOME ?? '.'
  const candidates = [
    resolve(home, '.rivetos', 'config.yaml'),
    resolve(home, '.rivetos', 'config.yml'),
    resolve('.', 'config.yaml'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

export async function loadRivetConfig(path: string): Promise<RivetConfig> {
  return loadConfig(path)
}

/**
 * Maintenance commands (db migrate/status, start --role migrate) must not be blocked
 * by an unrelated validation error elsewhere in config.yaml: read the file leniently and
 * only look at `memory.postgres.embedded`. Unreadable/unparseable → undefined (fall
 * through to the external-Postgres path). A present-but-invalid `embedded.port`
 * throws rather than silently defaulting to 5433.
 */
export function readEmbeddedConfig(
  path: string,
):
  { config: RivetConfig; resolved: NonNullable<ReturnType<typeof resolveEmbeddedPg>> } | undefined {
  let parsed: unknown
  try {
    parsed = parseYaml(readFileSync(path, 'utf-8'))
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== 'object') return undefined
  // Same ${ENV_VAR} expansion as loadConfig — without it, data_dir: '${HOME}/…'
  // is passed through literally and acquire opens a different directory than boot.
  const config = resolveEnvVars(parsed as RivetConfig)
  assertEmbeddedPort(config)
  const resolved = resolveEmbeddedPg(config)
  return resolved ? { config, resolved } : undefined
}

/**
 * Boot's schema rejects a non-integer port; the lenient reader used to swallow
 * it and silently default to 5433, so CLI and node could disagree. Fail loudly.
 */
function assertEmbeddedPort(config: RivetConfig): void {
  const embedded = config.memory?.postgres?.['embedded']
  if (!embedded || typeof embedded !== 'object' || Array.isArray(embedded)) return
  const port = (embedded as { port?: unknown }).port
  if (port === undefined || port === null) return
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `memory.postgres.embedded.port must be an integer between 1 and 65535 (got ${JSON.stringify(port)})`,
    )
  }
}

/**
 * acquire → apply URL → `fn(handle)` → close. Always closes, even if `fn` throws.
 */
export async function withEmbeddedPg<T>(
  config: RivetConfig,
  fn: (handle: EmbeddedPgHandle) => Promise<T>,
): Promise<T> {
  const resolved = resolveEmbeddedPg(config)
  if (!resolved) {
    throw new Error('withEmbeddedPg: memory.postgres.embedded is not configured')
  }
  const handle = await acquireEmbeddedPg(resolved, { log: cliEmbeddedLog() })
  try {
    applyEmbeddedPgUrl(config, handle.pgUrl)
    return await fn(handle)
  } finally {
    await handle.close()
  }
}

export function dirSizeBytes(dir: string): number {
  if (!existsSync(dir)) return 0
  let total = 0
  const walk = (p: string): void => {
    let st
    try {
      st = statSync(p)
    } catch {
      return
    }
    if (st.isFile()) {
      total += st.size
      return
    }
    if (!st.isDirectory()) return
    let entries: string[]
    try {
      entries = readdirSync(p)
    } catch {
      return
    }
    for (const name of entries) walk(join(p, name))
  }
  walk(dir)
  return total
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${String(n)} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function cliEmbeddedLog(): {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
} {
  const debug = (process.env.RIVETOS_LOG_LEVEL ?? '').toLowerCase() === 'debug'
  return {
    info(message: string): void {
      if (debug) console.error(message)
    },
    warn(message: string): void {
      console.error(message)
    },
    error(message: string): void {
      console.error(message)
    },
  }
}
