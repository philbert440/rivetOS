/**
 * Per-conversation CLI session ids, persisted under ~/.rivetos so a RivetOS
 * conversation keeps resuming the same pi session across turns and
 * restarts. Best-effort: a missing or corrupt file is an empty map.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type SessionMap = Record<string, string>

export function defaultSessionMapPath(fileName: string): string {
  return join(homedir(), '.rivetos', fileName)
}

export function loadSessionMap(path: string): SessionMap {
  try {
    if (existsSync(path)) {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const out: SessionMap = {}
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof v === 'string') out[k] = v
        }
        return out
      }
    }
  } catch {
    /* unreadable → empty */
  }
  return {}
}

export function saveSessionMap(path: string, map: SessionMap): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(map, null, 2))
  } catch {
    /* best-effort */
  }
}
