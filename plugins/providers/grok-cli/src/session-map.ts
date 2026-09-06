/**
 * Per-conversation Grok Build session ids, persisted under ~/.rivetos so a
 * RivetOS conversation keeps resuming the same grok session across turns and
 * restarts. Best-effort: a missing or corrupt file is an empty map.
 *
 * Copied from plugins/providers/{hermes-cli,kimi-code}/src/session-map.ts
 * rather than imported across packages (those are separately published).
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type SessionMap = Record<string, string>

export const SESSION_MAP_FILE = 'grok-cli-sessions.json'

export function defaultSessionMapPath(fileName: string = SESSION_MAP_FILE): string {
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

/**
 * Deterministic UUID (SHA-1, RFC 4122 v5 shape, no namespace) from a
 * conversation key. Same helper the ct112/ct114 grok-cli plugin used so a
 * conversation always mints the same `--session-id`.
 */
export function uuidForConversation(key: string): string {
  const h = createHash('sha1').update(key).digest()
  h[6] = (h[6] & 0x0f) | 0x50
  h[8] = (h[8] & 0x3f) | 0x80
  const hex = h.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}
