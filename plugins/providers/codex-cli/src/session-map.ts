import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const SESSION_MAP_FILE = 'codex-cli-sessions.json'
export type SessionMap = Record<string, string>

export function defaultSessionMapPath(): string {
  return join(homedir(), '.rivetos', SESSION_MAP_FILE)
}

export function loadSessionMap(path = defaultSessionMapPath()): SessionMap {
  try {
    if (!existsSync(path)) return {}
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === 'string'))
  } catch {
    return {}
  }
}

function writeSessionMapFile(path: string, map: SessionMap): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(map, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, path)
}

/** Re-load, merge `{...fresh, ...changes}`, then atomic write. May throw. */
export function saveSessionMap(path: string, changes: SessionMap): void {
  writeSessionMapFile(path, { ...loadSessionMap(path), ...changes })
}

/** Re-load, drop `key`, then atomic write. May throw. */
export function deleteSessionMapKey(path: string, key: string): void {
  const fresh = loadSessionMap(path)
  if (!(key in fresh)) return
  writeSessionMapFile(path, Object.fromEntries(Object.entries(fresh).filter(([k]) => k !== key)))
}
