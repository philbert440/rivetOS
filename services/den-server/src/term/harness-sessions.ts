// Harness session discovery: list a harness's OWN sessions straight from its
// on-disk store, which lives on the node's local disk — so the result is
// inherently node+harness specific (no shared-DB bleed, no node tagging). This
// is how the RivetHub drawer lists conversations; opening one resumes the
// harness's native session (claude --resume <id>).
//
// Supports Claude Code (~/.claude/projects/<slug>/<id>.jsonl), grok Build
// (~/.grok/sessions/<enc-cwd>/<uuid>/summary.json), and Hermes (a sqlite DB at
// ~/.hermes/state.db). An unknown harness yields [] — the drawer just shows
// nothing for it rather than breaking.

import { readdir, stat, open, readFile } from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
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

/**
 * Does a harness already have an on-disk session with this id? Store existence
 * is the ground truth for choosing --resume (continue) vs --session-id (pin a
 * NEW id) when re-spawning a conversation whose PTY was evicted (#318 review).
 * Sync + cheap (a handful of existsSync); unknown harnesses → false.
 */
export function harnessSessionExists(command: string, id: string): boolean {
  if (command === 'hermes') return hermesSessionExists(id) // sqlite lookup
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
    const turns = await parseJsonlTurns(grokPath, (obj) => {
      const type =
        typeof obj.type === 'string' ? obj.type : typeof obj.role === 'string' ? obj.role : ''
      if (type !== 'user' && type !== 'assistant') return null
      const text = extractTurnText(obj.content, type)
      return text ? { role: type, text } : null
    })
    if (turns.length > 0) return { id, command: 'grok', turns }
  }

  const hermes = readHermesTurns(id)
  if (hermes.length > 0) return { id, command: 'hermes', turns: hermes }

  return { id, command: '', turns: [] }
}

// ---- Store resolution for the transcript watcher ---------------------------

export interface HarnessStoreRef {
  command: 'claude' | 'grok' | 'hermes'
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
  return undefined
}

/** Store roots that exist on this node — watched (recursively) for the
 *  drawer's sessions-dirty signal. */
export function harnessStoreDirs(): string[] {
  const candidates = [claudeProjectsDir(), grokSessionsDir(), join(hermesDbPath(), '..')]
  return candidates.filter((d) => existsSync(d))
}
