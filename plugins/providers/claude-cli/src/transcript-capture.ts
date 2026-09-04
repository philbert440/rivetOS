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

/**
 * Logical agent the captured sessions are filed under. Defaults to
 * `rivet-claude`; deployments that host a distinct on-device agent (the phone's
 * `claude -p`, Hermes, …) override it via `RIVETOS_CAPTURE_AGENT` so their turns
 * file under their own mesh identity (e.g. `rivet-phone-claude`). Previously this
 * override lived only in the hand-built phone bundle — a divergence that would
 * silently regress the phone on a clean rebuild. It now lives in source.
 */
export const CAPTURE_AGENT = process.env.RIVETOS_CAPTURE_AGENT || 'rivet-claude'
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
  tools: Array<{ name: string; input: unknown; id: string | null; result: string | null }>
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
  /**
   * The hook payload's `session_id`. Authoritative for the conversation key so
   * transcript-sourced rows unify with the payload path's prompt/tool rows for
   * the same session (the payload path keys on `payload.session_id`). For a
   * SubagentStop this is the parent session id, which is what merges subagent
   * turns into the parent conversation. Falls back to the transcript's own
   * sessionId, then the path-derived key.
   */
  sessionId?: string
  /**
   * Verbatim conversation key override — wins over every derived key. Set by
   * the den terminal manager (RIVETOS_SESSION_KEY=`<denSession>`) so a den
   * chat and its PTY share one conversation.
   *
   * DEPRECATED for task spawns: a `task:<taskId>` value is honored for one
   * deprecation window (see `resolveTaskContext`) but no longer produced by
   * the task executors — they pass `taskId` instead and let capture write the
   * canonical session key.
   */
  sessionKeyOverride?: string
  /**
   * Task this CLI session was spawned by (RIVETOS_TASK_ID). Recorded on the
   * conversation as `ros_conversations.task_id` at create time; it does NOT
   * influence the conversation key. The task's transcript is the query-time
   * union of every conversation carrying this id — see
   * `PostgresMemory.getTaskHistory`.
   */
  taskId?: string
  /** Postgres connection string. Falls back to resolvePgUrl(). */
  pgUrl?: string
  /** When true, mark the conversation inactive (SessionEnd). */
  markInactive?: boolean
  /** Hook event name, recorded in conversation settings for observability. */
  event?: string
  /** herdr pane identity, when the session runs inside a herdr pane. Merged
   *  into every inserted message's metadata (see herdrMeta). */
  herdr?: HerdrPaneContext
}

/** herdr pane identity for one captured session (spooled by the hook from
 *  HERDR_PANE_ID / HERDR_WORKSPACE_ID + hostname). */
export interface HerdrPaneContext {
  paneId?: string
  workspaceId?: string
  host?: string
}

/** Metadata fragment for herdr pane identity. Empty when the session is not
 *  under herdr, so non-herdr captures are byte-identical to before. */
export function herdrMeta(herdr?: HerdrPaneContext): Record<string, unknown> {
  if (!herdr?.paneId) return {}
  return {
    herdr_pane_id: herdr.paneId,
    ...(herdr.workspaceId ? { herdr_workspace_id: herdr.workspaceId } : {}),
    ...(herdr.host ? { herdr_host: herdr.host } : {}),
  }
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
 * Canonical JSON: recursively sort object keys, compact form. Used to dedup tool
 * calls reconstructed from the transcript against tool rows already stored. The
 * DB column is `jsonb`, whose `::text` serialization sorts keys by (length, then
 * bytes) and inserts spaces; a naive `JSON.stringify` preserves insertion order
 * with no spaces, so the two never match by string. Canonicalizing both sides by
 * value makes the multiset dedup correct — without it, every already-captured
 * tool call looks "missing" and gets re-inserted as a duplicate.
 */
function canon(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null)
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']'
  const o = v as Record<string, unknown>
  return (
    '{' +
    Object.keys(o)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + canon(o[k]))
      .join(',') +
    '}'
  )
}

/** Canonicalize a `jsonb::text` value read back from the DB for dedup keys. */
function canonText(t: string | null): string {
  if (t == null) return 'null'
  try {
    return canon(JSON.parse(t))
  } catch {
    return t
  }
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

  // Pre-scan: a tool_use's result lands in a *later* message (a user turn with a
  // tool_result block referencing the tool_use_id). Build the id→result map up
  // front so we can attach each result to its call in the single forward pass.
  const resultById = new Map<string, string>()
  for (const line of lines) {
    const t = line.trim()
    if (!t) continue
    let o: Record<string, unknown>
    try {
      o = JSON.parse(t) as Record<string, unknown>
    } catch {
      continue
    }
    const c = (o.message as { content?: unknown } | undefined)?.content
    if (!Array.isArray(c)) continue
    for (const b of c as Array<Record<string, unknown>>) {
      if (b.type !== 'tool_result') continue
      const id = asStr(b.tool_use_id)
      if (!id) continue
      let rc = b.content
      if (Array.isArray(rc)) {
        rc = rc
          .map((x) => (typeof x === 'string' ? x : ((x as { text?: string }).text ?? '')))
          .join('\n')
      }
      resultById.set(id, typeof rc === 'string' ? rc : JSON.stringify(rc))
    }
  }

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
    const tools: Array<{ name: string; input: unknown; id: string | null; result: string | null }> =
      []

    if (typeof c === 'string') {
      text = c
    } else if (Array.isArray(c)) {
      const textParts: string[] = []
      const thinkParts: string[] = []
      const resParts: string[] = []
      for (const b of c as Array<Record<string, unknown>>) {
        if (b.type === 'text') textParts.push(asStr(b.text) ?? '')
        else if (b.type === 'thinking') thinkParts.push(asStr(b.thinking) ?? asStr(b.text) ?? '')
        else if (b.type === 'tool_use') {
          const id = asStr(b.id)
          tools.push({
            name: asStr(b.name) ?? 'unknown',
            input: b.input,
            id,
            result: id ? (resultById.get(id) ?? null) : null,
          })
        } else if (b.type === 'tool_result') {
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

/**
 * Resolve the conversation key for an ingest. Precedence: explicit override
 * (den terminals, used verbatim; also a legacy `task:<taskId>` for the
 * deprecation window) → hook payload session_id → transcript's own session id
 * → path-derived fallback.
 */
export function resolveConversationKey(parts: {
  override?: string
  hookSessionId?: string
  transcriptSessionId?: string | null
  fallbackKey: string
}): string {
  if (parts.override) return parts.override
  if (parts.hookSessionId) return sessionKeyFromId(parts.hookSessionId)
  if (parts.transcriptSessionId) return sessionKeyFromId(parts.transcriptSessionId)
  return parts.fallbackKey
}

// ---------------------------------------------------------------------------
// Task association — RIVETOS_TASK_ID, and the RIVETOS_SESSION_KEY sunset
// ---------------------------------------------------------------------------

/** Conversation-key namespace the task executors used to write under. */
export const LEGACY_TASK_KEY_PREFIX = 'task:'

/** ros_tasks.id is a UUID (see `newTaskId()`), and so is the task_id column. */
const TASK_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Is this a value the `task_id` UUID column can hold? Env-supplied ids cross a
 * process boundary, and a malformed one must degrade to "no association"
 * rather than abort the whole ingest transaction with a 22P02.
 */
export function isTaskId(value: string | undefined): value is string {
  return value !== undefined && TASK_ID_RE.test(value)
}

/** What a spawned CLI's env says about the task (if any) that spawned it. */
export interface TaskCaptureContext {
  /** Verbatim conversation-key override, when the spawner set one. */
  sessionKeyOverride?: string
  /** Task to associate the conversation with. */
  taskId?: string
  /** True when the task came from a deprecated `RIVETOS_SESSION_KEY=task:<id>`. */
  legacyTaskKey: boolean
}

/**
 * Read the task/session context a spawned `claude` inherited from its parent.
 *
 * Two env vars, one of them on its way out:
 *
 *  - `RIVETOS_TASK_ID` (current) — task association only. Capture writes the
 *    canonical `claude-code:<session_id>` key and stamps `task_id` on the
 *    conversation; the task's transcript is the read-side union.
 *
 *  - `RIVETOS_SESSION_KEY` (legacy for tasks) — a verbatim key override. Still
 *    the contract for den terminals, where the value is the den session id and
 *    nothing about it is deprecated. A `task:<id>` value is the old task
 *    write-key override: honored unchanged for one deprecation window so a task
 *    already in flight across a rolling deploy keeps filing under the key its
 *    earlier spawns used, instead of splitting its transcript mid-task. The
 *    task id is ALSO extracted so the row is discoverable through the join.
 *
 * Removal path: the executors stopped setting `RIVETOS_SESSION_KEY=task:<id>`
 * in this change. Once no in-flight task predates that (i.e. after the fleet has
 * been on this build for longer than the longest task), drop the `legacyTaskKey`
 * branch here and the deprecation log in hooks.ts — reads keep working, because
 * the union already covers `task:<id>`-keyed rows and always will.
 */
export function resolveTaskContext(env: NodeJS.ProcessEnv): TaskCaptureContext {
  const override = env.RIVETOS_SESSION_KEY || undefined
  const legacyTaskKey = override !== undefined && override.startsWith(LEGACY_TASK_KEY_PREFIX)
  const explicit = env.RIVETOS_TASK_ID || undefined
  const fromLegacy = legacyTaskKey
    ? override.slice(LEGACY_TASK_KEY_PREFIX.length) || undefined
    : undefined
  return { sessionKeyOverride: override, taskId: explicit ?? fromLegacy, legacyTaskKey }
}

interface ConvRow {
  id: string
  created: boolean
  title: string | null
}

/**
 * Whether `ros_conversations.task_id` exists (migration 0011).
 *
 * Probed rather than assumed: capture runs from a detached hook worker on every
 * node, and the deploy order is code first, `rivetos db migrate` second. On an
 * unmigrated node the association is simply skipped — the turns still land under
 * the canonical key, and the task's legacy `task:<id>` conversation still
 * carries whatever the pre-deploy spawns wrote.
 *
 * `to_regclass` returns NULL instead of raising for an unresolvable name, and a
 * NULL attrelid matches no pg_attribute row, so this is safe inside the caller's
 * open transaction: it cannot poison it the way a failed column reference would.
 */
async function hasTaskIdColumn(client: PoolClient): Promise<boolean> {
  const res = await client.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_attribute
        WHERE attrelid = to_regclass('ros_conversations')
          AND attname = 'task_id'
          AND NOT attisdropped
     ) AS present`,
  )
  return res.rows[0]?.present ?? false
}

/**
 * Find — or create — the `rivet-claude` conversation for `sessionKey`. Must be
 * called inside a transaction already holding the per-session advisory lock,
 * so the find-or-create is race-free against a concurrent ingest.
 *
 * `init.taskId` is recorded on the row so the task's transcript can be read as
 * the union of every conversation it spawned. On an existing row it is only
 * backfilled when NULL — an established association is never repointed, and the
 * first writer wins for a conversation that somehow saw two task contexts.
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
    taskId?: string
  },
): Promise<ConvRow> {
  // A non-UUID task id (or an unmigrated node) means no association, never a
  // failed ingest: losing the join is recoverable, losing the turns is not.
  const taskId = isTaskId(init.taskId) && (await hasTaskIdColumn(client)) ? init.taskId : undefined

  const existing = await client.query<{ id: string; title: string | null }>(
    `SELECT id, title FROM ros_conversations WHERE session_key = $1 AND agent = $2`,
    [sessionKey, CAPTURE_AGENT],
  )
  if (existing.rows.length > 0) {
    if (taskId !== undefined) {
      await client.query(
        `UPDATE ros_conversations SET task_id = $2 WHERE id = $1 AND task_id IS NULL`,
        [existing.rows[0].id, taskId],
      )
    }
    return { id: existing.rows[0].id, created: false, title: existing.rows[0].title }
  }
  const conv = await client.query<{ id: string }>(
    `INSERT INTO ros_conversations
       (session_key, agent, channel, title, settings, active, created_at, updated_at
        ${taskId !== undefined ? ', task_id' : ''})
     VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,now()),COALESCE($8,now())
        ${taskId !== undefined ? ', $9' : ''})
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
      ...(taskId !== undefined ? [taskId] : []),
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
 * Reconcile `transcriptPath` into its conversation: insert every turn the DB is
 * missing — assistant text/reasoning, user prompts, and tool calls — and nothing
 * it already has. This is the self-healing capture path.
 *
 * The live UserPromptSubmit / PostToolUse hooks write prompt + tool rows in real
 * time; this transcript pass is their safety net. Whenever a live hook didn't
 * fire or didn't reach the datahub (off-mesh, crash, model switch), the next
 * Stop recovers the missed rows here — the transcript is the complete,
 * authoritative record of the session.
 *
 * Dedup is per-role so re-importing never doubles a live-captured row:
 *  - assistant — by transcript `uuid` (assistant rows always carry it).
 *  - tool      — by (tool_name + canonical-JSON args) multiset vs stored tool rows.
 *  - user      — by content multiset vs stored user prompts.
 * Multiset (count-based) dedup handles legitimately repeated prompts / identical
 * tool calls. Safe to call repeatedly and concurrently for the same session (a
 * per-session advisory lock serialises ingests).
 *
 * Caveat: a tool row recovered here can race a still-spooled offline replay of
 * the same PostToolUse, producing a rare duplicate; the offline outbox is the
 * unreliable edge and the recovered call is the higher-value record.
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

  // Desired state from the transcript, split by role.
  // Assistant turns carrying real text/reasoning (pure "[tool call]" placeholder
  // turns are represented by their tool rows below, not as assistant rows).
  const assistantMsgs = parsed.msgs.filter(
    (m) => m.role === 'assistant' && m.content !== '' && !m.content.startsWith('[tool call]'),
  )
  // Genuine user prompts only. A user turn that carries a tool_result (parseTranscript
  // folds the result into content and sets toolResult) is not a prompt — the live
  // UserPromptSubmit never captured those, so importing them would be noise.
  const userMsgs = parsed.msgs.filter(
    (m) =>
      m.role === 'user' &&
      m.toolResult == null &&
      m.content !== '' &&
      !m.content.startsWith('[tool call]'),
  )
  // One tool row per tool_use block, carrying its paired result.
  const toolCalls = parsed.msgs.flatMap((m) =>
    m.tools.map((t) => ({ ...t, uuid: m.uuid, ts: m.ts })),
  )

  if (assistantMsgs.length === 0 && userMsgs.length === 0 && toolCalls.length === 0) {
    return {
      sessionKey: fallbackKey,
      conversationId: '',
      created: false,
      inserted: 0,
      alreadyStored: 0,
      skipped: 'nothing to ingest',
    }
  }

  // Authoritative key order: an explicit override (den terminals, and legacy
  // task spawns) beats the hook payload's session_id, which beats the
  // transcript's own id, then the path-derived key. session_id keying unifies
  // transcript rows with the payload path and merges subagent turns into the
  // parent. Task association rides alongside as `taskId` — it never changes
  // the key.
  const sessionKey = resolveConversationKey({
    override: opts.sessionKeyOverride,
    hookSessionId: opts.sessionId,
    transcriptSessionId: parsed.sessionId,
    fallbackKey,
  })

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
      session_id: opts.sessionId ?? parsed.sessionId,
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
      taskId: opts.taskId,
    })

    let inserted = 0
    let alreadyStored = 0

    // --- assistant: dedup by transcript uuid (stable per entry) ---
    const storedA = await client.query<{ uuid: string | null }>(
      `SELECT metadata->>'uuid' AS uuid FROM ros_messages
        WHERE conversation_id = $1 AND role = 'assistant' AND metadata ? 'uuid'`,
      [conv.id],
    )
    const seenA = new Set(storedA.rows.map((r) => r.uuid).filter((u): u is string => u !== null))
    alreadyStored += seenA.size
    for (const m of assistantMsgs.filter((m) => !m.uuid || !seenA.has(m.uuid))) {
      await insertMessage(client, conv.id, {
        role: 'assistant',
        content: m.content,
        metadata: {
          source: 'claude-code-hook',
          uuid: m.uuid,
          sidechain: m.sidechain,
          ...herdrMeta(opts.herdr),
        },
        ts: m.ts,
      })
      inserted++
    }

    // --- tool: dedup by (tool_name + canonical args) multiset ---
    const storedT = await client.query<{ tool_name: string | null; args: string | null }>(
      `SELECT tool_name, tool_args::text AS args FROM ros_messages
        WHERE conversation_id = $1 AND role = 'tool'`,
      [conv.id],
    )
    const toolHave = new Map<string, number>()
    for (const r of storedT.rows) {
      const k = `${r.tool_name}${canonText(r.args)}`
      toolHave.set(k, (toolHave.get(k) ?? 0) + 1)
    }
    alreadyStored += storedT.rows.length
    for (const t of toolCalls) {
      const k = `${t.name}${canon(t.input ?? null)}`
      const have = toolHave.get(k) ?? 0
      if (have > 0) {
        toolHave.set(k, have - 1)
        continue
      }
      await insertMessage(client, conv.id, {
        role: 'tool',
        content: `[tool call] ${t.name}`,
        toolName: t.name,
        toolArgs: t.input ?? null,
        toolResult: trunc(t.result),
        metadata: {
          source: 'claude-code-hook',
          uuid: t.uuid,
          hook_event: 'PostToolUse',
          recovered: true,
          ...herdrMeta(opts.herdr),
        },
        ts: t.ts,
      })
      inserted++
    }

    // --- user: dedup by content multiset ---
    const storedU = await client.query<{ content: string }>(
      `SELECT content FROM ros_messages WHERE conversation_id = $1 AND role = 'user'`,
      [conv.id],
    )
    const userHave = new Map<string, number>()
    for (const r of storedU.rows) userHave.set(r.content, (userHave.get(r.content) ?? 0) + 1)
    alreadyStored += storedU.rows.length
    for (const m of userMsgs) {
      const have = userHave.get(m.content) ?? 0
      if (have > 0) {
        userHave.set(m.content, have - 1)
        continue
      }
      await insertMessage(client, conv.id, {
        role: 'user',
        content: m.content,
        metadata: {
          source: 'claude-code-hook',
          uuid: m.uuid,
          recovered: true,
          ...herdrMeta(opts.herdr),
        },
        ts: m.ts,
      })
      inserted++
    }

    // Refresh conversation metadata: bump updated_at, upgrade a fallback title
    // once Claude Code has generated one, and flip active on end.
    const nextTitle = parsed.aiTitle && parsed.aiTitle !== conv.title ? parsed.aiTitle : conv.title
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
      inserted,
      alreadyStored,
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
  /** Verbatim conversation key override — see IngestOptions.sessionKeyOverride. */
  sessionKeyOverride?: string
  /** Spawning task — see IngestOptions.taskId. */
  taskId?: string
  /** Postgres connection string. Falls back to resolvePgUrl(). */
  pgUrl?: string
  /** herdr pane identity — see IngestOptions.herdr. */
  herdr?: HerdrPaneContext
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
  // Same precedence + empty-override handling as the transcript path — the
  // two ingest paths for one session must never key different conversations.
  const sessionKey = resolveConversationKey({
    override: opts.sessionKeyOverride,
    hookSessionId: sessionId,
    fallbackKey: '',
  })
  if (!sessionKey) {
    return {
      sessionKey: '',
      conversationId: '',
      created: false,
      inserted: 0,
      skipped: 'no session_id',
    }
  }

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
      return {
        sessionKey,
        conversationId: '',
        created: false,
        inserted: 0,
        skipped: 'empty prompt',
      }
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
    return {
      sessionKey,
      conversationId: '',
      created: false,
      inserted: 0,
      skipped: `unhandled event ${event}`,
    }
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
      taskId: opts.taskId,
    })

    await insertMessage(client, conv.id, {
      role: row.role,
      content: row.content,
      toolName: row.toolName,
      toolArgs: row.toolArgs,
      toolResult: row.toolResult,
      metadata: { source: 'claude-code-hook', hook_event: event, ...herdrMeta(opts.herdr) },
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
