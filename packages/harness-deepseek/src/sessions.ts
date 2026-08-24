/**
 * On-disk dsh session store — `$DSH_HOME/sessions/<cwd-slug>/session-<uuid>/`.
 *
 * Observed on ct117 (dsh 0.1.1-rc.2):
 *   ~/.dsh/sessions/<cwd-slug>/session-<uuid>/session.jsonl.zstd
 *
 * The native id IS the directory name. dsh mints it; RivetOS adopts it.
 * Capture is out-of-band, so this module never opens the zstd transcript
 * for content — list/exists/mtime only.
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** dsh native ids are `session-<uuid>` — hyphen, not kimi's underscore. */
export const DSH_ID_PREFIX = 'session-'

export const DSH_NATIVE_ID_RE =
  /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isDshNativeId(id: string): boolean {
  return DSH_NATIVE_ID_RE.test(id)
}

/** `$DSH_HOME`, defaulting to `~/.dsh`. */
export function dshHome(override?: string): string {
  const fromArg = override?.trim()
  if (fromArg) return fromArg
  const fromEnv = process.env.DSH_HOME?.trim()
  if (fromEnv) return fromEnv
  return join(homedir(), '.dsh')
}

export function sessionsRoot(home?: string): string {
  return join(dshHome(home), 'sessions')
}

export interface DshSessionRef {
  id: string
  dir: string
  /** Epoch ms of the session dir (or its transcript, if newer). */
  updatedAt: number
}

/**
 * Walk every cwd-slug bucket and return the session dirs. Cheap: readdir +
 * stat, no zstd. An unknown / missing home yields [].
 */
export function listSessions(home?: string): DshSessionRef[] {
  const root = sessionsRoot(home)
  let slugs: string[]
  try {
    slugs = readdirSync(root)
  } catch {
    return []
  }
  const out: DshSessionRef[] = []
  for (const slug of slugs) {
    const slugDir = join(root, slug)
    let entries: string[]
    try {
      entries = readdirSync(slugDir)
    } catch {
      continue
    }
    for (const e of entries) {
      if (!e.startsWith(DSH_ID_PREFIX)) continue
      const dir = join(slugDir, e)
      try {
        const st = statSync(dir)
        if (!st.isDirectory()) continue
        let updatedAt = st.mtimeMs
        try {
          const transcript = statSync(join(dir, 'session.jsonl.zstd'))
          if (transcript.mtimeMs > updatedAt) updatedAt = transcript.mtimeMs
        } catch {
          /* dir exists before the transcript is flushed — still a session */
        }
        out.push({ id: e, dir, updatedAt })
      } catch {
        /* vanished between readdir and stat */
      }
    }
  }
  return out
}

export function listSessionIds(home?: string): Set<string> {
  return new Set(listSessions(home).map((s) => s.id))
}

/**
 * The directory for a native id, if it exists under any cwd slug. Path
 * separators and `..` never resolve — the id is interpolated into a store
 * path and is caller-supplied on the resume path.
 */
export function resolveSessionDir(home: string | undefined, id: string): string | undefined {
  if (!id || id.includes('/') || id.includes('..')) return undefined
  if (!id.startsWith(DSH_ID_PREFIX)) return undefined
  const root = sessionsRoot(home)
  let slugs: string[]
  try {
    slugs = readdirSync(root)
  } catch {
    return undefined
  }
  for (const slug of slugs) {
    const dir = join(root, slug, id)
    if (existsSync(dir)) return dir
  }
  return undefined
}

/**
 * The session a failed/fresh spawn created, when exactly one appeared.
 * Concurrent same-home spawns make this ambiguous; an ambiguous id is worse
 * than none.
 */
export function adoptFreshSessionId(idsBefore: Set<string>, home?: string): string | undefined {
  const fresh = [...listSessionIds(home)].filter((id) => !idsBefore.has(id))
  return fresh.length === 1 ? fresh[0] : undefined
}
