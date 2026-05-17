/**
 * transcript-capture — ingest Claude Code session transcripts into the
 * RivetOS memory DB as `rivet-claude` conversations.
 *
 * Claude Code writes every interactive session to a JSONL transcript under
 * `~/.claude/projects/<slug>/<session>.jsonl`, appending one line per turn.
 * Those files are pruned on Claude Code's local retention window, so anything
 * not copied into the memory DB is eventually lost.
 *
 * This module is the ingest half of real-time capture: the Claude Code
 * lifecycle hooks (see hooks.ts) fire on Stop / SubagentStop / SessionEnd and
 * call `ingestTranscript()` with the transcript path from the hook payload.
 * Each call re-parses the transcript and inserts only the turns not already
 * stored — so capture is incremental, idempotent, and crash-safe.
 *
 * Idempotency model: the conversation is keyed by a path-derived
 * `session_key` (stable for the life of a transcript). On each ingest we
 * count the messages already stored for that conversation and insert only
 * `parsed.slice(count)`. Because the parser is deterministic and Claude Code
 * transcripts are append-only, parsed message k always maps to stored
 * message k. This also bridges the one-shot JSONL migration: a session that
 * was bulk-migrated earlier and later continues live simply appends.
 *
 * A per-conversation advisory lock serialises concurrent ingests of the same
 * transcript (two hooks can fire close together), so no turn is doubled.
 *
 * Inserted rows are picked up automatically by the memory pipeline: the
 * ros_messages insert trigger queues embedding, and conversations crossing
 * the unsummarized threshold are compacted by the background worker.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import pg from 'pg'
import type { PoolClient } from 'pg'

const { Pool } = pg

// ---------------------------------------------------------------------------
// Constants — must match the one-shot migration so migrated + live rows unify
// ---------------------------------------------------------------------------

/** Logical agent the captured sessions are filed under. */
export const CAPTURE_AGENT = 'rivet-claude'
/** Channel label for captured sessions. */
export const CAPTURE_CHANNEL = 'claude-code'
/** Truncate giant tool outputs before they reach the embedder. */
const MAX_CONTENT = 16000
/** Hard cap on how long any single ingest may hold the DB. */
const STATEMENT_TIMEOUT_MS = 15000

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A normalized transcript turn, ready to insert into ros_messages. */
export interface ParsedMessage {
  role: string
  content: string
  toolName: string | null
  toolArgs: unknown
  toolResult: string | null
  ts: string | null
  uuid: string | null
  sidechain: boolean
  tools: Array<{ name: string; input: unknown }>
}

/** Result of parsing one transcript file. */
export interface ParsedTranscript {
  file: string
  sessionId: string | null
  aiTitle: string | null
  prUrl: string | null
  msgs: ParsedMessage[]
}

export interface IngestOptions {
  /** Absolute path to the Claude Code JSONL transcript. */
  transcriptPath: string
  /** Postgres connection string. Falls back to resolvePgUrl(). */
  pgUrl?: string
  /** When true, mark the conversation inactive (SessionEnd). */
  markInactive?: boolean
  /** Hook event name, recorded in conversation settings for observability. */
  event?: string
}

export interface IngestResult {
  sessionKey: string
  conversationId: string
  created: boolean
  inserted: number
  alreadyStored: number
  skipped?: string
}

// ---------------------------------------------------------------------------
// Env / connection resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the Postgres URL. Hooks run inside the user's Claude Code process,
 * which does not load RivetOS's `.env`; fall back to parsing it directly.
 */
export function resolvePgUrl(): string {
  if (process.env.RIVETOS_PG_URL) return process.env.RIVETOS_PG_URL
  const envFile = process.env.RIVETOS_ENV_FILE ?? path.join(os.homedir(), '.rivetos', '.env')
  try {
    const raw = fs.readFileSync(envFile, 'utf8')
    for (const line of raw.split('\n')) {
      const m = /^\s*RIVETOS_PG_URL\s*=\s*(.+?)\s*$/.exec(line)
      if (m) return m[1].replace(/^["']|["']$/g, '')
    }
  } catch {
    /* fall through to error below */
  }
  throw new Error(
    'RIVETOS_PG_URL not set and not found in ~/.rivetos/.env — cannot reach the memory DB',
  )
}

// ---------------------------------------------------------------------------
// session_key derivation — path-derived, stable, unique per transcript
// ---------------------------------------------------------------------------

/**
 * Derive the stable conversation key for a transcript. Mirrors the one-shot
 * migration: `claude-code:` + path relative to `~/.claude/projects`, minus
 * the `.jsonl` suffix. Subagent transcripts that reuse a parent sessionId
 * still get distinct keys because the file path differs.
 */
export function deriveSessionKey(transcriptPath: string): string {
  const projectsRoot = path.join(os.homedir(), '.claude', 'projects')
  const abs = path.resolve(transcriptPath)
  const rel = path.relative(projectsRoot, abs)
  const base = rel.startsWith('..') ? abs.replace(/^\/+/, '') : rel
  return 'claude-code:' + base.replace(/\.jsonl$/, '')
}

// ---------------------------------------------------------------------------
// Transcript parsing
// ---------------------------------------------------------------------------

function trunc(s: string | null): string | null {
  if (s == null) return s
  return s.length > MAX_CONTENT ? s.slice(0, MAX_CONTENT) + '\n…[truncated]' : s
}

/** Narrow an unknown JSON value to a string, or null. */
function asStr(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

/**
 * Parse a Claude Code JSONL transcript into normalized turns. Deterministic:
 * the same file always yields the same message list in the same order, which
 * is what makes the count-based idempotency in ingestTranscript() correct.
 */
export function parseTranscript(file: string): ParsedTranscript {
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  let aiTitle: string | null = null
  let sessionId: string | null = null
  let prUrl: string | null = null
  const msgs: ParsedMessage[] = []

  for (const line of lines) {
    const t = line.trim()
    if (!t) continue
    let o: Record<string, unknown>
    try {
      o = JSON.parse(t) as Record<string, unknown>
    } catch {
      continue
    }
    if (o.type === 'ai-title') {
      aiTitle = asStr(o.aiTitle) ?? aiTitle
      sessionId = sessionId ?? asStr(o.sessionId)
      continue
    }
    if (o.type === 'pr-link') {
      prUrl = asStr(o.prUrl) ?? prUrl
      continue
    }
    if (o.type !== 'user' && o.type !== 'assistant') continue
    if (o.isMeta) continue // skip local-command caveat noise
    sessionId = sessionId ?? asStr(o.sessionId)

    const m = (o.message ?? {}) as Record<string, unknown>
    const role = asStr(m.role) ?? o.type
    const c = m.content
    let text = ''
    let toolName: string | null = null
    let toolArgs: unknown = null
    let toolResult: string | null = null
    const tools: Array<{ name: string; input: unknown }> = []

    if (typeof c === 'string') {
      text = c
    } else if (Array.isArray(c)) {
      const textParts: string[] = []
      const thinkParts: string[] = []
      const resParts: string[] = []
      for (const b of c as Array<Record<string, unknown>>) {
        if (b.type === 'text') textParts.push(asStr(b.text) ?? '')
        else if (b.type === 'thinking') thinkParts.push(asStr(b.thinking) ?? asStr(b.text) ?? '')
        else if (b.type === 'tool_use')
          tools.push({ name: asStr(b.name) ?? 'unknown', input: b.input })
        else if (b.type === 'tool_result') {
          let rc = b.content
          if (Array.isArray(rc)) {
            rc = rc
              .map((x) => (typeof x === 'string' ? x : ((x as { text?: string }).text ?? '')))
              .join('\n')
          }
          resParts.push(typeof rc === 'string' ? rc : JSON.stringify(rc))
        }
      }
      text = textParts.join('\n').trim()
      if (!text && thinkParts.length) text = '[thinking] ' + thinkParts.join('\n').trim()
      if (resParts.length) toolResult = resParts.join('\n')
      if (tools.length) {
        toolName = tools[0].name
        toolArgs = tools[0].input ?? null
        if (!text) text = '[tool call] ' + tools.map((x) => x.name).join(', ')
      }
      if (!text && toolResult) text = toolResult
    }

    if (!text && !toolResult) continue // nothing useful

    msgs.push({
      role,
      content: trunc(text || '') ?? '',
      toolName,
      toolArgs,
      toolResult: trunc(toolResult),
      ts: asStr(o.timestamp),
      uuid: asStr(o.uuid),
      sidechain: !!o.isSidechain,
      tools,
    })
  }

  return { file, sessionId, aiTitle, prUrl, msgs }
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

function fallbackTitle(parsed: ParsedTranscript): string {
  const firstUser = parsed.msgs.find((m) => m.role === 'user')?.content
  return (parsed.aiTitle || firstUser || 'Claude Code session').slice(0, 120)
}

/**
 * Conversation key for a Claude Code session id. A session id is stable for
 * the whole life of an interactive `claude` session, so transcript-sourced
 * assistant rows (ingestTranscript) and hook-sourced prompt/tool rows
 * (ingestHookEvent) for that session unify into one conversation. Mirrors the
 * `claude-code:` prefix deriveSessionKey() uses.
 *
 * Note: RivetOS agent sessions run claude with --no-session-persistence, so
 * every turn is a fresh spawn with a new session id — those become one
 * conversation per turn. Capture is still complete; turns just aren't grouped.
 */
export function sessionKeyFromId(sessionId: string): string {
  return 'claude-code:' + sessionId
}

interface ConvRow {
  id: string
  created: boolean
  title: string | null
}

/**
 * Find — or create — the `rivet-claude` conversation for `sessionKey`. Must be
 * called inside a transaction already holding the per-session advisory lock,
 * so the find-or-create is race-free against a concurrent ingest.
 */
async function findOrCreateConversation(
  client: PoolClient,
  sessionKey: string,
  init: {
    title: string
    settings: Record<string, unknown>
    active: boolean
    firstTs: string | null
    lastTs: string | null
  },
): Promise<ConvRow> {
  const existing = await client.query<{ id: string; title: string | null }>(
    `SELECT id, title FROM ros_conversations WHERE session_key = $1 AND agent = $2`,
    [sessionKey, CAPTURE_AGENT],
  )
  if (existing.rows.length > 0) {
    return { id: existing.rows[0].id, created: false, title: existing.rows[0].title }
  }
  const conv = await client.query<{ id: string }>(
    `INSERT INTO ros_conversations
       (session_key, agent, channel, title, settings, active, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,now()),COALESCE($8,now()))
     RETURNING id`,
    [
      sessionKey,
      CAPTURE_AGENT,
      CAPTURE_CHANNEL,
      init.title.slice(0, 120),
      JSON.stringify(init.settings),
      init.active,
      init.firstTs,
      init.lastTs,
    ],
  )
  return { id: conv.rows[0].id, created: true, title: null }
}

/** Insert one row into ros_messages. Caller owns the transaction. */
async function insertMessage(
  client: PoolClient,
  conversationId: string,
  m: {
    role: string
    content: string
    toolName?: string | null
    toolArgs?: unknown
    toolResult?: string | null
    metadata: Record<string, unknown>
    ts?: string | null
  },
): Promise<void> {
  await client.query(
    `INSERT INTO ros_messages
       (conversation_id, agent, channel, role, content, tool_name, tool_args, tool_result, metadata, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10,now()))`,
    [
      conversationId,
      CAPTURE_AGENT,
      CAPTURE_CHANNEL,
      m.role,
      m.content,
      m.toolName ?? null,
      m.toolArgs != null ? JSON.stringify(m.toolArgs) : null,
      m.toolResult ?? null,
      JSON.stringify(m.metadata),
      m.ts ?? null,
    ],
  )
}

/**
 * Parse `transcriptPath` and insert assistant turns not already stored.
 *
 * Scope: this path now captures **assistant text + reasoning only**. Prompts
 * and tool calls are captured per-event by the UserPromptSubmit / PostToolUse
 * hooks (see ingestHookEvent) — re-importing them from the transcript would
 * double-store them. Assistant prose is the one thing no hook payload carries,
 * so the transcript remains its sole source for interactive `claude` sessions.
 *
 * Idempotency is by transcript `uuid`, not row count: hook-sourced rows share
 * this conversation, so a count-based slice would mis-align. Safe to call
 * repeatedly and concurrently for the same transcript.
 */
export async function ingestTranscript(opts: IngestOptions): Promise<IngestResult> {
  const { transcriptPath, markInactive = false, event } = opts
  const fallbackKey = deriveSessionKey(transcriptPath)

  if (!fs.existsSync(transcriptPath)) {
    return {
      sessionKey: fallbackKey,
      conversationId: '',
      created: false,
      inserted: 0,
      alreadyStored: 0,
      skipped: 'transcript file does not exist',
    }
  }

  const parsed = parseTranscript(transcriptPath)

  // Assistant turns carrying real text/reasoning. Pure tool-call turns (whose
  // content parseTranscript fills with a "[tool call]" placeholder) are owned
  // by the PostToolUse hook — skip them here.
  const assistantMsgs = parsed.msgs.filter(
    (m) => m.role === 'assistant' && m.content !== '' && !m.content.startsWith('[tool call]'),
  )
  if (assistantMsgs.length === 0) {
    return {
      sessionKey: fallbackKey,
      conversationId: '',
      created: false,
      inserted: 0,
      alreadyStored: 0,
      skipped: 'no assistant content',
    }
  }

  // Key by the transcript's own session id so hook-sourced rows for the same
  // interactive session land in this conversation. Fall back to the
  // path-derived key only for transcripts that carry no session id at all.
  const sessionKey = parsed.sessionId ? sessionKeyFromId(parsed.sessionId) : fallbackKey

  const pool = new Pool({ connectionString: opts.pgUrl ?? resolvePgUrl(), max: 1 })
  const client = await pool.connect()
  try {
    await client.query(`SET statement_timeout = ${STATEMENT_TIMEOUT_MS}`)
    await client.query('BEGIN')

    // Serialise concurrent ingests of the same session (find-or-create +
    // insert). The lock auto-releases on COMMIT/ROLLBACK.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [sessionKey])

    const firstTs = parsed.msgs.find((m) => m.ts)?.ts ?? null
    const lastTs = [...parsed.msgs].reverse().find((m) => m.ts)?.ts ?? null
    const settings = {
      source: 'claude-code-hook',
      file: transcriptPath,
      session_id: parsed.sessionId,
      pr_url: parsed.prUrl ?? null,
      last_event: event ?? null,
      last_ingest_at: new Date().toISOString(),
    }

    const conv = await findOrCreateConversation(client, sessionKey, {
      title: fallbackTitle(parsed),
      settings,
      active: !markInactive,
      firstTs,
      lastTs,
    })

    // Idempotency: dedup by transcript uuid. Each transcript entry has a
    // stable uuid, so re-ingesting a grown transcript inserts only new turns
    // regardless of how many hook-sourced rows landed in between.
    const stored = await client.query<{ uuid: string | null }>(
      `SELECT metadata->>'uuid' AS uuid FROM ros_messages
        WHERE conversation_id = $1 AND role = 'assistant' AND metadata ? 'uuid'`,
      [conv.id],
    )
    const seen = new Set(
      stored.rows.map((r) => r.uuid).filter((u): u is string => u !== null),
    )

    const fresh = assistantMsgs.filter((m) => !m.uuid || !seen.has(m.uuid))
    for (const m of fresh) {
      await insertMessage(client, conv.id, {
        role: 'assistant',
        content: m.content,
        metadata: { source: 'claude-code-hook', uuid: m.uuid, sidechain: m.sidechain },
        ts: m.ts,
      })
    }

    // Refresh conversation metadata: bump updated_at, upgrade a fallback
    // title once Claude Code has generated one, and flip active on end.
    const nextTitle =
      parsed.aiTitle && parsed.aiTitle !== conv.title ? parsed.aiTitle : conv.title
    await client.query(
      `UPDATE ros_conversations
         SET updated_at = COALESCE($2, now()),
             active = $3,
             title = COALESCE($4, title),
             settings = $5
       WHERE id = $1`,
      [conv.id, lastTs, !markInactive, nextTitle, JSON.stringify(settings)],
    )

    await client.query('COMMIT')
    return {
      sessionKey,
      conversationId: conv.id,
      created: conv.created,
      inserted: fresh.length,
      alreadyStored: seen.size,
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw err
  } finally {
    client.release()
    await pool.end()
  }
}

// ---------------------------------------------------------------------------
// Hook-event ingest — prompts + tool calls, straight from the hook payload
// ---------------------------------------------------------------------------

/**
 * Raw Claude Code hook payload for the payload-capture events. Claude Code
 * delivers these fields on stdin; no transcript read is involved — which is
 * what makes this the only capture path that works for RivetOS agent
 * sessions (they run claude in stream-json mode with no usable transcript).
 */
export interface HookEventPayload {
  hook_event_name?: string
  session_id?: string
  cwd?: string
  model?: string
  /** UserPromptSubmit */
  prompt?: string
  /** PostToolUse */
  tool_name?: string
  tool_input?: unknown
  /** Claude Code names the result `tool_response`; some payloads use `tool_result`. */
  tool_response?: unknown
  tool_result?: unknown
}

export interface HookEventOptions {
  /** The parsed hook payload from stdin. */
  payload: HookEventPayload
  /** Postgres connection string. Falls back to resolvePgUrl(). */
  pgUrl?: string
}

export interface HookEventResult {
  sessionKey: string
  conversationId: string
  created: boolean
  inserted: number
  skipped?: string
}

/** Render an unknown tool result/response into a string for storage. */
function stringifyResult(v: unknown): string | null {
  if (v == null) return null
  return typeof v === 'string' ? v : JSON.stringify(v)
}

/**
 * Ingest a single Claude Code hook event (UserPromptSubmit / PostToolUse)
 * straight from its stdin payload. The conversation is keyed by `session_id`;
 * for interactive sessions that unifies these rows with the assistant rows
 * ingestTranscript() writes for the same session.
 */
export async function ingestHookEvent(opts: HookEventOptions): Promise<HookEventResult> {
  const { payload } = opts
  const event = payload.hook_event_name ?? 'unknown'
  const sessionId = payload.session_id
  if (!sessionId) {
    return { sessionKey: '', conversationId: '', created: false, inserted: 0, skipped: 'no session_id' }
  }
  const sessionKey = sessionKeyFromId(sessionId)

  // Map the event to a single ros_messages row.
  let row: {
    role: string
    content: string
    toolName?: string | null
    toolArgs?: unknown
    toolResult?: string | null
  }
  let title = 'Claude Code session'

  if (event === 'UserPromptSubmit') {
    const prompt = typeof payload.prompt === 'string' ? payload.prompt : ''
    if (prompt.trim() === '') {
      return { sessionKey, conversationId: '', created: false, inserted: 0, skipped: 'empty prompt' }
    }
    row = { role: 'user', content: trunc(prompt) ?? '' }
    title = prompt
  } else if (event === 'PostToolUse') {
    const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : 'unknown'
    const result = stringifyResult(payload.tool_response ?? payload.tool_result)
    row = {
      role: 'tool',
      content: `[tool call] ${toolName}`,
      toolName,
      toolArgs: payload.tool_input ?? null,
      toolResult: trunc(result),
    }
  } else {
    return { sessionKey, conversationId: '', created: false, inserted: 0, skipped: `unhandled event ${event}` }
  }

  const pool = new Pool({ connectionString: opts.pgUrl ?? resolvePgUrl(), max: 1 })
  const client = await pool.connect()
  try {
    await client.query(`SET statement_timeout = ${STATEMENT_TIMEOUT_MS}`)
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [sessionKey])

    const settings = {
      source: 'claude-code-hook',
      session_id: sessionId,
      cwd: payload.cwd ?? null,
      last_event: event,
      last_ingest_at: new Date().toISOString(),
    }
    const conv = await findOrCreateConversation(client, sessionKey, {
      title,
      settings,
      active: true,
      firstTs: null,
      lastTs: null,
    })

    await insertMessage(client, conv.id, {
      role: row.role,
      content: row.content,
      toolName: row.toolName,
      toolArgs: row.toolArgs,
      toolResult: row.toolResult,
      metadata: { source: 'claude-code-hook', hook_event: event },
    })

    await client.query(
      `UPDATE ros_conversations SET updated_at = now(), settings = $2 WHERE id = $1`,
      [conv.id, JSON.stringify(settings)],
    )

    await client.query('COMMIT')
    return { sessionKey, conversationId: conv.id, created: conv.created, inserted: 1 }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw err
  } finally {
    client.release()
    await pool.end()
  }
}
