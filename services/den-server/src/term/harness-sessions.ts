// Harness session discovery: list a harness's OWN sessions straight from its
// on-disk store, which lives on the node's local disk — so the result is
// inherently node+harness specific (no shared-DB bleed, no node tagging). This
// is how the RivetHub drawer lists conversations; opening one resumes the
// harness's native session (claude --resume <id>).
//
// Currently supports Claude Code (~/.claude/projects/<cwd-slug>/<id>.jsonl).
// Other harnesses yield [] until their store format is added — the drawer just
// shows nothing for them rather than breaking.

import { readdir, stat, open } from 'node:fs/promises'
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
  // grok / hermes stores: add when their formats are wired.
  all.sort((a, b) => b.updatedAt - a.updatedAt)
  return all.slice(0, limit)
}
