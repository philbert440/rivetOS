// Harness session discovery: list a harness's OWN sessions straight from its
// on-disk store, which lives on the node's local disk — so the result is
// inherently node+harness specific (no shared-DB bleed, no node tagging). This
// is how the RivetHub drawer lists conversations; opening one resumes the
// harness's native session (claude --resume <id>).
//
// Supports Claude Code (~/.claude/projects/<cwd-slug>/<id>.jsonl) and grok
// Build (~/.grok/sessions/<enc-cwd>/<uuid>/summary.json). Other harnesses
// (hermes) yield [] until their store format is added — the drawer just shows
// nothing for them rather than breaking.

import { readdir, stat, open, readFile } from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export interface HarnessSession {
  /** the harness's native session id (e.g. Claude Code's uuid) */
  id: string
  /** roster command the session belongs to (e.g. 'claude') */
  command: string
  /** first user message / summary, for the drawer label; falls back to the id */
  title: string
  /** epoch ms of last activity (file mtime) */
  updatedAt: number
}

/** ~/.claude/projects (respects CLAUDE_CONFIG_DIR like the CLI does). */
function claudeProjectsDir(): string {
  const base = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude')
  return join(base, 'projects')
}

/** Read the head of a session .jsonl and pull a human title: a summary line if
 *  present, else the first user message. Bounded read — titles sit near the
 *  top and full transcripts can be megabytes. */
async function sessionTitle(file: string): Promise<string> {
  const fh = await open(file, 'r')
  try {
    const buf = Buffer.alloc(64 * 1024)
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    for (const line of buf.subarray(0, bytesRead).toString('utf8').split('\n')) {
      if (!line.trim()) continue
      let d: unknown
      try {
        d = JSON.parse(line)
      } catch {
        continue // a truncated final line in the 64K window — skip it
      }
      const o = d as { type?: string; summary?: unknown; message?: { content?: unknown } }
      if (o.type === 'summary' && typeof o.summary === 'string' && o.summary.trim())
        return o.summary.trim().slice(0, 120)
      if (o.type === 'user') {
        const c = o.message?.content
        const txt =
          typeof c === 'string'
            ? c
            : Array.isArray(c)
              ? c
                  .map((p) =>
                    p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string'
                      ? (p as { text: string }).text
                      : '',
                  )
                  .join('')
              : ''
        if (txt.trim()) return txt.trim().slice(0, 120)
      }
    }
  } finally {
    await fh.close()
  }
  return ''
}

async function listClaudeSessions(limit: number): Promise<HarnessSession[]> {
  const dir = claudeProjectsDir()
  let slugs: string[]
  try {
    slugs = await readdir(dir)
  } catch {
    return [] // no Claude store on this node
  }
  const files: { id: string; path: string; mtime: number }[] = []
  for (const slug of slugs) {
    let entries: string[]
    try {
      entries = await readdir(join(dir, slug))
    } catch {
      continue
    }
    for (const f of entries) {
      if (!f.endsWith('.jsonl')) continue
      const path = join(dir, slug, f)
      try {
        const s = await stat(path)
        if (s.isFile()) files.push({ id: f.slice(0, -6), path, mtime: s.mtimeMs })
      } catch {
        /* vanished between readdir and stat — skip */
      }
    }
  }
  // Newest first, then only title-parse the top N (parsing is the costly part).
  files.sort((a, b) => b.mtime - a.mtime)
  const out: HarnessSession[] = []
  for (const f of files.slice(0, limit)) {
    const title = await sessionTitle(f.path).catch(() => '')
    out.push({ id: f.id, command: 'claude', title: title || f.id, updatedAt: Math.floor(f.mtime) })
  }
  return out
}

/** ~/.grok/sessions (respects GROK_HOME). grok stores one DIR per session:
 *  <sessions>/<url-encoded-cwd>/<uuid>/summary.json. */
function grokSessionsDir(): string {
  const base = process.env.GROK_HOME?.trim() || join(homedir(), '.grok')
  return join(base, 'sessions')
}

async function listGrokSessions(limit: number): Promise<HarnessSession[]> {
  const dir = grokSessionsDir()
  let cwdDirs: string[]
  try {
    cwdDirs = await readdir(dir)
  } catch {
    return [] // no grok store on this node
  }
  const out: HarnessSession[] = []
  for (const cwd of cwdDirs) {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(join(dir, cwd), { withFileTypes: true })
    } catch {
      continue // e.g. session_search.sqlite is a file, not a dir
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      // summary.json carries the id, a real title, and updated_at — much
      // cleaner than parsing chat_history.jsonl.
      try {
        const s = JSON.parse(await readFile(join(dir, cwd, e.name, 'summary.json'), 'utf8')) as {
          info?: { id?: string }
          session_summary?: string
          updated_at?: string
        }
        const id = s.info?.id || e.name
        const t = s.updated_at ? Date.parse(s.updated_at) : NaN
        out.push({
          id,
          command: 'grok',
          title: s.session_summary?.trim().slice(0, 120) || id,
          updatedAt: Number.isFinite(t) ? t : 0,
        })
      } catch {
        /* no summary / unreadable → skip this session */
      }
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit)
}

/**
 * Does a harness already have an on-disk session with this id? Store existence
 * is the ground truth for choosing --resume (continue) vs --session-id (pin a
 * NEW id) when re-spawning a conversation whose PTY was evicted (#318 review).
 * Sync + cheap (a handful of existsSync); unknown harnesses → false.
 */
export function harnessSessionExists(command: string, id: string): boolean {
  let dir: string
  let hit: (top: string) => string
  if (command === 'claude') {
    dir = claudeProjectsDir()
    hit = (slug) => join(dir, slug, `${id}.jsonl`)
  } else if (command === 'grok') {
    dir = grokSessionsDir()
    hit = (cwd) => join(dir, cwd, id, 'summary.json')
  } else {
    return false
  }
  let tops: string[]
  try {
    tops = readdirSync(dir)
  } catch {
    return false
  }
  return tops.some((t) => existsSync(hit(t)))
}

/**
 * List the on-disk sessions for the given roster harnesses, newest first.
 * Only harnesses with a known store contribute; unknown ones are silently
 * skipped (the drawer degrades to empty, never errors).
 */
export async function listHarnessSessions(
  commands: string[],
  limit = 100,
): Promise<HarnessSession[]> {
  const all: HarnessSession[] = []
  if (commands.includes('claude')) all.push(...(await listClaudeSessions(limit)))
  if (commands.includes('grok')) all.push(...(await listGrokSessions(limit)))
  // hermes store format not yet wired — its node's drawer stays empty.
  all.sort((a, b) => b.updatedAt - a.updatedAt) // last-updated first
  return all.slice(0, limit)
}
