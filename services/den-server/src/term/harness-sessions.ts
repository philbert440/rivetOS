// Harness session discovery: list a harness's OWN sessions straight from its
// on-disk store, which lives on the node's local disk — so the result is
// inherently node+harness specific (no shared-DB bleed, no node tagging). This
// is how the RivetHub drawer lists conversations; opening one resumes the
// harness's native session (claude --resume <id>).
//
// Supports Claude Code (~/.claude/projects/<slug>/<id>.jsonl), grok Build
// (~/.grok/sessions/<enc-cwd>/<uuid>/summary.json), Hermes (a sqlite DB at
// ~/.hermes/state.db), Kimi Code
// (~/.kimi-code/sessions/wd_<label>_<hash>/session_<uuid>/) and Codex
// (~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl). An unknown harness
// yields [] — the drawer just shows nothing for it rather than breaking.

import { readdir, stat, open, readFile } from 'node:fs/promises'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import { type HarnessTranscriptTurn } from '@rivetos/types'
import { denJoinKey, denSessionRef, type StoreCommand } from '../harness/session-key.js'
import {
  adapterForCommand,
  claudeTurnsFromLines,
  grokTurnsFromLines,
  kimiTurnsFromLines,
  readHermesTurns,
  codexTurnsFromLines,
} from '../harness/adapters/index.js'
import { extractTurnText } from '../harness/adapters/parse-helpers.js'
import type { HarnessStoreRef } from '../harness/adapters/types.js'
import { hermesDbPath, openHermesDb } from './hermes-db.js'
import { resolveCodexRoomRollout } from './codex-room.js'

export {
  claudeTurnsFromLines,
  grokPickTurn,
  grokTurnsFromLines,
  kimiTurnsFromLines,
  readHermesTurns,
  codexTurnsFromLines,
} from '../harness/adapters/index.js'
export type { HarnessStoreRef } from '../harness/adapters/types.js'

/** Cap full transcript reads — multi-MB jsonl is real; chat UI only needs turns. */
export const DEFAULT_TRANSCRIPT_MAX_BYTES = 8 * 1024 * 1024
let transcriptMaxBytes = DEFAULT_TRANSCRIPT_MAX_BYTES

/** Test seam so watcher/parser tests can exercise the tail window without 8 MiB files. */
export function setTranscriptMaxBytesForTest(bytes?: number): void {
  transcriptMaxBytes = bytes ?? DEFAULT_TRANSCRIPT_MAX_BYTES
}

export interface HarnessSession {
  /** the harness's native session id (e.g. Claude Code's uuid) */
  id: string
  /** roster command the session belongs to (e.g. 'claude') */
  command: string
  /** first user message / summary, for the drawer label; falls back to the id */
  title: string
  /** epoch ms of last activity (file mtime) */
  updatedAt: number
  /** Model id when the store row records one. */
  model?: string
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
 * How far into `wire.jsonl` to look for the opening human turn.
 *
 * The fixed 64K head the Claude reader uses is nowhere near enough here, and
 * the reason is structural rather than bad luck: kimi's transcript opens with a
 * `config.update` carrying the whole system prompt, and on a session started
 * from a large pasted prompt the `turn.prompt` echo of that prompt runs to
 * six figures on its own. Measured across a real 55-session store, the first
 * human turn sits at:
 *
 *   | window | sessions covered |
 *   |--------|------------------|
 *   | 64K    | 37 / 54          |
 *   | 256K   | 53 / 54          |
 *   | 512K   | 54 / 54          |
 *
 * (the 55th has no human turn at all). A 64K bound would therefore label
 * roughly a THIRD of the drawer with the raw session id.
 *
 * 1 MiB is the bound, with a real early exit: the scan stops at the first human
 * turn, so the 37 sessions that answer inside 64K still cost one 64K read. Over
 * that whole store a full drawer list reads 5.0 MB rather than the 23 MB the
 * files total — and only 1.5 MB more than the 64K-per-session version that got
 * a third of the answers wrong.
 */
const KIMI_TITLE_SCAN_MAX_BYTES = 1024 * 1024
const KIMI_TITLE_CHUNK_BYTES = 64 * 1024

/**
 * First user prompt out of a session's main-agent `wire.jsonl`, for the drawer
 * label.
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
    const buf = Buffer.alloc(KIMI_TITLE_CHUNK_BYTES)
    let carry = ''
    let offset = 0
    while (offset < KIMI_TITLE_SCAN_MAX_BYTES) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, offset)
      if (bytesRead === 0) break
      offset += bytesRead
      carry += buf.subarray(0, bytesRead).toString('utf8')
      // Keep the trailing fragment for the next chunk — a wire line can be
      // hundreds of KB, so a line is regularly longer than a read.
      const lines = carry.split('\n')
      carry = lines.pop() ?? ''
      for (const line of lines) {
        const t = line.trim()
        if (!t.startsWith('{')) continue
        let d: Record<string, unknown>
        try {
          d = JSON.parse(t) as Record<string, unknown>
        } catch {
          continue
        }
        if (d.type !== 'context.append_message') continue
        const msg = d.message as { content?: unknown; origin?: { kind?: unknown } } | undefined
        // Only a HUMAN turn: kimi injects permission banners and todo reminders
        // as user-role messages with `origin.kind: 'injection'`, and one of
        // those as a drawer label would be worse than the raw id.
        if (msg?.origin?.kind !== 'user') continue
        const text = extractTurnText(msg.content, 'user')
        if (text) return text.slice(0, 120)
      }
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

// ---- Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl --------

/** ~/.codex (respects CODEX_HOME, which the CLI itself reads). */
function codexHome(): string {
  return process.env.CODEX_HOME?.trim() || join(homedir(), '.codex')
}

function codexSessionsDir(): string {
  return join(codexHome(), 'sessions')
}

/** Bare rollout UUID — no `session_` prefix. */
const CODEX_NATIVE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function uuidFromRolloutName(name: string): string | undefined {
  const m = name.match(
    /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i,
  )
  return m?.[1]
}

function isDateDir(name: string, width: number): boolean {
  return name.length === width && /^\d+$/.test(name)
}

/**
 * Walk YYYY/MM/DD looking for a rollout whose filename ends with `-<id>.jsonl`.
 * Newest mtime wins if the same uuid appears twice.
 */
function findCodexRolloutSync(id: string): string | undefined {
  if (!id || !CODEX_NATIVE_RE.test(id) || id.includes('/') || id.includes('..')) return undefined
  const root = codexSessionsDir()
  let years: string[]
  try {
    years = readdirSync(root)
  } catch {
    return undefined
  }
  let best: { path: string; mtime: number } | undefined
  const suffix = `-${id}.jsonl`
  for (const year of years) {
    if (!isDateDir(year, 4)) continue
    let months: string[]
    try {
      months = readdirSync(join(root, year))
    } catch {
      continue
    }
    for (const month of months) {
      if (!isDateDir(month, 2)) continue
      let days: string[]
      try {
        days = readdirSync(join(root, year, month))
      } catch {
        continue
      }
      for (const day of days) {
        if (!isDateDir(day, 2)) continue
        const dir = join(root, year, month, day)
        let files: string[]
        try {
          files = readdirSync(dir)
        } catch {
          continue
        }
        for (const f of files) {
          if (!f.endsWith(suffix)) continue
          const path = join(dir, f)
          try {
            const st = statSync(path)
            if (st.isFile() && (!best || st.mtimeMs > best.mtime)) {
              best = { path, mtime: st.mtimeMs }
            }
          } catch {
            /* vanished */
          }
        }
      }
    }
  }
  return best?.path
}

async function listCodexRollouts(): Promise<
  { id: string; path: string; mtime: number; birth: number }[]
> {
  const root = codexSessionsDir()
  let years: string[]
  try {
    years = await readdir(root)
  } catch {
    return []
  }
  const found: { id: string; path: string; mtime: number; birth: number }[] = []
  for (const year of years) {
    if (!isDateDir(year, 4)) continue
    let months: string[]
    try {
      months = await readdir(join(root, year))
    } catch {
      continue
    }
    for (const month of months) {
      if (!isDateDir(month, 2)) continue
      let days: string[]
      try {
        days = await readdir(join(root, year, month))
      } catch {
        continue
      }
      for (const day of days) {
        if (!isDateDir(day, 2)) continue
        const dir = join(root, year, month, day)
        let files: string[]
        try {
          files = await readdir(dir)
        } catch {
          continue
        }
        for (const f of files) {
          const id = uuidFromRolloutName(f)
          if (!id) continue
          const path = join(dir, f)
          try {
            const st = await stat(path)
            if (st.isFile()) {
              found.push({
                id,
                path,
                mtime: st.mtimeMs,
                birth: st.birthtimeMs || st.ctimeMs || st.mtimeMs,
              })
            }
          } catch {
            /* vanished */
          }
        }
      }
    }
  }
  return found
}

async function codexRolloutTitle(file: string): Promise<string> {
  const fh = await open(file, 'r')
  try {
    const buf = Buffer.alloc(64 * 1024)
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    for (const line of buf.subarray(0, bytesRead).toString('utf8').split('\n')) {
      if (!line.trim().startsWith('{')) continue
      let d: Record<string, unknown>
      try {
        d = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      if (d.type !== 'response_item') continue
      const payload = d.payload as { type?: unknown; role?: unknown; content?: unknown } | undefined
      if (payload?.type !== 'message' || payload.role !== 'user') continue
      const content = payload.content
      let text = ''
      if (typeof content === 'string') text = content
      else if (Array.isArray(content)) {
        text = content
          .map((b) =>
            b &&
            typeof b === 'object' &&
            ((b as { type?: unknown }).type === 'input_text' ||
              (b as { type?: unknown }).type === 'text') &&
            typeof (b as { text?: unknown }).text === 'string'
              ? (b as { text: string }).text
              : '',
          )
          .join('')
      }
      text = text.trim()
      if (
        !text ||
        text.startsWith('<environment_context>') ||
        text.startsWith('<skills_instructions>') ||
        text.startsWith('<multi_agent_')
      ) {
        continue
      }
      return text.slice(0, 120)
    }
  } finally {
    await fh.close()
  }
  return ''
}

async function readCodexSession(
  path: string,
  id: string,
  mtime: number,
  birth: number,
): Promise<HarnessSession> {
  const title = await codexRolloutTitle(path).catch(() => '')
  return {
    id,
    command: 'codex',
    title: title.replace(/\s+/g, ' ').trim().slice(0, 120) || id,
    updatedAt: Math.floor(mtime),
    createdAt: Math.floor(birth),
  }
}

async function listCodexSessions(limit: number): Promise<HarnessSession[]> {
  const found = await listCodexRollouts()
  found.sort((a, b) => b.mtime - a.mtime)
  const out: HarnessSession[] = []
  for (const f of found.slice(0, limit)) {
    out.push(await readCodexSession(f.path, f.id, f.mtime, f.birth))
  }
  return out
}

/**
 * Describe ONE Codex session by rollout UUID — the `codex` driver's
 * `getSession`, without paying a whole-store title scan of every day dir
 * beyond the path lookup.
 */
export async function describeCodexSession(id: string): Promise<HarnessSession | undefined> {
  if (!id || id.includes('/') || id.includes('..')) return undefined
  const path = findCodexRolloutSync(id)
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
  return readCodexSession(path, id, mtime, birth)
}

function codexSessionExists(id: string): boolean {
  return findCodexRolloutSync(id) !== undefined
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
  if (command === 'codex') return codexSessionExists(id) // rollout jsonl under YYYY/MM/DD
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
  if (commands.includes('codex')) all.push(...(await listCodexSessions(limit)))
  all.sort((a, b) => b.updatedAt - a.updatedAt) // last-updated first
  return all.slice(0, limit)
}

// ---- Transcript read (resync chat UI from on-disk TUI store) ---------------

/** One user/assistant turn pulled from a harness session store. The wire
 *  shape (@rivetos/types HarnessTranscriptTurn) IS the parse shape — one
 *  source of truth for server and clients. */
export type HarnessTurn = HarnessTranscriptTurn

export interface HarnessTranscript {
  /** session id that was requested */
  id: string
  /** which harness store produced the turns (or '' if none found) */
  command: string
  turns: HarnessTurn[]
  /** Present when the on-disk store exceeded the parse window (tail only). */
  truncated?: true
}

async function parseJsonlObjects(
  file: string,
): Promise<{ objects: Record<string, unknown>[]; truncated: boolean }> {
  let raw: string
  let truncated = false
  try {
    const s = await stat(file)
    if (s.size > transcriptMaxBytes) {
      // Read the tail so we still get recent turns rather than failing hard.
      const fh = await open(file, 'r')
      try {
        const start = Math.max(0, s.size - transcriptMaxBytes)
        const buf = Buffer.alloc(s.size - start)
        await fh.read(buf, 0, buf.length, start)
        raw = buf.toString('utf8')
        truncated = start > 0
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
    return { objects: [], truncated: false }
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
  return { objects: out, truncated }
}

function withTruncated<T extends { turns: HarnessTurn[] }>(
  t: T,
  truncated: boolean,
): T & { truncated?: true } {
  return truncated ? { ...t, truncated: true } : t
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

/**
 * Read the on-disk harness transcript for a session id (Claude jsonl / Grok
 * chat_history / Hermes sqlite). This is the canonical TUI conversation state
 * used to hard-resync the RivetHub chat UI when it has diverged (Android
 * SessionTranscript + resyncTranscriptToConversation pattern).
 *
 * `id` may be a canonical `<harness-id>:<native>` SessionId or the bare native
 * id the store files the transcript under. The store lookup uses the den join
 * key either way and `id` is echoed back exactly as asked for, so a caller
 * keyed on canonical ids can match the response to its request.
 *
 * A BARE id has to be probed Claude → Grok → Hermes → Kimi, returning the
 * first non-empty transcript — it carries no harness, and that is the
 * documented legacy behavior. A CANONICAL id names its store, so it reads that
 * store and only that store: answering `claude-code:<uuid>` out of grok's
 * store on a uuid collision would be exactly the cross-store fall-through the
 * identity standard forbids (§ Collision rules, rule 2 — different harness id
 * means a different session, full stop). An empty answer is the correct answer
 * there.
 */
export async function readHarnessTranscript(id: string): Promise<HarnessTranscript> {
  const { native, command } = denSessionRef(id)
  if (!native || native.includes('/') || native.includes('..')) {
    return { id, command: '', turns: [] }
  }
  /** Probe this store? Every store for a bare id; only the named one otherwise. */
  const wants = (store: StoreCommand): boolean => command === undefined || command === store

  if (wants('claude')) {
    const claudePath = await findClaudeJsonl(native)
    if (claudePath) {
      const parsed = await parseJsonlObjects(claudePath)
      const turns = claudeTurnsFromLines(parsed.objects)
      if (turns.length > 0) return withTruncated({ id, command: 'claude', turns }, parsed.truncated)
    }
  }

  if (wants('grok')) {
    const grokPath = await findGrokChatHistory(native)
    if (grokPath) {
      const parsed = await parseJsonlObjects(grokPath)
      const turns = grokTurnsFromLines(parsed.objects)
      if (turns.length > 0) {
        return withTruncated({ id, command: 'grok', turns }, parsed.truncated)
      }
    }
  }

  if (wants('codex')) {
    const codex = await readCodexTranscript(native)
    if (codex.turns.length > 0) return { ...codex, id }
  }

  if (wants('hermes')) {
    const hermes = readHermesTurns(native)
    if (hermes.length > 0) return { id, command: 'hermes', turns: hermes }
  }

  // kimi last, and cheaply: its ids are `session_<uuid>`, so the probe is a
  // prefix test before any filesystem work.
  if (wants('kimi') && native.startsWith(KIMI_ID_PREFIX)) {
    const kimi = await readKimiTranscript(native)
    if (kimi.turns.length > 0) return { ...kimi, id }
  }

  return { id, command: '', turns: [] }
}

/**
 * Claude-only transcript read — the `claude-code` driver's hard-resync source.
 *
 * Same store-scoping rule as `readGrokTranscript` below: a `claude-code`
 * id whose `.jsonl` has been deleted must read as an
 * empty transcript, not as whichever other store happens to hold that id.
 */
export async function readClaudeTranscript(id: string): Promise<HarnessTranscript> {
  if (!id || id.includes('/') || id.includes('..')) return { id, command: '', turns: [] }
  const path = await findClaudeJsonl(id)
  if (!path) return { id, command: '', turns: [] }
  const parsed = await parseJsonlObjects(path)
  return withTruncated(
    { id, command: 'claude', turns: claudeTurnsFromLines(parsed.objects) },
    parsed.truncated,
  )
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
  const parsed = await parseJsonlObjects(wire)
  return withTruncated(
    { id, command: 'kimi', turns: kimiTurnsFromLines(parsed.objects) },
    parsed.truncated,
  )
}

/**
 * Codex-only transcript read — the `codex` driver's hard-resync source.
 * Codex has no den hooks, so assistant text and thinking are only observable
 * here (rollout jsonl).
 */
export async function readCodexTranscript(id: string): Promise<HarnessTranscript> {
  if (!id || id.includes('/') || id.includes('..')) return { id, command: '', turns: [] }
  const path = findCodexRolloutSync(id) ?? (await resolveCodexRoomRollout(id, codexSessionsDir()))
  if (!path) return { id, command: '', turns: [] }
  const parsed = await parseJsonlObjects(path)
  return withTruncated(
    { id, command: 'codex', turns: codexTurnsFromLines(parsed.objects) },
    parsed.truncated,
  )
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
  const parsed = await parseJsonlObjects(path)
  return withTruncated(
    { id, command: 'grok', turns: grokTurnsFromLines(parsed.objects) },
    parsed.truncated,
  )
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
  const adapter = adapterForCommand(ref.command)
  if (!adapter) return { id, command: '', turns: [] }
  if (adapter.store.parseLines) {
    const parsed = await parseJsonlObjects(ref.path)
    const turns = adapter.store.parseObjects
      ? adapter.store.parseObjects(parsed.objects)
      : adapter.store.parseLines(parsed.objects.map((o) => JSON.stringify(o)))
    return withTruncated({ id, command: ref.command, turns }, parsed.truncated)
  }
  if (adapter.store.readTurns) {
    const turns = await adapter.store.readTurns(ref, transcriptMaxBytes, denJoinKey(id))
    return { id, command: ref.command, turns }
  }
  return { id, command: ref.command, turns: [] }
}

// ---- Store resolution for the transcript watcher ---------------------------

/**
 * Resolve which on-disk store file backs a session id — the watch target for
 * push-based transcript sync. Same probe order, same canonical-or-bare
 * acceptance, and the same no-cross-store rule as readHarnessTranscript: a
 * canonical id resolves against the store it names or against nothing. This
 * one matters twice over — the resolved ref is cached for the life of the
 * watch, so a wrong store here feeds a wrong transcript on every subsequent
 * change, not just once.
 */
export async function resolveHarnessStore(id: string): Promise<HarnessStoreRef | undefined> {
  const { native, command } = denSessionRef(id)
  if (!native || native.includes('/') || native.includes('..')) return undefined
  const wants = (store: StoreCommand): boolean => command === undefined || command === store

  if (wants('claude')) {
    const claudePath = await findClaudeJsonl(native)
    if (claudePath) return { command: 'claude', path: claudePath }
  }
  if (wants('grok')) {
    const grokPath = await findGrokChatHistory(native)
    if (grokPath) return { command: 'grok', path: grokPath }
  }
  if (wants('codex')) {
    const path =
      findCodexRolloutSync(native) ?? (await resolveCodexRoomRollout(native, codexSessionsDir()))
    if (path) return { command: 'codex', path }
  }
  if (wants('hermes') && hermesSessionExists(native)) {
    return { command: 'hermes', path: hermesDbPath() }
  }
  if (wants('kimi') && native.startsWith(KIMI_ID_PREFIX)) {
    const dir = kimiSessionDir(native)
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
    codexSessionsDir(),
  ]
  return candidates.filter((d) => existsSync(d))
}
