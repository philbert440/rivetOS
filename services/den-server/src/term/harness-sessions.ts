// Harness session discovery: list a harness's OWN sessions straight from its
// on-disk store, which lives on the node's local disk — so the result is
// inherently node+harness specific (no shared-DB bleed, no node tagging). This
// is how the RivetHub drawer lists conversations; opening one resumes the
// harness's native session (claude --resume <id>).
//
// Supports Claude Code (~/.claude/projects/<slug>/<id>.jsonl), grok Build
// (~/.grok/sessions/<enc-cwd>/<uuid>/summary.json), Hermes (a sqlite DB at
// ~/.hermes/state.db) and Kimi Code
// (~/.kimi-code/sessions/wd_<label>_<hash>/session_<uuid>/). An unknown harness
// yields [] — the drawer just shows nothing for it rather than breaking.

import { readdir, stat, open, readFile } from 'node:fs/promises'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import type { HarnessTranscriptTool, HarnessTranscriptTurn } from '@rivetos/types'

export interface HarnessSession {
  /** the harness's native session id (e.g. Claude Code's uuid) */
  id: string
  /** roster command the session belongs to (e.g. 'claude') */
  command: string
  /** first user message / summary, for the drawer label; falls back to the id */
  title: string
  /** epoch ms of last activity (file mtime) */
  updatedAt: number
  /** epoch ms the session was created. Claude has no field for it, so its
   *  readers use the store file's birthtime (falling back to ctime then
   *  mtime); grok's summary.json carries `created_at` and the reader parses it.
   *  Optional because hermes exposes nothing usable, and because an older grok
   *  store may predate the field. */
  createdAt?: number
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
  const files: { id: string; path: string; mtime: number; birth: number }[] = []
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
        // birth: same fallback chain as describeClaudeSession, so a session's
        // createdAt cannot disagree between the list and the single lookup.
        if (s.isFile())
          files.push({
            id: f.slice(0, -6),
            path,
            mtime: s.mtimeMs,
            birth: s.birthtimeMs || s.ctimeMs || s.mtimeMs,
          })
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
    out.push({
      id: f.id,
      command: 'claude',
      title: title || f.id,
      updatedAt: Math.floor(f.mtime),
      createdAt: Math.floor(f.birth),
    })
  }
  return out
}

/**
 * Describe ONE Claude session by native id, without scanning every title.
 *
 * `listClaudeSessions` is the drawer's bulk path; the harness control plane
 * needs a single-session lookup for `getSession` / `startSession` collision
 * checks, and paying a whole-store title parse for that would be silly.
 * Returns undefined when the id has no `.jsonl` under any project slug.
 */
export async function describeClaudeSession(id: string): Promise<HarnessSession | undefined> {
  if (!id || id.includes('/') || id.includes('..')) return undefined
  const path = await findClaudeJsonl(id)
  if (!path) return undefined
  let mtime: number
  let birth: number
  try {
    const s = await stat(path)
    mtime = s.mtimeMs
    birth = s.birthtimeMs || s.ctimeMs || s.mtimeMs
  } catch {
    return undefined
  }
  const title = await sessionTitle(path).catch(() => '')
  return {
    id,
    command: 'claude',
    title: title || id,
    updatedAt: Math.floor(mtime),
    createdAt: Math.floor(birth),
  }
}

/** ~/.grok/sessions (respects GROK_HOME). grok stores one DIR per session:
 *  <sessions>/<url-encoded-cwd>/<uuid>/summary.json. */
function grokSessionsDir(): string {
  const base = process.env.GROK_HOME?.trim() || join(homedir(), '.grok')
  return join(base, 'sessions')
}

/**
 * Read one grok session dir's `summary.json` into a HarnessSession.
 *
 * summary.json carries the id, a real title, created_at and updated_at — much
 * cleaner than parsing chat_history.jsonl. Shared by the bulk list and the
 * single-session lookup so the two can never disagree about a session's
 * createdAt (the same guarantee the Claude readers give via their stat
 * fallback chain).
 *
 * Returns undefined when the dir has no readable summary — grok writes the
 * session DIR before its summary, so "no row" does NOT mean "id is free"; that
 * question is `harnessSessionExists('grok', id)`.
 */
async function readGrokSummary(
  dir: string,
  fallbackId: string,
): Promise<HarnessSession | undefined> {
  let s: {
    info?: { id?: string }
    session_summary?: string
    created_at?: string
    updated_at?: string
  }
  try {
    s = JSON.parse(await readFile(join(dir, 'summary.json'), 'utf8')) as typeof s
  } catch {
    return undefined
  }
  const id = s.info?.id || fallbackId
  const updated = s.updated_at ? Date.parse(s.updated_at) : NaN
  const created = s.created_at ? Date.parse(s.created_at) : NaN
  const row: HarnessSession = {
    id,
    command: 'grok',
    title: s.session_summary?.trim().slice(0, 120) || id,
    updatedAt: Number.isFinite(updated) ? updated : 0,
  }
  if (Number.isFinite(created)) row.createdAt = created
  return row
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
      const row = await readGrokSummary(join(dir, cwd, e.name), e.name)
      if (row) out.push(row)
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit)
}

/**
 * Describe ONE grok session by native id — the harness control plane's
 * single-session read (`getSession`, and the store half of the resume check),
 * without scanning every cwd bucket's titles.
 *
 * The id appears under exactly one cwd bucket in practice; if it somehow
 * appears under several, the most recently updated wins (same tie-break as
 * `findClaudeJsonl` / `findGrokChatHistory`).
 */
export async function describeGrokSession(id: string): Promise<HarnessSession | undefined> {
  if (!id || id.includes('/') || id.includes('..')) return undefined
  const dir = grokSessionsDir()
  let cwdDirs: string[]
  try {
    cwdDirs = await readdir(dir)
  } catch {
    return undefined // no grok store on this node
  }
  let best: HarnessSession | undefined
  for (const cwd of cwdDirs) {
    const row = await readGrokSummary(join(dir, cwd, id), id)
    if (row && (!best || row.updatedAt > best.updatedAt)) best = row
  }
  return best
}

// ---- Hermes: sessions live in a sqlite DB, not files (~/.hermes/state.db) ----

/** ~/.hermes/state.db (respects HERMES_HOME). */
function hermesDbPath(): string {
  const base = process.env.HERMES_HOME?.trim() || join(homedir(), '.hermes')
  return join(base, 'state.db')
}

interface SqliteRow {
  [k: string]: unknown
}
interface SqliteStmt {
  all(...params: unknown[]): SqliteRow[]
  get(...params: unknown[]): SqliteRow | undefined
}
interface SqliteDb {
  prepare(sql: string): SqliteStmt
  close(): void
}
const require_ = createRequire(import.meta.url)

/** Open the hermes DB read-only. Returns null if the file or node:sqlite
 *  (Node ≥22.5, still experimental) is unavailable — the drawer degrades to
 *  empty for hermes rather than erroring. */
function openHermesDb(): SqliteDb | null {
  const dbPath = hermesDbPath()
  if (!existsSync(dbPath)) return null
  try {
    const { DatabaseSync } = require_('node:sqlite') as {
      DatabaseSync: new (p: string, o?: { readOnly?: boolean }) => SqliteDb
    }
    return new DatabaseSync(dbPath, { readOnly: true })
  } catch {
    return null
  }
}

/** hermes timestamps may be epoch ms, epoch seconds, or an ISO string. */
function toEpochMs(v: unknown): number {
  if (typeof v === 'number') return v > 1e12 ? v : v > 1e9 ? v * 1000 : v
  if (typeof v === 'string') {
    const t = Date.parse(v)
    return Number.isFinite(t) ? t : 0
  }
  return 0
}

function listHermesSessions(limit: number): HarnessSession[] {
  const db = openHermesDb()
  if (!db) return []
  try {
    // Bounded by LIMIT (server caps at 500). The correlated title subquery
    // runs once per returned session; hermes indexes messages(session_id,...),
    // so this stays cheap — drawer latency scales with the LIMIT, not the
    // whole transcript (#320 review).
    const rows = db
      .prepare(
        `SELECT s.id AS id, s.started_at AS started, s.ended_at AS ended,
                (SELECT m.content FROM messages m
                  WHERE m.session_id = s.id AND m.role = 'user'
                  ORDER BY m.timestamp ASC LIMIT 1) AS title
         FROM sessions s
         ORDER BY COALESCE(s.ended_at, s.started_at) DESC
         LIMIT ?`,
      )
      .all(limit)
    return rows.map((r) => ({
      id: String(r.id),
      command: 'hermes',
      title: (typeof r.title === 'string' ? r.title : '').trim().slice(0, 120) || String(r.id),
      updatedAt: toEpochMs(r.ended ?? r.started),
    }))
  } catch {
    return []
  } finally {
    try {
      db.close()
    } catch {
      /* ignore */
    }
  }
}

/**
 * One hermes session by id — the `hermes` driver's `getSession`.
 *
 * The list query's shape, narrowed to a single row: the SAME first-user-message
 * title subquery and the same `COALESCE(ended_at, started_at)` recency, so a
 * drawer row and a `getSession` cannot disagree — plus `started_at` as the
 * creation stamp. Hermes is the one harness whose store records when a session
 * began, so unlike Claude's file-birthtime guess this is the harness's own
 * answer.
 */
function describeHermesSessionSync(id: string): HarnessSession | undefined {
  if (!id || id.includes('/') || id.includes('..')) return undefined
  const db = openHermesDb()
  if (!db) return undefined
  try {
    const row = db
      .prepare(
        `SELECT s.id AS id, s.started_at AS started, s.ended_at AS ended,
                (SELECT m.content FROM messages m
                  WHERE m.session_id = s.id AND m.role = 'user'
                  ORDER BY m.timestamp ASC LIMIT 1) AS title
         FROM sessions s WHERE s.id = ? LIMIT 1`,
      )
      .get(id)
    if (!row) return undefined
    const started = toEpochMs(row.started)
    return {
      id: String(row.id),
      command: 'hermes',
      title:
        (typeof row.title === 'string' ? row.title : '').trim().slice(0, 120) || String(row.id),
      updatedAt: toEpochMs(row.ended ?? row.started),
      ...(started ? { createdAt: started } : {}),
    }
  } catch {
    return undefined
  } finally {
    try {
      db.close()
    } catch {
      /* ignore */
    }
  }
}

/** Async face of the sqlite lookup, so every driver's store port looks alike. */
export function describeHermesSession(id: string): Promise<HarnessSession | undefined> {
  return Promise.resolve(describeHermesSessionSync(id))
}

function hermesSessionExists(id: string): boolean {
  const db = openHermesDb()
  if (!db) return false
  try {
    return !!db.prepare('SELECT 1 FROM sessions WHERE id = ? LIMIT 1').get(id)
  } catch {
    return false
  } finally {
    try {
      db.close()
    } catch {
      /* ignore */
    }
  }
}

// ---- Kimi Code: ~/.kimi-code/sessions/wd_<label>_<hash>/session_<uuid>/ ----

/** ~/.kimi-code (respects KIMI_CODE_HOME, which the CLI itself reads and the
 *  rivet-memory backfill tool already honors). */
function kimiHome(): string {
  return process.env.KIMI_CODE_HOME?.trim() || join(homedir(), '.kimi-code')
}

function kimiSessionsDir(): string {
  return join(kimiHome(), 'sessions')
}

/** kimi native ids are `session_<uuid>` — the store DIR name, verbatim. */
const KIMI_ID_PREFIX = 'session_'

/**
 * `state.json` timestamps come in two shapes, and BOTH are live on a real box:
 * kimi ≥0.34 writes `"version": 2` state with epoch-ms NUMBERS, while an older
 * install (0.26 was still writing into the same store on ct116) writes ISO
 * STRINGS. Neither is "the" format, so parse both and fall back to the file's
 * mtime rather than picking a winner.
 */
function kimiTime(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const t = Date.parse(v)
    return Number.isFinite(t) ? t : 0
  }
  return 0
}

/**
 * First user prompt out of a session's main-agent `wire.jsonl`, for the drawer
 * label. Bounded 64K head read, the same idiom as `sessionTitle`.
 *
 * Needed because the two state shapes disagree about titles too: the v1 store
 * carries `title` + `lastPrompt`, and the v2 store carries NEITHER — the newer
 * CLI derives the title at display time. So the only title source that works
 * across both is the transcript's opening turn.
 */
async function kimiWireTitle(wireFile: string): Promise<string> {
  let fh: Awaited<ReturnType<typeof open>>
  try {
    fh = await open(wireFile, 'r')
  } catch {
    return ''
  }
  try {
    const buf = Buffer.alloc(64 * 1024)
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    for (const line of buf.subarray(0, bytesRead).toString('utf8').split('\n')) {
      const t = line.trim()
      if (!t.startsWith('{')) continue
      let d: Record<string, unknown>
      try {
        d = JSON.parse(t) as Record<string, unknown>
      } catch {
        continue // truncated final line in the 64K window
      }
      if (d.type !== 'context.append_message') continue
      const msg = d.message as { content?: unknown; origin?: { kind?: unknown } } | undefined
      // Only a HUMAN turn: kimi injects permission banners and todo reminders
      // as user-role messages with `origin.kind: 'injection'`, and one of those
      // as a drawer label would be worse than the raw id.
      if (msg?.origin?.kind !== 'user') continue
      const text = extractTurnText(msg.content, 'user')
      if (text) return text.slice(0, 120)
    }
  } finally {
    await fh.close()
  }
  return ''
}

/**
 * Read one kimi session dir into a HarnessSession. Shared by the bulk list and
 * the single-session lookup so the two can never disagree about `createdAt` —
 * the same guarantee the claude/grok readers give.
 *
 * The id is the DIRECTORY NAME, not `state.json.id`: the v2 state carries an
 * `id` that always equals the dir name, and the v1 state carries no id at all.
 * The dir name is the only field both shapes have.
 */
async function readKimiSession(dir: string, id: string): Promise<HarnessSession | undefined> {
  const stateFile = join(dir, 'state.json')
  let s: { title?: unknown; lastPrompt?: unknown; createdAt?: unknown; updatedAt?: unknown }
  let mtime: number
  try {
    const [raw, st] = await Promise.all([readFile(stateFile, 'utf8'), stat(stateFile)])
    s = JSON.parse(raw) as typeof s
    mtime = st.mtimeMs
  } catch {
    return undefined
  }
  const title =
    (typeof s.title === 'string' ? s.title.trim() : '') ||
    (typeof s.lastPrompt === 'string' ? s.lastPrompt.trim() : '') ||
    (await kimiWireTitle(join(dir, 'agents', 'main', 'wire.jsonl')).catch(() => ''))
  const row: HarnessSession = {
    id,
    command: 'kimi',
    title: title.replace(/\s+/g, ' ').trim().slice(0, 120) || id,
    updatedAt: Math.floor(kimiTime(s.updatedAt) || mtime),
  }
  const created = kimiTime(s.createdAt)
  if (created) row.createdAt = Math.floor(created)
  return row
}

async function listKimiSessions(limit: number): Promise<HarnessSession[]> {
  const root = kimiSessionsDir()
  let wdDirs: string[]
  try {
    wdDirs = await readdir(root)
  } catch {
    return [] // no kimi store on this node
  }
  // Cheap stat pass first, then only parse the top N — parsing is the costly
  // part (a title can cost a 64K transcript read). Same shape as the Claude
  // reader.
  const found: { id: string; path: string; mtime: number }[] = []
  for (const wd of wdDirs) {
    let entries: string[]
    try {
      entries = await readdir(join(root, wd))
    } catch {
      continue // session_index.jsonl siblings, stray files
    }
    for (const e of entries) {
      if (!e.startsWith(KIMI_ID_PREFIX)) continue
      const path = join(root, wd, e)
      try {
        const st = await stat(join(path, 'state.json'))
        if (st.isFile()) found.push({ id: e, path, mtime: st.mtimeMs })
      } catch {
        /* dir without state.json — mid-create, or reaped between reads */
      }
    }
  }
  found.sort((a, b) => b.mtime - a.mtime)
  const out: HarnessSession[] = []
  for (const f of found.slice(0, limit)) {
    const row = await readKimiSession(f.path, f.id)
    if (row) out.push(row)
  }
  return out
}

/**
 * Which workspace bucket holds a kimi session, without walking every bucket.
 *
 * `~/.kimi-code/session_index.jsonl` is one `{sessionId, sessionDir, workDir}`
 * line per session, appended when the session is created — so it is the fast
 * path, and a full scan is the fallback for a session the index never got
 * (an index truncated by hand, a dir copied in). The recorded `sessionDir` is
 * only trusted when its basename IS the id: the index is data on disk, and a
 * driver-reachable id must not be able to point a read anywhere else.
 */
function kimiSessionDir(id: string): string | undefined {
  const root = kimiSessionsDir()
  let indexed: string | undefined
  try {
    const raw = readFileSync(join(kimiHome(), 'session_index.jsonl'), 'utf8')
    for (const line of raw.split('\n')) {
      const t = line.trim()
      if (!t.startsWith('{')) continue
      try {
        const o = JSON.parse(t) as { sessionId?: unknown; sessionDir?: unknown }
        // Last occurrence wins, defensively — the file is append-only.
        if (o.sessionId === id && typeof o.sessionDir === 'string') indexed = o.sessionDir
      } catch {
        /* partial trailing line — skip */
      }
    }
  } catch {
    /* no index on this node */
  }
  // Existence is the DIR, not `state.json`: kimi creates the dir first, so a
  // session caught between the two is still a real session — `readKimiSession`
  // is the one that answers "can it be described yet".
  if (indexed && basename(indexed) === id && existsSync(indexed)) return indexed
  let wdDirs: string[]
  try {
    wdDirs = readdirSync(root)
  } catch {
    return undefined
  }
  for (const wd of wdDirs) {
    const path = join(root, wd, id)
    if (existsSync(path)) return path
  }
  return undefined
}

/**
 * Describe ONE kimi session by native id — the `kimi-code` driver's
 * `getSession`, without paying a whole-store title scan.
 */
export async function describeKimiSession(id: string): Promise<HarnessSession | undefined> {
  if (!id || id.includes('/') || id.includes('..')) return undefined
  const dir = kimiSessionDir(id)
  if (!dir) return undefined
  return readKimiSession(dir, id)
}

/**
 * Does a kimi session DIR exist? Broader than `describe` and deliberately so:
 * kimi creates the dir, then writes `state.json`, then the transcript, so a
 * describable session is a strict subset of an existing one — the same
 * relationship grok's store has.
 */
function kimiSessionExists(id: string): boolean {
  if (!id.startsWith(KIMI_ID_PREFIX)) return false
  const root = kimiSessionsDir()
  let wdDirs: string[]
  try {
    wdDirs = readdirSync(root)
  } catch {
    return false
  }
  return wdDirs.some((wd) => existsSync(join(root, wd, id)))
}

/**
 * Does a harness already have an on-disk session with this id? Store existence
 * is the ground truth for choosing --resume (continue) vs --session-id (pin a
 * NEW id) when re-spawning a conversation whose PTY was evicted (#318 review).
 * Sync + cheap (a handful of existsSync); unknown harnesses → false.
 *
 * Ids are interpolated straight into a store path, and since the harness
 * drivers landed this is reachable with a CALLER-SUPPLIED id (`POST
 * /api/harness-sessions/:enc/resume` and `.../turns`), not just with a den
 * session key the term manager minted. Same reject as `readHarnessTranscript` /
 * `resolveHarnessStore`: a path separator or a `..` segment is never a session
 * id, whatever it might happen to resolve to on disk. Applied before the
 * harness switch — hermes's lookup is a bound sqlite parameter and was never
 * exposed, but one rule for the whole module beats three.
 */
export function harnessSessionExists(command: string, id: string): boolean {
  if (!id || id.includes('/') || id.includes('..')) return false
  if (command === 'hermes') return hermesSessionExists(id) // sqlite lookup
  if (command === 'kimi') return kimiSessionExists(id) // session DIR under any workspace bucket
  let dir: string
  let hit: (top: string) => string
  if (command === 'claude') {
    dir = claudeProjectsDir()
    hit = (slug) => join(dir, slug, `${id}.jsonl`)
  } else if (command === 'grok') {
    dir = grokSessionsDir()
    // grok's --session-id refuses an id whose session DIR already exists, and
    // it creates that dir before summary.json — so test the dir, not the
    // (later-written) summary, or an immediate re-spawn wrongly picks
    // --session-id and errors.
    hit = (cwd) => join(dir, cwd, id)
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
  if (commands.includes('hermes')) all.push(...listHermesSessions(limit))
  if (commands.includes('kimi')) all.push(...(await listKimiSessions(limit)))
  all.sort((a, b) => b.updatedAt - a.updatedAt) // last-updated first
  return all.slice(0, limit)
}

// ---- Transcript read (resync chat UI from on-disk TUI store) ---------------

/** One user/assistant turn pulled from a harness session store. The wire
 *  shape (@rivetos/types HarnessTranscriptTurn) IS the parse shape — one
 *  source of truth for server and clients. */
export type HarnessTurn = HarnessTranscriptTurn

/**
 * Claude Code message.usage → MessageUsage. promptTokens includes cache
 * (input + cache_read + cache_creation), matching den-hook readTurnUsage.
 */
function extractClaudeUsage(
  msg: { usage?: unknown; model?: unknown } | undefined,
): Pick<HarnessTurn, 'usage' | 'model'> {
  const out: Pick<HarnessTurn, 'usage' | 'model'> = {}
  if (typeof msg?.model === 'string' && msg.model.trim()) out.model = msg.model.trim()
  const u = msg?.usage
  if (!u || typeof u !== 'object') return out
  const o = u as Record<string, unknown>
  const input = typeof o.input_tokens === 'number' ? o.input_tokens : 0
  const cacheRead = typeof o.cache_read_input_tokens === 'number' ? o.cache_read_input_tokens : 0
  const cacheCreate =
    typeof o.cache_creation_input_tokens === 'number' ? o.cache_creation_input_tokens : 0
  const output = typeof o.output_tokens === 'number' ? o.output_tokens : 0
  const prompt = input + cacheRead + cacheCreate
  if (prompt <= 0 && output <= 0) return out
  out.usage = {
    promptTokens: prompt > 0 ? prompt : input,
    completionTokens: output,
    cachedTokens: cacheRead,
  }
  return out
}

export interface HarnessTranscript {
  /** session id that was requested */
  id: string
  /** which harness store produced the turns (or '' if none found) */
  command: string
  turns: HarnessTurn[]
}

/** Cap full transcript reads — multi-MB jsonl is real; chat UI only needs turns. */
const TRANSCRIPT_MAX_BYTES = 8 * 1024 * 1024

/**
 * Pull display text out of a message content value (string or content blocks).
 * Keeps `text` blocks; drops thinking / tool_use / tool_result. Returns null
 * for turns with no human-visible text.
 */
function extractTurnText(content: unknown, role: 'user' | 'assistant'): string | null {
  let text = ''
  if (typeof content === 'string') {
    text = content
  } else if (Array.isArray(content)) {
    text = content
      .map((b) => {
        if (!b || typeof b !== 'object') return ''
        const block = b as { type?: unknown; text?: unknown }
        if (block.type !== 'text' || typeof block.text !== 'string') return ''
        return block.text
      })
      .filter(Boolean)
      .join('\n')
  }
  text = text.trim()
  if (!text) return null
  // Skip harness-injected wrappers that aren't real conversational content
  // (mirrors Android SessionTranscript.extractText). <task-notification> is
  // Claude Code's background-task completion notice — it reads like tool
  // output and must never render as something the user typed.
  if (
    role === 'user' &&
    (text.startsWith('<command-') ||
      text.startsWith('<local-command') ||
      text.startsWith('<system-reminder') ||
      text.startsWith('<task-notification') ||
      text.startsWith('<user_info') ||
      text.startsWith('Caveat:'))
  ) {
    return null
  }
  // grok wraps the actual user message in <user_query>…</user_query>
  if (role === 'user' && text.startsWith('<user_query>')) {
    const end = text.indexOf('</user_query>')
    text = (
      end >= 0 ? text.slice('<user_query>'.length, end) : text.slice('<user_query>'.length)
    ).trim()
    if (!text) return null
  }
  return text
}

async function parseJsonlObjects(file: string): Promise<Record<string, unknown>[]> {
  let raw: string
  try {
    const s = await stat(file)
    if (s.size > TRANSCRIPT_MAX_BYTES) {
      // Read the tail so we still get recent turns rather than failing hard.
      const fh = await open(file, 'r')
      try {
        const start = Math.max(0, s.size - TRANSCRIPT_MAX_BYTES)
        const buf = Buffer.alloc(s.size - start)
        await fh.read(buf, 0, buf.length, start)
        raw = buf.toString('utf8')
        // Drop partial first line after a mid-file seek.
        if (start > 0) {
          const nl = raw.indexOf('\n')
          if (nl >= 0) raw = raw.slice(nl + 1)
        }
      } finally {
        await fh.close()
      }
    } else {
      raw = await readFile(file, 'utf8')
    }
  } catch {
    return []
  }
  const out: Record<string, unknown>[] = []
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try {
      out.push(JSON.parse(t) as Record<string, unknown>)
    } catch {
      // mid-write partial line (the harness appends incrementally) — skip
    }
  }
  return out
}

async function parseJsonlTurns(
  file: string,
  pick: (obj: Record<string, unknown>) => HarnessTurn | null,
): Promise<HarnessTurn[]> {
  const out: HarnessTurn[] = []
  for (const obj of await parseJsonlObjects(file)) {
    const turn = pick(obj)
    if (turn) out.push(turn)
  }
  return out
}

/** Keep the recent end of a long thinking trace — the UI collapses it anyway
 *  and whole traces can run to tens of KB per turn. */
const THINKING_TAIL_CHARS = 8_000

/** Summarize tool input for turn display: primitives only, strings capped —
 *  titles need hints (file_path, command), never payloads or secrets. Local
 *  twin of the live bridge's summarizeBridgeArgs (core is not a dependency
 *  of den-server, and the cap policy must match the wire's expectations). */
function summarizeTurnArgs(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, unknown> = {}
  let keys = 0
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (keys >= 12) break
    if (typeof v === 'string') {
      out[k] = v.length > 200 ? v.slice(0, 200) + '…' : v
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v
    } else {
      continue
    }
    keys++
  }
  return keys > 0 ? out : undefined
}

/**
 * Fold Claude Code store lines into LOGICAL turns. One agent turn spans many
 * store lines — one 'assistant' line per committed content block, with
 * 'user'-role tool_result lines interleaved. Only a REAL user text message
 * ends the assistant turn; everything between two user messages coalesces
 * into ONE assistant turn carrying its text, thinking tail, and tool stack
 * (matching what the live bridge streams, so a resynced transcript and a
 * watched-live one look identical).
 */
function claudeTurnsFromLines(lines: Record<string, unknown>[]): HarnessTurn[] {
  const turns: HarnessTurn[] = []
  // tool_use id → entry on the current turn; results arrive on later lines
  let toolsById = new Map<string, HarnessTranscriptTool>()
  let cur: HarnessTurn | null = null
  let outputTokens = 0
  let thinking = ''

  const finishAssistant = (): void => {
    if (cur) {
      if (thinking) {
        cur.thinking =
          thinking.length > THINKING_TAIL_CHARS
            ? '…' + thinking.slice(-THINKING_TAIL_CHARS)
            : thinking
      }
      if (cur.tools && cur.tools.length === 0) delete cur.tools
      if (cur.usage) cur.usage.completionTokens = outputTokens
      // a turn with no visible content at all (blocks not flushed yet) is noise
      if (cur.text || cur.thinking || cur.tools) turns.push(cur)
    }
    cur = null
    outputTokens = 0
    thinking = ''
    toolsById = new Map()
  }

  for (const obj of lines) {
    if (obj.isSidechain === true || obj.isMeta === true || obj.isCompactSummary === true) continue
    if (obj.type !== 'user' && obj.type !== 'assistant') continue
    const msg = obj.message as { content?: unknown; usage?: unknown; model?: unknown } | undefined
    const content = msg?.content

    if (obj.type === 'user') {
      // Tool results ride user-role lines: they update the pending tool's
      // status but must never render as something the user typed.
      if (Array.isArray(content)) {
        for (const b of content) {
          if (!b || typeof b !== 'object') continue
          const block = b as { type?: unknown; tool_use_id?: unknown; is_error?: unknown }
          if (block.type !== 'tool_result') continue
          const entry =
            typeof block.tool_use_id === 'string' ? toolsById.get(block.tool_use_id) : undefined
          if (entry) entry.status = block.is_error === true ? 'error' : 'done'
        }
      }
      const text = extractTurnText(content, 'user')
      if (text) {
        finishAssistant()
        turns.push({ role: 'user', text })
      }
      continue
    }

    // assistant line — extend the current turn
    cur ??= { role: 'assistant', text: '', tools: [] }
    const blocks = Array.isArray(content)
      ? content
      : typeof content === 'string'
        ? [{ type: 'text', text: content }]
        : []
    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue
      const block = b as {
        type?: unknown
        text?: unknown
        thinking?: unknown
        id?: unknown
        name?: unknown
        input?: unknown
      }
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        cur.text = cur.text ? cur.text + '\n\n' + block.text.trim() : block.text.trim()
      } else if (block.type === 'thinking') {
        // stores write the trace as `thinking`; tolerate `text` variants
        const t = typeof block.thinking === 'string' ? block.thinking : block.text
        if (typeof t === 'string') thinking += t
      } else if (block.type === 'tool_use' && typeof block.name === 'string') {
        const entry: HarnessTranscriptTool = { name: block.name, status: 'running' }
        const args = summarizeTurnArgs(block.input)
        if (args) entry.args = args
        if (typeof block.id === 'string') toolsById.set(block.id, entry)
        cur.tools?.push(entry)
      }
    }
    // usage: output tokens SUM across the turn's lines; prompt/cached/model
    // take the last line that carries them (final context size, den-hook parity)
    const stats = extractClaudeUsage(msg)
    if (stats.usage) {
      outputTokens += stats.usage.completionTokens
      cur.usage = stats.usage
    }
    if (stats.model) cur.model = stats.model
  }
  finishAssistant()
  return turns
}

async function findClaudeJsonl(id: string): Promise<string | undefined> {
  const dir = claudeProjectsDir()
  let slugs: string[]
  try {
    slugs = await readdir(dir)
  } catch {
    return undefined
  }
  // Prefer the most recently modified match if the id appears under multiple cwd slugs.
  let best: { path: string; mtime: number } | undefined
  for (const slug of slugs) {
    const path = join(dir, slug, `${id}.jsonl`)
    try {
      const s = await stat(path)
      if (s.isFile() && (!best || s.mtimeMs > best.mtime)) best = { path, mtime: s.mtimeMs }
    } catch {
      /* miss */
    }
  }
  return best?.path
}

async function findGrokChatHistory(id: string): Promise<string | undefined> {
  const dir = grokSessionsDir()
  let cwdDirs: string[]
  try {
    cwdDirs = await readdir(dir)
  } catch {
    return undefined
  }
  let best: { path: string; mtime: number } | undefined
  for (const cwd of cwdDirs) {
    const path = join(dir, cwd, id, 'chat_history.jsonl')
    try {
      const s = await stat(path)
      if (s.isFile() && (!best || s.mtimeMs > best.mtime)) best = { path, mtime: s.mtimeMs }
    } catch {
      /* miss */
    }
  }
  return best?.path
}

function readHermesTurns(id: string): HarnessTurn[] {
  const db = openHermesDb()
  if (!db) return []
  try {
    const rows = db
      .prepare(
        `SELECT role, content FROM messages
         WHERE session_id = ? AND role IN ('user', 'assistant')
         ORDER BY timestamp ASC`,
      )
      .all(id)
    const out: HarnessTurn[] = []
    for (const r of rows) {
      const role = r.role === 'assistant' ? 'assistant' : r.role === 'user' ? 'user' : null
      if (!role) continue
      const text = extractTurnText(r.content, role)
      if (text) out.push({ role, text })
    }
    return out
  } catch {
    return []
  } finally {
    try {
      db.close()
    } catch {
      /* ignore */
    }
  }
}

/**
 * Read the on-disk harness transcript for a session id (Claude jsonl / Grok
 * chat_history / Hermes sqlite). This is the canonical TUI conversation state
 * used to hard-resync the RivetHub chat UI when it has diverged (Android
 * SessionTranscript + resyncTranscriptToConversation pattern).
 *
 * Tries Claude → Grok → Hermes and returns the first non-empty transcript
 * (session ids are UUIDs per harness; collisions across harnesses are rare).
 */
export async function readHarnessTranscript(id: string): Promise<HarnessTranscript> {
  if (!id || id.includes('/') || id.includes('..')) {
    return { id, command: '', turns: [] }
  }

  const claudePath = await findClaudeJsonl(id)
  if (claudePath) {
    const turns = claudeTurnsFromLines(await parseJsonlObjects(claudePath))
    if (turns.length > 0) return { id, command: 'claude', turns }
  }

  const grokPath = await findGrokChatHistory(id)
  if (grokPath) {
    const turns = await parseJsonlTurns(grokPath, grokPickTurn)
    if (turns.length > 0) return { id, command: 'grok', turns }
  }

  const hermes = readHermesTurns(id)
  if (hermes.length > 0) return { id, command: 'hermes', turns: hermes }

  // kimi last, and cheaply: its ids are `session_<uuid>`, so the probe is a
  // prefix test before any filesystem work.
  if (id.startsWith(KIMI_ID_PREFIX)) {
    const kimi = await readKimiTranscript(id)
    if (kimi.turns.length > 0) return kimi
  }

  return { id, command: '', turns: [] }
}

/**
 * Claude-only transcript read — the `claude-code` driver's hard-resync source.
 *
 * Same store-scoping rule as `readGrokTranscript` below, applied to the
 * reference driver at driver three (it was the leftover the `grok-build` slice
 * recorded): a `claude-code` id whose `.jsonl` has been deleted must read as an
 * empty transcript, not as whichever other store happens to hold that id.
 */
export async function readClaudeTranscript(id: string): Promise<HarnessTranscript> {
  if (!id || id.includes('/') || id.includes('..')) return { id, command: '', turns: [] }
  const path = await findClaudeJsonl(id)
  if (!path) return { id, command: '', turns: [] }
  return { id, command: 'claude', turns: claudeTurnsFromLines(await parseJsonlObjects(path)) }
}

/**
 * Hermes-only transcript read — the `hermes` driver's hard-resync source.
 *
 * Same rule again, and it matters most here: hermes ids are not uuids
 * (`20260802_225647_6ad0b9`), so the first-hit probe's "collisions across
 * harnesses are rare" argument does not even apply to them by shape.
 */
export function readHermesTranscript(id: string): Promise<HarnessTranscript> {
  if (!id || id.includes('/') || id.includes('..')) {
    return Promise.resolve({ id, command: '', turns: [] })
  }
  return Promise.resolve({ id, command: 'hermes', turns: readHermesTurns(id) })
}

/**
 * Fold kimi `wire.jsonl` records into LOGICAL turns.
 *
 * kimi's transcript is an event log of the agent loop, not a message list, and
 * the CLI reconstructs the message view from it at read time. The record
 * semantics are kimi's own (`packages/agent-core` context restore, mirrored in
 * its daemon REST reducer) and the rivet-memory backfill tool in this repo
 * already relies on the same ones:
 *
 *   - `context.append_message`  — a real message. `origin.kind` says whose:
 *     `user` is a human turn, everything else (`injection` permission banners
 *     and todo reminders, `skill_activation`, `background_task`,
 *     `compaction_summary`) is kimi talking to itself.
 *   - `context.append_loop_event` `step.begin` — a new assistant step; later
 *     `content.part` (`text` / `think`) and `tool.call` events on that step
 *     grow the same assistant message, and `step.end` closes it with `usage`.
 *   - `context.append_loop_event` `tool.result` — pairs to a `tool.call` by
 *     `toolCallId` and carries a real `isError` flag, so unlike the den live
 *     stream a kimi transcript CAN report a failed tool honestly.
 *
 * Only a real user message ends the assistant turn, so everything between two
 * human turns coalesces into one — the same folding rule the Claude reader
 * uses, so the two harnesses' transcripts render identically.
 */
function kimiTurnsFromLines(lines: Record<string, unknown>[]): HarnessTurn[] {
  const turns: HarnessTurn[] = []
  let toolsById = new Map<string, HarnessTranscriptTool>()
  let cur: HarnessTurn | null = null
  let thinking = ''
  let prompt = 0
  let completion = 0
  let cached = 0
  let model = ''

  const finishAssistant = (): void => {
    if (cur) {
      if (thinking) {
        cur.thinking =
          thinking.length > THINKING_TAIL_CHARS
            ? '…' + thinking.slice(-THINKING_TAIL_CHARS)
            : thinking
      }
      if (cur.tools && cur.tools.length === 0) delete cur.tools
      if (prompt > 0 || completion > 0) {
        cur.usage = { promptTokens: prompt, completionTokens: completion, cachedTokens: cached }
      }
      if (model) cur.model = model
      if (cur.text || cur.thinking || cur.tools) turns.push(cur)
    }
    cur = null
    thinking = ''
    prompt = 0
    completion = 0
    cached = 0
    toolsById = new Map()
  }

  for (const obj of lines) {
    // The model actually serving the session — stamped on every llm.request,
    // and the only place the transcript names it.
    if (obj.type === 'llm.request' && typeof obj.model === 'string') model = obj.model

    if (obj.type === 'context.append_message') {
      const msg = obj.message as { role?: unknown; content?: unknown; origin?: unknown } | undefined
      const origin = (msg?.origin ?? {}) as { kind?: unknown }
      if (msg?.role !== 'user' || origin.kind !== 'user') continue
      const text = extractTurnText(msg.content, 'user')
      if (!text) continue
      finishAssistant()
      turns.push({ role: 'user', text })
      continue
    }

    if (obj.type !== 'context.append_loop_event') continue
    const event = obj.event as Record<string, unknown> | undefined
    if (!event || typeof event !== 'object') continue

    switch (event.type) {
      case 'content.part': {
        const part = event.part as { type?: unknown; text?: unknown; think?: unknown } | undefined
        if (!part) break
        cur ??= { role: 'assistant', text: '', tools: [] }
        if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
          cur.text = cur.text ? cur.text + '\n\n' + part.text.trim() : part.text.trim()
        } else if (part.type === 'think' && typeof part.think === 'string') {
          thinking += part.think
        }
        break
      }
      case 'tool.call': {
        if (typeof event.name !== 'string') break
        cur ??= { role: 'assistant', text: '', tools: [] }
        const entry: HarnessTranscriptTool = { name: event.name, status: 'running' }
        const args = summarizeTurnArgs(event.args)
        if (args) entry.args = args
        if (typeof event.toolCallId === 'string') toolsById.set(event.toolCallId, entry)
        cur.tools?.push(entry)
        break
      }
      case 'tool.result': {
        const entry =
          typeof event.toolCallId === 'string' ? toolsById.get(event.toolCallId) : undefined
        if (!entry) break
        const result = event.result as { isError?: unknown } | undefined
        entry.status = result?.isError === true ? 'error' : 'done'
        break
      }
      case 'step.end': {
        // kimi's usage split: `inputOther` is the uncached prompt, and the two
        // cache counters are prompt tokens too — summed the same way the Claude
        // reader sums input + cache_read + cache_creation, so a token count
        // means the same thing on both transcripts.
        const usage = event.usage as Record<string, unknown> | undefined
        if (!usage) break
        const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
        const read = num(usage.inputCacheRead)
        prompt += num(usage.inputOther) + read + num(usage.inputCacheCreation)
        completion += num(usage.output)
        cached += read
        break
      }
      default:
        break
    }
  }
  finishAssistant()
  return turns
}

/**
 * Kimi-only transcript read — the `kimi-code` driver's hard-resync source, and
 * the ONLY place a kimi assistant reply or thought is observable at all: its
 * `Stop` hook payload carries no reply text and no hook sees thinking, so the
 * den live stream cannot fold either one (see the driver header).
 *
 * Store-scoped like its siblings: a kimi id whose dir has been deleted reads as
 * an empty transcript, never as whichever other store happens to hold that id.
 * Only the MAIN agent's wire is read: a subagent gets its own `agents/<slot>`
 * transcript, but it is one tool call on the main thread, and splicing its
 * inner turns into the conversation would render work the user never said as
 * dialog.
 */
export async function readKimiTranscript(id: string): Promise<HarnessTranscript> {
  if (!id || id.includes('/') || id.includes('..')) return { id, command: '', turns: [] }
  const dir = kimiSessionDir(id)
  if (!dir) return { id, command: '', turns: [] }
  const wire = join(dir, 'agents', 'main', 'wire.jsonl')
  return { id, command: 'kimi', turns: kimiTurnsFromLines(await parseJsonlObjects(wire)) }
}

/**
 * Grok-only transcript read — the `grok-build` driver's hard-resync source.
 *
 * `readHarnessTranscript` probes claude → grok → hermes and returns the first
 * non-empty hit, which is right for the id-only drawer endpoint but wrong for
 * a driver: a driver already knows which harness owns the id and must never
 * serve another harness's transcript for it, however unlikely a uuid collision
 * across two stores is.
 */
export async function readGrokTranscript(id: string): Promise<HarnessTranscript> {
  if (!id || id.includes('/') || id.includes('..')) return { id, command: '', turns: [] }
  const path = await findGrokChatHistory(id)
  if (!path) return { id, command: '', turns: [] }
  return { id, command: 'grok', turns: await parseJsonlTurns(path, grokPickTurn) }
}

function grokPickTurn(obj: Record<string, unknown>): HarnessTurn | null {
  const type =
    typeof obj.type === 'string' ? obj.type : typeof obj.role === 'string' ? obj.role : ''
  if (type !== 'user' && type !== 'assistant') return null
  const text = extractTurnText(obj.content, type)
  return text ? { role: type, text } : null
}

/**
 * Parse a transcript from an ALREADY-RESOLVED store ref — the watcher's hot
 * path. Skips the per-parse store scan (findClaudeJsonl walks every project
 * slug) that readHarnessTranscript pays on each call; rotation/vanish is the
 * caller's job (an empty parse of a previously non-empty store → re-resolve).
 */
export async function readHarnessStoreAt(
  ref: HarnessStoreRef,
  id: string,
): Promise<HarnessTranscript> {
  if (ref.command === 'claude') {
    return { id, command: 'claude', turns: claudeTurnsFromLines(await parseJsonlObjects(ref.path)) }
  }
  if (ref.command === 'grok') {
    return { id, command: 'grok', turns: await parseJsonlTurns(ref.path, grokPickTurn) }
  }
  if (ref.command === 'kimi') {
    return { id, command: 'kimi', turns: kimiTurnsFromLines(await parseJsonlObjects(ref.path)) }
  }
  return { id, command: 'hermes', turns: readHermesTurns(id) }
}

// ---- Store resolution for the transcript watcher ---------------------------

export interface HarnessStoreRef {
  command: 'claude' | 'grok' | 'hermes' | 'kimi'
  /** The file to watch for changes (jsonl / chat_history / sqlite db). */
  path: string
}

/**
 * Resolve which on-disk store file backs a session id — the watch target for
 * push-based transcript sync. Same probe order as readHarnessTranscript.
 */
export async function resolveHarnessStore(id: string): Promise<HarnessStoreRef | undefined> {
  if (!id || id.includes('/') || id.includes('..')) return undefined
  const claudePath = await findClaudeJsonl(id)
  if (claudePath) return { command: 'claude', path: claudePath }
  const grokPath = await findGrokChatHistory(id)
  if (grokPath) return { command: 'grok', path: grokPath }
  if (hermesSessionExists(id)) return { command: 'hermes', path: hermesDbPath() }
  if (id.startsWith(KIMI_ID_PREFIX)) {
    const dir = kimiSessionDir(id)
    if (dir) return { command: 'kimi', path: join(dir, 'agents', 'main', 'wire.jsonl') }
  }
  return undefined
}

/** Store roots that exist on this node — watched (recursively) for the
 *  drawer's sessions-dirty signal. */
export function harnessStoreDirs(): string[] {
  const candidates = [
    claudeProjectsDir(),
    grokSessionsDir(),
    join(hermesDbPath(), '..'),
    kimiSessionsDir(),
  ]
  return candidates.filter((d) => existsSync(d))
}
