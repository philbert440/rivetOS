import { readFileSync } from 'node:fs'

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

export function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

export function capForStorage(
  text: string,
  opts?: { limit?: number },
): { text: string; truncated: boolean; fullLength: number } {
  const limit = opts?.limit ?? 16_000
  return { text: text.slice(0, limit), truncated: text.length > limit, fullLength: text.length }
}

export function loadEnvFile(path: string): Record<string, string> {
  const values: Record<string, string> = {}
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
      if (!m || values[m[1]]) continue
      values[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  } catch {
    // Missing or unreadable env files are optional, as in the capture hooks.
  }
  return values
}
