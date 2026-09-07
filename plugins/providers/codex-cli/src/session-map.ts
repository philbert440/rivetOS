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

export function saveSessionMap(path: string, map: SessionMap): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(map, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, path)
}
