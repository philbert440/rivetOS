/**
 * wire — JSON event interpretation plus the on-disk half of the opencode
 * executor: finding a session's transcript and reading back usage stdout
 * may not have carried.
 *
 * REVIEWER-CONFIRM: exact event schema vs installed opencode 1.18.25
 * (`opencode run --format json`). Assumed newline-delimited objects:
 *
 *   {"type":"step_start","sessionID":"ses_…"}
 *   {"type":"text","part":{"type":"text","text":"…","sessionID":"ses_…"}}
 *   {"type":"tool_use","part":{"type":"tool","tool":"bash","callID":"…",
 *     "sessionID":"ses_…","state":{"status":"running"|"completed"|"error"}}}
 *   {"type":"step_finish","sessionID":"ses_…","tokens":{"input":n,"output":n,
 *     "reasoning":n,"cache":{"read":n,"write":n}}}
 *   {"type":"error","error":{"message":"…"}}
 *
 * `parseOpencodeEvent` maps those onto a small tagged union the executor
 * turns into den `TaskEvent`s (the control-plane `HarnessEvent` type is the
 * den *driver* stream — a different package). Unknown shapes are `other`,
 * never fatal.
 *
 * REVIEWER-CONFIRM: on-disk session layout + data-dir env vs v1.18.25.
 * Assumed (XDG, matching opencode's Global.Path.data):
 *
 *   $OPENCODE_DATA_DIR | $XDG_DATA_HOME/opencode | ~/.local/share/opencode
 *     storage/session/<projectHash>/<sessionId>.json
 *     storage/message/<sessionId>/<messageId>.json
 *
 * Session JSON carries `id` + `directory` (cwd). Message JSON carries
 * `role`, `tokens`, `time.created`/`time.completed`. This module is
 * deliberately POST-HOC: the executor reads it after the child has exited.
 * Never throws: an unreadable file or a torn line degrades the numbers.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Env override for the data dir. REVIEWER-CONFIRM: actual name on v1.18.25. */
export const OPENCODE_DATA_DIR_ENV = 'OPENCODE_DATA_DIR'

/** `$OPENCODE_DATA_DIR`, else `$XDG_DATA_HOME/opencode`, else `~/.local/share/opencode`. */
export function opencodeHome(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env[OPENCODE_DATA_DIR_ENV]?.trim()
  if (explicit && explicit.length > 0) return explicit
  const xdg = env.XDG_DATA_HOME?.trim()
  if (xdg && xdg.length > 0) return path.join(xdg, 'opencode')
  return path.join(os.homedir(), '.local', 'share', 'opencode')
}

/** `<home>/storage/session`. */
export function sessionsRoot(home: string): string {
  return path.join(home, 'storage', 'session')
}

/** `<home>/storage/message`. */
export function messagesRoot(home: string): string {
  return path.join(home, 'storage', 'message')
}

export interface SessionIndexEntry {
  sessionId: string
  sessionDir: string
  workDir?: string
}

/**
 * Read every session JSON under `storage/session`. There is no kimi-style
 * `session_index.jsonl`; this walk is the index.
 */
export function readSessionIndex(home: string): SessionIndexEntry[] {
  const out: SessionIndexEntry[] = []
  for (const file of jsonFilesUnder(sessionsRoot(home), 2)) {
    const row = readJsonObject(file)
    const sessionId =
      typeof row?.id === 'string'
        ? row.id
        : path.basename(file, '.json')
    const workDir = typeof row?.directory === 'string' ? row.directory : undefined
    out.push({
      sessionId,
      sessionDir: path.dirname(file),
      ...(workDir !== undefined ? { workDir } : {}),
    })
  }
  return out
}

export interface SessionLocation {
  home: string
  cwd: string
  sessionId: string
}

/** Directory containing the session JSON for a known id, or undefined. */
export function resolveSessionDir(loc: SessionLocation): string | undefined {
  const indexed = readSessionIndex(loc.home).find((e) => e.sessionId === loc.sessionId)
  if (indexed && dirExists(indexed.sessionDir)) return indexed.sessionDir
  const guess = path.join(sessionsRoot(loc.home), loc.sessionId)
  return dirExists(guess) ? guess : undefined
}

/**
 * Every session id opencode knows for `cwd`.
 *
 * Used for the failure path only: a turn that throws never prints a session
 * id, so snapshotting the ids before the spawn and diffing after recovers
 * it — one new id is the spawn's, several means concurrent same-cwd spawns
 * and the executor declines to guess.
 */
export function listSessionIds(home: string, cwd: string): Set<string> {
  const ids = new Set<string>()
  const cwdResolved = path.resolve(cwd)
  for (const entry of readSessionIndex(home)) {
    if (entry.workDir !== undefined && path.resolve(entry.workDir) !== cwdResolved) continue
    ids.add(entry.sessionId)
  }
  return ids
}

function dirExists(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

function jsonFilesUnder(root: string, maxDepth: number): string[] {
  const out: string[] = []
  const walk = (dir: string, depth: number): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name)
      if (ent.isFile() && ent.name.endsWith('.json')) out.push(full)
      else if (ent.isDirectory() && depth < maxDepth) walk(full, depth + 1)
    }
  }
  walk(root, 0)
  return out
}

function readJsonObject(file: string): Record<string, unknown> | undefined {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  try {
    const row: unknown = JSON.parse(text)
    if (typeof row !== 'object' || row === null || Array.isArray(row)) return undefined
    return row as Record<string, unknown>
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Stream JSON → tagged event
// ---------------------------------------------------------------------------

export type ParsedOpencodeKind =
  | 'text'
  | 'tool-start'
  | 'tool-end'
  | 'usage'
  | 'session'
  | 'error'
  | 'other'

export interface ParsedOpencodeEvent {
  kind: ParsedOpencodeKind
  sessionId?: string
  text?: string
  tool?: string
  toolCallId?: string
  usage?: { inputTokens: number; outputTokens: number }
  error?: string
  raw: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function tokensToUsage(tokens: Record<string, unknown>): {
  inputTokens: number
  outputTokens: number
} {
  const cache = isRecord(tokens.cache) ? tokens.cache : undefined
  return {
    inputTokens: num(tokens.input) + num(cache?.read) + num(cache?.write),
    outputTokens: num(tokens.output) + num(tokens.reasoning),
  }
}

function sessionIdOf(rec: Record<string, unknown>, part?: Record<string, unknown>): string | undefined {
  return (
    str(rec.sessionID) ??
    str(rec.sessionId) ??
    str(rec.session_id) ??
    (part ? (str(part.sessionID) ?? str(part.sessionId) ?? str(part.session_id)) : undefined)
  )
}

/**
 * Interpret one JSON object from `opencode run --format json`.
 *
 * REVIEWER-CONFIRM: field names (`sessionID` vs `sessionId`, `callID`,
 * `part.state.status`, `tokens.cache`) against a real turn on v1.18.25.
 */
export function parseOpencodeEvent(row: unknown): ParsedOpencodeEvent | undefined {
  if (!isRecord(row)) return undefined
  const type = typeof row.type === 'string' ? row.type : ''
  const part = isRecord(row.part) ? row.part : undefined
  const sessionId = sessionIdOf(row, part)
  const partType = part ? str(part.type) : undefined

  if (type === 'text' || partType === 'text') {
    const text = str(row.text) ?? (part ? str(part.text) : undefined) ?? ''
    return { kind: 'text', sessionId, text, raw: row }
  }

  const isTool =
    type === 'tool_use' ||
    type === 'tool' ||
    type === 'tool_result' ||
    type === 'tool-result' ||
    partType === 'tool'
  if (isTool) {
    const tool = str(row.tool) ?? (part ? str(part.tool) : undefined) ?? 'tool'
    const toolCallId =
      str(row.callID) ??
      str(row.toolCallId) ??
      str(row.tool_call_id) ??
      (part ? (str(part.callID) ?? str(part.id)) : undefined)
    const state = part && isRecord(part.state) ? part.state : isRecord(row.state) ? row.state : undefined
    const status = state ? str(state.status) : undefined
    const ended =
      type === 'tool_result' ||
      type === 'tool-result' ||
      status === 'completed' ||
      status === 'error'
    return {
      kind: ended ? 'tool-end' : 'tool-start',
      sessionId,
      tool,
      toolCallId,
      raw: row,
    }
  }

  if (type === 'step_finish' || type === 'step.finish' || type === 'usage') {
    const tokens = isRecord(row.tokens) ? row.tokens : undefined
    const usage = tokens ? tokensToUsage(tokens) : undefined
    return { kind: usage ? 'usage' : 'other', sessionId, usage, raw: row }
  }

  if (type === 'error' || type === 'session.error') {
    const err = isRecord(row.error) ? row.error : undefined
    return {
      kind: 'error',
      sessionId,
      error: str(row.message) ?? (err ? str(err.message) : undefined) ?? 'opencode error',
      raw: row,
    }
  }

  if (type === 'session' || type === 'session.created' || type === 'step_start') {
    return { kind: sessionId ? 'session' : 'other', sessionId, raw: row }
  }

  return { kind: 'other', sessionId, raw: row }
}

// ---------------------------------------------------------------------------
// Reconcile
// ---------------------------------------------------------------------------

export interface WireTurnUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

export interface WireTurnEnd {
  reason: string
  turnId?: number
  durationMs?: number
  timeMs: number
}

export interface WireTurnFacts {
  usage: WireTurnUsage
  /** Assistant message files counted into `usage`. Zero means "found nothing". */
  usageRecords: number
  /** Newest completed assistant message at or after the spawn clock. */
  turnEnded?: WireTurnEnd
  /** Message files read. */
  files: number
  /** Files that were not parseable JSON — tolerated, never fatal. */
  malformed: number
}

export function emptyWireTurnFacts(): WireTurnFacts {
  return {
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    usageRecords: 0,
    files: 0,
    malformed: 0,
  }
}

/** `<home>/storage/message/<sessionId>/*.json`. */
export function messageFilesFor(home: string, sessionId: string): string[] {
  const dir = path.join(messagesRoot(home), sessionId)
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  return names
    .filter((n) => n.endsWith('.json'))
    .map((n) => path.join(dir, n))
    .filter((file) => {
      try {
        return fs.statSync(file).isFile()
      } catch {
        return false
      }
    })
}

/**
 * Sum one turn's usage out of a session's message records.
 *
 * `sinceMs` is the spawn clock: a resumed session's files hold every previous
 * turn too, so the floor is what separates this turn from its predecessors.
 *
 * Never throws: an unreadable file or a torn body degrades the numbers, and
 * zero usage is a truthful "we could not tell", not a failed turn.
 */
export function reconcileTurn(opts: {
  home: string
  sessionId: string
  sinceMs: number
}): WireTurnFacts {
  const facts = emptyWireTurnFacts()
  for (const file of messageFilesFor(opts.home, opts.sessionId)) {
    let text: string
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    facts.files += 1
    let row: unknown
    try {
      row = JSON.parse(text)
    } catch {
      facts.malformed += 1
      continue
    }
    if (!isRecord(row)) {
      facts.malformed += 1
      continue
    }
    const role = str(row.role)
    if (role !== 'assistant') continue
    const time = isRecord(row.time) ? row.time : undefined
    const timeMs =
      typeof time?.completed === 'number'
        ? time.completed
        : typeof time?.created === 'number'
          ? time.created
          : undefined
    if (timeMs === undefined || timeMs < opts.sinceMs) continue
    const tokens = isRecord(row.tokens) ? row.tokens : undefined
    if (tokens === undefined) continue
    const usage = tokensToUsage(tokens)
    facts.usage.inputTokens += usage.inputTokens
    facts.usage.outputTokens += usage.outputTokens
    facts.usageRecords += 1
    const ended: WireTurnEnd = { reason: 'completed', timeMs }
    if (facts.turnEnded === undefined || ended.timeMs >= facts.turnEnded.timeMs) {
      facts.turnEnded = ended
    }
  }
  facts.usage.totalTokens = facts.usage.inputTokens + facts.usage.outputTokens
  return facts
}
