#!/usr/bin/env node
/**
 * Kimi transcript backfill — recover the conversation history the hook capture
 * never wrote, from kimi-code's own on-disk `wire.jsonl` transcripts.
 *
 * Why this exists
 * ---------------
 * The hook-payload capture worker (`../capture`) landed tool rows and lifecycle
 * markers but almost no conversation:
 *
 *   agent='rivet-kimi' on phil_memory, 2026-08-09:
 *     tool      1896
 *     system      83
 *     user         1   ← a smoke-test row, not a real prompt
 *     assistant    0
 *
 * Two independent causes, both root-caused in the capture fix PR:
 *   1. `UserPromptSubmit.prompt` arrives as an array of content parts, and the
 *      worker read it with a string-only accessor, so ~50 real prompts fell
 *      through.
 *   2. kimi's `Stop` payload carries no reply at all, so assistant text was
 *      never capturable from hooks in the first place.
 *
 * The history is not lost — kimi-code writes every turn to
 * `<sessions>/<workspace>/<session_id>/agents/<slot>/wire.jsonl`, where the
 * workspace directory is named `wd_<label>_<hash>`. This tool replays those
 * files into the same rows capture would have written.
 *
 * Identity scheme (reused verbatim from capture)
 * ----------------------------------------------
 * `contentHashEventId` here is byte-identical to the capture worker's, and rows
 * dedup the same way capture dedups: SELECT on `metadata->>'event_id'` scoped to
 * the conversation, insert only on miss. Consequences, on purpose:
 *
 *   • User rows hash with sourceEvent `UserPromptSubmit` and the same
 *     space-joined text-part rendering the fixed capture worker produces, so a
 *     backfilled prompt and a live-captured one collide — re-running this tool
 *     over sessions capture has since covered inserts nothing.
 *   • Assistant / thinking rows hash with the wire event's own uuid folded into
 *     the sourceEvent slot (`wire:content.part:<uuid>`). Capture never writes
 *     these, so there is nothing to collide with; the uuid keeps two subagents
 *     that emit identical text from collapsing into one row, while replaying the
 *     same line twice still yields one row.
 *
 * Ordering
 * --------
 * Every wire line carries `time` (epoch ms), so rows get the transcript's own
 * `created_at` rather than ingest time. Session reads order by
 * `created_at DESC, id DESC` and `id` is a random uuid, so rows tied on the
 * millisecond would come back shuffled — the parser therefore nudges each row to
 * at least 1ms after its predecessor within a file. The unmodified wire clock is
 * preserved in `metadata.event_ts`.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ---------------------------------------------------------------------------
// Constants — kept in lockstep with ../capture/src/kimi-memory-capture.ts
// ---------------------------------------------------------------------------
export const CAPTURE_AGENT = 'rivet-kimi'
export const CAPTURE_CHANNEL = 'kimi-code'
export const BACKFILL_SOURCE = 'kimi-backfill'

/** Same cap capture applies to content and tool_result. */
export const MAX_CONTENT = 16000
const STATEMENT_TIMEOUT_MS = 60000

/** Conversation title falls back to this when a session has no user turn. */
const DEFAULT_TITLE = 'Kimi Code session'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
/** A row destined for ros_messages. Mirrors capture's PendingMessage. */
export interface BackfillRow {
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolName?: string | null
  toolArgs?: unknown
  toolResult?: string | null
  /** Stored as metadata.event_id; content-hash for dedup. */
  eventId: string
  /** Unmodified wire clock, ISO-8601. */
  eventTs: string
  /** created_at to write, ISO-8601 — eventTs after the monotonic nudge. */
  createdAt: string
  extra: Record<string, unknown>
}

export interface ParseOptions {
  /** Session id the file belongs to — part of the hash material. */
  sessionId: string
  /** Agent slot the file belongs to ('main', 'agent-0', …). */
  agentSlot?: string
  /** Emit `[thinking] …` assistant rows. Default true. */
  thinking?: boolean
  /** Emit role=tool rows. Default false — see README on live-capture overlap. */
  includeTools?: boolean
}

export interface ParseResult {
  rows: BackfillRow[]
  /** Lines that were not parseable JSON. */
  malformed: number
  /** Lines parsed but deliberately not turned into rows, by reason. */
  skipped: Record<string, number>
  /** protocol_version off the transcript's metadata line, when present. */
  protocolVersion: string | null
  /** cwd off the newest config.update line, when present. */
  cwd: string | null
  /** First real user turn, trimmed — used as the conversation title. */
  firstUserText: string | null
  /** Wire clock of the metadata line, ms. */
  createdAtMs: number | null
}

/** One `agents/<slot>/wire.jsonl` on disk. */
export interface Transcript {
  file: string
  sessionId: string
  agentSlot: string
  /** `wd_*` workspace directory name. */
  workspace: string
}

// ---------------------------------------------------------------------------
// Identity — byte-identical to capture's contentHashEventId
// ---------------------------------------------------------------------------
/**
 * Stable SHA-256 hex of the fields that define message identity.
 *
 * Do not "improve" the material list: it is what the capture worker hashes, and
 * divergence would double up every row that both paths can produce.
 */
export function contentHashEventId(parts: {
  sessionId: string
  role: string
  content: string
  toolName?: string | null
  toolResult?: string | null
  sourceEvent?: string
}): string {
  const material = [
    parts.sessionId,
    parts.role,
    parts.content,
    parts.toolName ?? '',
    parts.toolResult ?? '',
    parts.sourceEvent ?? '',
  ].join('\0')
  return crypto.createHash('sha256').update(material, 'utf8').digest('hex')
}

export function deriveSessionKey(sessionId: string): string {
  return `${CAPTURE_CHANNEL}:${sessionId}`
}

/**
 * Text out of a kimi message-content value — the same filter-and-join the fixed
 * capture worker uses, so identical prompts hash identically on both paths.
 * Change one, change the other.
 *
 * The trailing `.trim()` is load-bearing and applies to **both** shapes: capture
 * trims its string path too, so a prompt that arrives as a bare string on the
 * hook and as a one-element parts array in the transcript renders to the same
 * bytes and therefore the same event_id. Drop the trim on either side and every
 * prompt with surrounding whitespace silently doubles up.
 */
export function contentText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : undefined
  }
  if (!Array.isArray(value)) return undefined
  const joined = value
    .filter(
      (part): part is { type: string; text?: unknown } =>
        typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text',
    )
    .map(part => (typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join(' ')
    .trim()
  return joined.length > 0 ? joined : undefined
}

// ---------------------------------------------------------------------------
// wire.jsonl parser
// ---------------------------------------------------------------------------
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

/**
 * Which `context.append_message` origins are real conversation, and which are
 * kimi talking to itself.
 *
 * Kept:
 *   user                      — a human turn
 *   system_trigger/subagent   — the task prompt handed to a subagent, which is
 *                               that wire file's opening turn
 *
 * Dropped (counted, never written): `injection` (permission-mode banners, todo
 * reminders, goal re-statements), `background_task` notifications,
 * `skill_activation` preambles, and `system_trigger/goal_continuation` — all
 * machine-generated context noise that would dilute recall.
 */
function classifyOrigin(origin: unknown): { keep: boolean; kind: string; name?: string } {
  const o = isRecord(origin) ? origin : {}
  const kind = asString(o.kind) ?? 'unknown'
  const name = asString(o.name) ?? undefined
  if (kind === 'user') return { keep: true, kind }
  if (kind === 'system_trigger' && name === 'subagent') return { keep: true, kind, name }
  return { keep: false, kind: name ? `${kind}:${name}` : kind }
}

/**
 * Parse one wire.jsonl into ordered rows.
 *
 * Pure and deterministic: the same bytes always yield the same rows with the
 * same event ids, which is what makes a re-run a no-op. Per-line failures are
 * counted, never thrown — a truncated final line (a session killed mid-write)
 * must not cost the rest of the file.
 *
 * Handled protocol versions: 1.4 and 1.5. The drift between them is additive
 * (`message.id`, `step.end.providerFinishReason`/`rawFinishReason`, `turn.ended`,
 * `profile.bind`, optional `tool.call.description`/`display`) and touches no
 * field this parser reads, so both are handled by one code path. Unknown future
 * versions parse on the same best-effort basis rather than being rejected.
 */
export function parseWire(text: string, opts: ParseOptions): ParseResult {
  const { sessionId, agentSlot = 'main' } = opts
  const thinking = opts.thinking !== false
  const includeTools = opts.includeTools === true

  const rows: BackfillRow[] = []
  const skipped: Record<string, number> = {}
  let malformed = 0
  let protocolVersion: string | null = null
  let cwd: string | null = null
  let firstUserText: string | null = null
  let createdAtMs: number | null = null

  const bump = (reason: string): void => {
    skipped[reason] = (skipped[reason] ?? 0) + 1
  }

  // Monotonic nudge: strictly increasing created_at within the file, so the
  // `created_at DESC, id DESC` read order is the transcript order.
  let lastMs = 0
  const push = (row: Omit<BackfillRow, 'createdAt'>, wireMs: number): void => {
    const ms = wireMs > lastMs ? wireMs : lastMs + 1
    lastMs = ms
    rows.push({ ...row, createdAt: new Date(ms).toISOString() })
  }

  // tool.call events are matched to their tool.result by toolCallId; the result
  // may be many lines later (or absent, if the session died mid-tool).
  const pendingTools = new Map<
    string,
    { name: string; args: unknown; wireMs: number; eventTs: string }
  >()
  const emitTool = (
    id: string,
    call: { name: string; args: unknown; wireMs: number; eventTs: string },
    result: { output: string | null; isError: boolean; truncated: boolean; note: string | null },
  ): void => {
    const content = result.isError ? `[tool-failure] ${call.name}` : `[tool] ${call.name}`
    const eventId = contentHashEventId({
      sessionId,
      role: 'tool',
      content,
      toolName: call.name,
      toolResult: result.output ?? '',
      sourceEvent: `wire:tool.call:${id}`,
    })
    push(
      {
        role: 'tool',
        content,
        toolName: call.name,
        toolArgs: call.args,
        toolResult: result.output,
        eventId,
        eventTs: call.eventTs,
        extra: {
          sourceEvent: 'wire:tool.call',
          agentSlot,
          toolCallId: id,
          failure: result.isError,
          ...(result.truncated ? { toolResultTruncatedByKimi: true } : {}),
          ...(result.note ? { note: result.note.slice(0, 500) } : {}),
        },
      },
      call.wireMs,
    )
  }

  const lines = text.split('\n')
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue

    let obj: unknown
    try {
      obj = JSON.parse(line)
    } catch {
      malformed++
      continue
    }
    if (!isRecord(obj)) {
      malformed++
      continue
    }

    const type = asString(obj.type)
    const wireMs = typeof obj.time === 'number' && Number.isFinite(obj.time) ? obj.time : null
    const eventTs = wireMs !== null ? new Date(wireMs).toISOString() : null

    if (type === 'metadata') {
      protocolVersion = asString(obj.protocol_version)
      if (typeof obj.created_at === 'number') createdAtMs = obj.created_at
      continue
    }

    if (type === 'config.update') {
      const c = asString(obj.cwd)
      if (c) cwd = c
      continue
    }

    if (type === 'context.append_message') {
      const message = isRecord(obj.message) ? obj.message : null
      if (!message) {
        bump('message:shapeless')
        continue
      }
      const origin = classifyOrigin(message.origin)
      if (!origin.keep) {
        bump(`origin:${origin.kind}`)
        continue
      }
      const content = contentText(message.content)
      if (!content) {
        bump('message:empty')
        continue
      }
      if (wireMs === null || !eventTs) {
        bump('message:untimed')
        continue
      }
      if (origin.kind === 'user' && firstUserText === null) firstUserText = content

      // sourceEvent 'UserPromptSubmit' on purpose: this is exactly what the
      // hook capture hashes for the same prompt, so the two paths collide
      // rather than duplicate.
      const eventId = contentHashEventId({
        sessionId,
        role: 'user',
        content,
        sourceEvent: 'UserPromptSubmit',
      })
      push(
        {
          role: 'user',
          content,
          eventId,
          eventTs,
          extra: {
            sourceEvent: 'UserPromptSubmit',
            agentSlot,
            originKind: origin.name ? `${origin.kind}:${origin.name}` : origin.kind,
          },
        },
        wireMs,
      )
      continue
    }

    if (type !== 'context.append_loop_event') {
      continue
    }

    const event = isRecord(obj.event) ? obj.event : null
    if (!event) {
      bump('loop:shapeless')
      continue
    }
    const eventType = asString(event.type)

    if (eventType === 'content.part') {
      const part = isRecord(event.part) ? event.part : null
      const partType = part ? asString(part.type) : null
      const uuid = asString(event.uuid)
      if (!part || !partType || !uuid || wireMs === null || !eventTs) {
        bump('part:shapeless')
        continue
      }
      if (partType === 'think' && !thinking) {
        bump('part:thinking-disabled')
        continue
      }
      if (partType !== 'text' && partType !== 'think') {
        bump(`part:${partType}`)
        continue
      }
      const body = asString(partType === 'text' ? part.text : part.think)
      if (!body) {
        bump('part:empty')
        continue
      }
      // `[thinking] ` prefix on an assistant row is the store-wide convention
      // (rivet-claude, and grok's ACP ingest) — ros_messages has no separate
      // reasoning column.
      const content = partType === 'think' ? `[thinking] ${body}` : body
      const sourceEvent = `wire:content.part:${uuid}`
      const eventId = contentHashEventId({
        sessionId,
        role: 'assistant',
        content,
        sourceEvent,
      })
      push(
        {
          role: 'assistant',
          content,
          eventId,
          eventTs,
          extra: {
            sourceEvent: 'wire:content.part',
            agentSlot,
            partType,
            uuid,
            ...(typeof event.turnId === 'string' || typeof event.turnId === 'number'
              ? { turnId: String(event.turnId) }
              : {}),
            ...(typeof event.step === 'number' ? { step: event.step } : {}),
          },
        },
        wireMs,
      )
      continue
    }

    if (eventType === 'tool.call') {
      const id = asString(event.toolCallId)
      const name = asString(event.name)
      if (!id || !name || wireMs === null || !eventTs) {
        bump('tool.call:shapeless')
        continue
      }
      if (!includeTools) {
        bump('tool:disabled')
        continue
      }
      pendingTools.set(id, { name, args: event.args, wireMs, eventTs })
      continue
    }

    if (eventType === 'tool.result') {
      const id = asString(event.toolCallId)
      if (!id) {
        bump('tool.result:shapeless')
        continue
      }
      const call = pendingTools.get(id)
      if (!call) {
        // Either tools are off, or the result outlived its call (compaction).
        if (includeTools) bump('tool.result:orphan')
        continue
      }
      pendingTools.delete(id)
      const result = isRecord(event.result) ? event.result : {}
      const output =
        typeof result.output === 'string'
          ? result.output
          : result.output === undefined
            ? null
            : safeJson(result.output)
      emitTool(id, call, {
        output,
        isError: result.isError === true,
        truncated: result.truncated === true,
        note: asString(result.note),
      })
      continue
    }
  }

  // A tool call whose result never arrived (session killed mid-tool) still
  // happened, and the arguments are the interesting half.
  for (const [id, call] of pendingTools) {
    emitTool(id, call, { output: null, isError: false, truncated: false, note: null })
  }

  return { rows, malformed, skipped, protocolVersion, cwd, firstUserText, createdAtMs }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v)
  } catch {
    return String(v)
  }
}

/** Capture's truncation, applied to content and tool_result alike. */
export function truncate(value: string): { stored: string; truncated: boolean } {
  if (value.length <= MAX_CONTENT) return { stored: value, truncated: false }
  return { stored: value.slice(0, MAX_CONTENT) + '\n…[truncated]', truncated: true }
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------
export function defaultSessionsDir(): string {
  const home = process.env.KIMI_CODE_HOME ?? path.join(os.homedir(), '.kimi-code')
  return path.join(home, 'sessions')
}

/**
 * Every `<workspace>/<session_id>/agents/<slot>/wire.jsonl` under `root`, in a stable
 * order. A session's subagent files (`agent-0`, `agent-1`, …) belong to the same
 * conversation as its `main` file — kimi keys them all by one session id, and so
 * does the store.
 */
export function discoverTranscripts(root: string): Transcript[] {
  const out: Transcript[] = []
  let workspaces: string[]
  try {
    workspaces = fs.readdirSync(root).sort()
  } catch {
    return out
  }
  for (const workspace of workspaces) {
    const wsDir = path.join(root, workspace)
    let sessions: string[]
    try {
      if (!fs.statSync(wsDir).isDirectory()) continue
      sessions = fs.readdirSync(wsDir).sort()
    } catch {
      continue
    }
    for (const sessionId of sessions) {
      if (!sessionId.startsWith('session_')) continue
      const agentsDir = path.join(wsDir, sessionId, 'agents')
      let slots: string[]
      try {
        slots = fs.readdirSync(agentsDir).sort()
      } catch {
        continue
      }
      for (const agentSlot of slots) {
        const file = path.join(agentsDir, agentSlot, 'wire.jsonl')
        try {
          if (!fs.statSync(file).isFile()) continue
        } catch {
          continue
        }
        out.push({ file, sessionId, agentSlot, workspace })
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Per-session aggregation
// ---------------------------------------------------------------------------
export interface SessionPlan {
  sessionId: string
  sessionKey: string
  rows: BackfillRow[]
  files: number
  malformed: number
  skipped: Record<string, number>
  protocolVersions: string[]
  cwd: string | null
  title: string
  /** Read failures, one entry per unreadable file. */
  errors: string[]
}

/** Group transcripts by session and parse each, isolating per-file failures. */
export function planSessions(
  transcripts: Transcript[],
  opts: { thinking?: boolean; includeTools?: boolean; readFile?: (f: string) => string } = {},
): SessionPlan[] {
  const read = opts.readFile ?? ((f: string) => fs.readFileSync(f, 'utf8'))
  const bySession = new Map<string, SessionPlan>()

  for (const t of transcripts) {
    let plan = bySession.get(t.sessionId)
    if (!plan) {
      plan = {
        sessionId: t.sessionId,
        sessionKey: deriveSessionKey(t.sessionId),
        rows: [],
        files: 0,
        malformed: 0,
        skipped: {},
        protocolVersions: [],
        cwd: null,
        title: DEFAULT_TITLE,
        errors: [],
      }
      bySession.set(t.sessionId, plan)
    }
    plan.files++

    let text: string
    try {
      text = read(t.file)
    } catch (err) {
      plan.errors.push(`${t.agentSlot}: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }

    let parsed: ParseResult
    try {
      parsed = parseWire(text, {
        sessionId: t.sessionId,
        agentSlot: t.agentSlot,
        thinking: opts.thinking,
        includeTools: opts.includeTools,
      })
    } catch (err) {
      plan.errors.push(`${t.agentSlot}: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }

    plan.rows.push(...parsed.rows)
    plan.malformed += parsed.malformed
    for (const [k, v] of Object.entries(parsed.skipped)) {
      plan.skipped[k] = (plan.skipped[k] ?? 0) + v
    }
    if (parsed.protocolVersion && !plan.protocolVersions.includes(parsed.protocolVersion)) {
      plan.protocolVersions.push(parsed.protocolVersion)
    }
    if (!plan.cwd && parsed.cwd) plan.cwd = parsed.cwd
    if (t.agentSlot === 'main' && parsed.firstUserText) {
      plan.title = parsed.firstUserText.replace(/\s+/g, ' ').slice(0, 120)
    }
  }

  // Ordering across a session's files is the wire clock; ties fall back to the
  // slot name so the result is deterministic.
  //
  // The nudge is per-file, so a run of rows tied inside one slot can be pushed a
  // few milliseconds past a row from another slot whose true clock sits between
  // them. Accepted: slots are concurrent agents whose interleaving was never
  // meaningful, within-slot order is the part that reads as a conversation, and
  // metadata.event_ts still carries every untouched clock for anyone who needs
  // the real cross-slot picture.
  for (const plan of bySession.values()) {
    plan.rows.sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1
      return String(a.extra.agentSlot ?? '').localeCompare(String(b.extra.agentSlot ?? ''))
    })
  }

  return [...bySession.values()].sort((a, b) => a.sessionId.localeCompare(b.sessionId))
}

export function countRoles(rows: BackfillRow[]): {
  user: number
  assistant: number
  thinking: number
  tool: number
} {
  let user = 0
  let assistant = 0
  let thinking = 0
  let tool = 0
  for (const r of rows) {
    if (r.role === 'user') user++
    else if (r.role === 'tool') tool++
    else if (r.extra.partType === 'think') thinking++
    else assistant++
  }
  return { user, assistant, thinking, tool }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
export interface CliOptions {
  dryRun: boolean
  offline: boolean
  sessionsDir: string
  pgUrl?: string
  thinking: boolean
  includeTools: boolean
  sessionFilter: string[]
  json: boolean
  help: boolean
}

export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    dryRun: true,
    offline: false,
    sessionsDir: defaultSessionsDir(),
    thinking: true,
    includeTools: false,
    sessionFilter: [],
    json: false,
    help: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const value = (): string => {
      const v = argv[i + 1]
      if (v === undefined) throw new Error(`${a} needs a value`)
      i++
      return v
    }
    switch (a) {
      case '--dry-run':
        opts.dryRun = true
        break
      case '--write':
      case '--no-dry-run':
        opts.dryRun = false
        break
      case '--offline':
        opts.offline = true
        break
      case '--sessions-dir':
        opts.sessionsDir = value()
        break
      case '--pg-url':
        opts.pgUrl = value()
        break
      case '--no-thinking':
        opts.thinking = false
        break
      case '--include-tools':
        opts.includeTools = true
        break
      case '--session':
        opts.sessionFilter.push(value())
        break
      case '--json':
        opts.json = true
        break
      case '-h':
      case '--help':
        opts.help = true
        break
      default:
        throw new Error(`unknown argument: ${a}`)
    }
  }
  return opts
}

export const USAGE = `kimi-transcript-backfill — replay kimi-code wire.jsonl transcripts into RivetOS memory

  kimi-rivet-memory-backfill [options]

  --dry-run            report only, write nothing (DEFAULT)
  --write              actually insert (alias: --no-dry-run)
  --offline            dry-run without touching the database at all
  --sessions-dir DIR   default $KIMI_CODE_HOME/sessions or ~/.kimi-code/sessions
  --pg-url URL         default $RIVETOS_PG_URL, else ~/.rivetos/.env
  --session ID         only this session id (repeatable)
  --no-thinking        skip the "[thinking] …" assistant rows
  --include-tools      also emit role=tool rows (off: live capture already has them)
  --json               machine-readable summary on stdout
  -h, --help           this text
`

/** Same resolution order as the capture worker. */
export function resolvePgUrl(explicit?: string): string {
  if (explicit) return explicit
  if (process.env.RIVETOS_PG_URL) return process.env.RIVETOS_PG_URL
  const envFile = process.env.RIVETOS_ENV_FILE ?? path.join(os.homedir(), '.rivetos', '.env')
  try {
    const raw = fs.readFileSync(envFile, 'utf8')
    for (const line of raw.split('\n')) {
      const m = /^\s*RIVETOS_PG_URL\s*=\s*(.+?)\s*$/.exec(line)
      if (m) return m[1].replace(/^["']|["']$/g, '')
    }
  } catch {
    // fall through
  }
  throw new Error('RIVETOS_PG_URL not set and not found in ~/.rivetos/.env')
}

interface SessionOutcome {
  sessionId: string
  files: number
  user: number
  assistant: number
  thinking: number
  tool: number
  malformed: number
  inserted: number
  skipped: number
  status: string
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length)
}
function padStart(s: string, n: number): string {
  return s.length >= n ? s : ' '.repeat(n - s.length) + s
}

function printTable(outcomes: SessionOutcome[]): void {
  const head = [
    pad('session', 26),
    padStart('files', 5),
    padStart('user', 5),
    padStart('asst', 5),
    padStart('think', 6),
    padStart('tool', 5),
    padStart('bad', 4),
    padStart('ins', 6),
    padStart('skip', 6),
    'status',
  ].join(' ')
  console.log(head)
  console.log('-'.repeat(head.length))
  for (const o of outcomes) {
    console.log(
      [
        pad(o.sessionId.replace(/^session_/, ''), 26),
        padStart(String(o.files), 5),
        padStart(String(o.user), 5),
        padStart(String(o.assistant), 5),
        padStart(String(o.thinking), 6),
        padStart(String(o.tool), 5),
        padStart(String(o.malformed), 4),
        padStart(String(o.inserted), 6),
        padStart(String(o.skipped), 6),
        o.status,
      ].join(' '),
    )
  }
}

/**
 * Split rows into inserted / skipped against the event ids a conversation
 * already holds.
 *
 * `have` is mutated as it goes, which is what makes the count right for a batch
 * containing its own duplicates: the write path adds each id as it inserts, so
 * the measuring paths must too, or a greenfield session with two identical
 * prompts reports two inserts where the write would make one.
 */
export function splitByEventId(
  rows: BackfillRow[],
  have: Set<string>,
): { inserted: number; skipped: number } {
  let inserted = 0
  let skipped = 0
  for (const r of rows) {
    if (have.has(r.eventId)) {
      skipped++
      continue
    }
    have.add(r.eventId)
    inserted++
  }
  return { inserted, skipped }
}

/**
 * Write (or, in dry-run, measure) one session.
 *
 * Write path follows capture's: one transaction, an advisory lock on the session
 * key so a live hook worker and this tool cannot interleave, then
 * insert-if-event_id-absent per row.
 *
 * The conversation step is *not* identical to capture's, and the difference is
 * deliberate. Capture does SELECT-then-INSERT and never touches an existing
 * conversation row; this does an `ON CONFLICT (session_key, agent) DO UPDATE SET
 * updated_at = NOW()` against the unique index from 0009/0010 — the arbiter
 * capture's own adapter uses (`adapter.ts` `ensureConversation`). One row per
 * (session_key, agent) is the shared invariant; bumping `updated_at` when rows
 * actually land is the honest signal for a conversation that just grew. What it
 * must not do is bump `updated_at` on a no-op, hence the empty-plan short-circuit
 * below: re-running the backfill over 43 already-ingested sessions leaves every
 * conversation row untouched.
 *
 * Unlike the adapter's upsert this one does not force `active = true` — a
 * transcript replayed from disk is finished history, not a resumed session.
 *
 * Dry-run opens the same connection but pins it read-only and only SELECTs the
 * event ids that already exist, so its inserted/skipped split is the real one
 * rather than a guess.
 */
export async function runSession(
  client: {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>
  },
  plan: SessionPlan,
  dryRun: boolean,
): Promise<{ inserted: number; skipped: number }> {
  // Nothing to write: never open a transaction, never touch updated_at.
  if (plan.rows.length === 0) return { inserted: 0, skipped: 0 }

  if (dryRun) {
    const conv = await client.query(
      `SELECT id FROM ros_conversations WHERE session_key = $1 AND agent = $2`,
      [plan.sessionKey, CAPTURE_AGENT],
    )
    if (conv.rows.length === 0) {
      // Greenfield session — nothing on the server side, but the batch can still
      // contain duplicates of itself.
      return splitByEventId(plan.rows, new Set<string>())
    }
    const existing = await client.query(
      `SELECT metadata->>'event_id' AS event_id FROM ros_messages
        WHERE conversation_id = $1 AND metadata->>'event_id' = ANY($2::text[])`,
      [conv.rows[0].id, plan.rows.map(r => r.eventId)],
    )
    return splitByEventId(plan.rows, new Set(existing.rows.map(r => String(r.event_id))))
  }

  await client.query('BEGIN')
  try {
    await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`)
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [plan.sessionKey])

    const upserted = await client.query(
      `INSERT INTO ros_conversations (session_key, agent, channel, title, settings, active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, false, NOW(), NOW())
       ON CONFLICT (session_key, agent) DO UPDATE
         SET updated_at = NOW()
       RETURNING id`,
      [
        plan.sessionKey,
        CAPTURE_AGENT,
        CAPTURE_CHANNEL,
        plan.title.slice(0, 120),
        JSON.stringify({
          source: BACKFILL_SOURCE,
          sessionId: plan.sessionId,
          cwd: plan.cwd,
          protocolVersions: plan.protocolVersions,
        }),
      ],
    )
    const conversationId = upserted.rows[0].id

    const existing = await client.query(
      `SELECT metadata->>'event_id' AS event_id FROM ros_messages
        WHERE conversation_id = $1 AND metadata->>'event_id' = ANY($2::text[])`,
      [conversationId, plan.rows.map(r => r.eventId)],
    )
    const have = new Set(existing.rows.map(r => String(r.event_id)))

    let inserted = 0
    let skipped = 0
    for (const row of plan.rows) {
      if (have.has(row.eventId)) {
        skipped++
        continue
      }
      have.add(row.eventId)

      const content = truncate(row.content)
      const toolResult = row.toolResult == null ? null : truncate(row.toolResult)
      const metadata: Record<string, unknown> = {
        source: BACKFILL_SOURCE,
        event_id: row.eventId,
        event_ts: row.eventTs,
        ...row.extra,
      }
      if (content.truncated) {
        metadata.full_content_length = row.content.length
        metadata.truncated = true
      }
      if (toolResult?.truncated && row.toolResult) {
        metadata.full_tool_result_length = row.toolResult.length
        metadata.truncated = true
      }

      await client.query(
        `INSERT INTO ros_messages
           (conversation_id, agent, channel, role, content, tool_name, tool_args, tool_result, metadata, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          conversationId,
          CAPTURE_AGENT,
          CAPTURE_CHANNEL,
          row.role,
          content.stored,
          row.toolName ?? null,
          row.toolArgs != null ? JSON.stringify(row.toolArgs) : null,
          toolResult?.stored ?? null,
          JSON.stringify(metadata),
          row.createdAt,
        ],
      )
      inserted++
    }

    await client.query('COMMIT')
    return { inserted, skipped }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw err
  }
}

async function main(): Promise<number> {
  let opts: CliOptions
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`${err instanceof Error ? err.message : String(err)}\n`)
    console.error(USAGE)
    return 2
  }
  if (opts.help) {
    console.log(USAGE)
    return 0
  }

  const transcripts = discoverTranscripts(opts.sessionsDir).filter(
    t => opts.sessionFilter.length === 0 || opts.sessionFilter.includes(t.sessionId),
  )
  if (transcripts.length === 0) {
    console.error(`no wire.jsonl transcripts under ${opts.sessionsDir}`)
    return 1
  }

  const plans = planSessions(transcripts, {
    thinking: opts.thinking,
    includeTools: opts.includeTools,
  })

  const outcomes: SessionOutcome[] = []
  let client: {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>
  } | null = null
  let close: (() => Promise<void>) | null = null

  if (!(opts.dryRun && opts.offline)) {
    const { default: pg } = await import('pg')
    const c = new pg.Client({ connectionString: resolvePgUrl(opts.pgUrl) })
    await c.connect()
    if (opts.dryRun) {
      // Belt and braces: a dry run physically cannot write.
      await c.query('SET default_transaction_read_only = on')
    }
    client = c as unknown as typeof client
    close = async () => {
      await c.end()
    }
  }

  try {
    for (const plan of plans) {
      const counts = countRoles(plan.rows)
      let inserted = 0
      let skipped = 0
      let status = plan.errors.length > 0 ? `read-error(${plan.errors.length})` : 'ok'
      if (client) {
        try {
          const r = await runSession(client, plan, opts.dryRun)
          inserted = r.inserted
          skipped = r.skipped
        } catch (err) {
          status = `db-error: ${err instanceof Error ? err.message : String(err)}`
        }
      } else {
        // --offline: no server side to compare against, but still report what a
        // write would do with a batch that contains duplicates of itself.
        const split = splitByEventId(plan.rows, new Set<string>())
        inserted = split.inserted
        skipped = split.skipped
        status = 'offline'
      }
      outcomes.push({
        sessionId: plan.sessionId,
        files: plan.files,
        ...counts,
        malformed: plan.malformed,
        inserted,
        skipped,
        status,
      })
      for (const e of plan.errors) console.error(`! ${plan.sessionId} ${e}`)
    }
  } finally {
    if (close) await close()
  }

  const total = outcomes.reduce(
    (acc, o) => ({
      files: acc.files + o.files,
      user: acc.user + o.user,
      assistant: acc.assistant + o.assistant,
      thinking: acc.thinking + o.thinking,
      tool: acc.tool + o.tool,
      malformed: acc.malformed + o.malformed,
      inserted: acc.inserted + o.inserted,
      skipped: acc.skipped + o.skipped,
    }),
    { files: 0, user: 0, assistant: 0, thinking: 0, tool: 0, malformed: 0, inserted: 0, skipped: 0 },
  )

  if (opts.json) {
    console.log(JSON.stringify({ mode: opts.dryRun ? 'dry-run' : 'write', total, sessions: outcomes }, null, 2))
  } else {
    console.log(
      `\nkimi transcript backfill — ${opts.dryRun ? 'DRY RUN (nothing written)' : 'WRITE'}  sessions=${outcomes.length}  dir=${opts.sessionsDir}\n`,
    )
    printTable(outcomes)
    console.log(
      `\ntotals: files=${total.files} user=${total.user} assistant=${total.assistant} thinking=${total.thinking} tool=${total.tool} malformed=${total.malformed} ${opts.dryRun ? 'would-insert' : 'inserted'}=${total.inserted} skipped=${total.skipped}`,
    )
    const skipReasons: Record<string, number> = {}
    for (const p of plans) {
      for (const [k, v] of Object.entries(p.skipped)) skipReasons[k] = (skipReasons[k] ?? 0) + v
    }
    const reasons = Object.entries(skipReasons).sort((a, b) => b[1] - a[1])
    if (reasons.length > 0) {
      console.log(`not-a-message lines: ${reasons.map(([k, v]) => `${k}=${v}`).join(' ')}`)
    }
    if (opts.dryRun) console.log('\nre-run with --write to commit.')
  }

  return outcomes.some(o => o.status.startsWith('db-error')) ? 1 : 0
}

const invokedDirectly =
  process.argv[1] !== undefined && /kimi-transcript-backfill\.(ts|js)$/.test(process.argv[1])

if (invokedDirectly) {
  main()
    .then(code => {
      process.exitCode = code
    })
    .catch(err => {
      console.error(`fatal: ${err instanceof Error ? err.stack : String(err)}`)
      process.exitCode = 1
    })
}
