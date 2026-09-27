#!/usr/bin/env node
/**
 * Cursor memory capture — ingest lifecycle hook payloads into RivetOS memory.
 *
 * The hook (`bin/rivet-memory-hook.sh`) spools each payload and, when this
 * file is built, pipes it to `--hook <event>`. When the payload names a
 * Cursor agent transcript, that jsonl is the source: one row per user text,
 * assistant text, and tool call, with `session_jsonl_path` and
 * `session_jsonl_line` so a truncated row can be re-read. `postToolUse`
 * supplies the tool result (the transcript has none). A Read result that is
 * only a path and a length is replaced by a slice of that file. Without a
 * transcript, the hook payload itself is stored.
 *
 * `--backfill` tails transcripts under ~/.cursor/projects and joins spool
 * results onto those tool rows. Event ids are stable, so a replay skips.
 *
 * Identity: agent='rivet-cursor', channel='cursor',
 * session_key='cursor:<conversation_id>'.
 *
 * Best-effort in `--hook` mode (always exits 0). `--backfill` exits 1 when
 * the transport is missing or a batch is rejected.
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  asString,
  createCaptureWriter,
  isRecord,
  loadEnvFile,
  resolveCaptureTransport,
  resolveDenUrl,
  withFileLock,
} from '@rivetos/capture-core'
import type { CaptureBatch, CaptureMessage, CaptureWriterOptions } from '@rivetos/capture-core'

export const CAPTURE_AGENT = 'rivet-cursor'
export const CAPTURE_CHANNEL = 'cursor'
export const CONTENT_LIMIT = 16_000

const USAGE = `cursor-rivet-memory-capture — ingest Cursor hook payloads into RivetOS memory
  cursor-rivet-memory-capture --hook <event>     read one payload from stdin
  cursor-rivet-memory-capture --backfill [--spool DIR] [--projects DIR]
  cursor-rivet-memory-capture --status
`

export interface SpoolEvent {
  event: string
  payload: Record<string, unknown>
  createdAt?: string
  file?: string
}

export interface IngestCounts {
  files: number
  conversations: number
  inserted: number
  skipped: number
  spooled: number
  failed: number
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function capText(text: string): { text: string; truncated: boolean; fullLength: number } {
  if (text.length <= CONTENT_LIMIT) return { text, truncated: false, fullLength: text.length }
  const charCode = text.charCodeAt(CONTENT_LIMIT - 1)
  const cut = CONTENT_LIMIT - (charCode >= 0xd800 && charCode <= 0xdbff ? 1 : 0)
  return { text: text.slice(0, cut), truncated: true, fullLength: text.length }
}

/** `20260927T175058Z` (hook stamp) or an ISO timestamp → ISO-8601 with a Z offset. */
export function spoolStampToIso(stamp: string | undefined): string | undefined {
  if (!stamp) return undefined
  const compact = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(stamp)
  const iso = compact
    ? `${compact[1]}-${compact[2]}-${compact[3]}T${compact[4]}:${compact[5]}:${compact[6]}.000Z`
    : stamp
  const parsed = Date.parse(iso)
  if (Number.isNaN(parsed)) return undefined
  return new Date(parsed).toISOString()
}

export function readSpoolRecord(raw: unknown, file?: string): SpoolEvent | null {
  if (!isRecord(raw)) return null
  if (isRecord(raw.payload)) {
    const event = asString(raw.hook) ?? asString(raw.payload.hook_event_name)
    if (!event) return null
    return {
      event,
      payload: raw.payload,
      createdAt: spoolStampToIso(asString(raw.ts) ?? undefined),
      file,
    }
  }
  const event = asString(raw.hook_event_name)
  if (!event) return null
  return { event, payload: raw, file }
}

function conversationId(payload: Record<string, unknown>): string | null {
  return asString(payload.conversation_id) ?? asString(payload.session_id)
}

function sessionKeyFor(conversation: string): string {
  return `cursor:${conversation}`
}

function stringList(value: unknown, max: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value.filter((item): item is string => typeof item === 'string' && item.length > 0)
  return items.length > 0 ? items.slice(0, max) : undefined
}

function baseMetadata(event: SpoolEvent, extra: Record<string, unknown>): Record<string, unknown> {
  const payload = event.payload
  const metadata: Record<string, unknown> = {
    source: 'cursor-hook',
    hook: event.event,
    ...extra,
  }
  const model = asString(payload.model)
  const version = asString(payload.cursor_version)
  const generation = asString(payload.generation_id)
  const transcript = asString(payload.transcript_path)
  const roots = stringList(payload.workspace_roots, 8)
  if (model) metadata.model = model
  if (version) metadata.cursor_version = version
  if (generation) metadata.generation_id = generation
  if (transcript) metadata.transcript_path = transcript
  if (roots) metadata.workspace_roots = roots
  return metadata
}

function message(parts: {
  event: SpoolEvent
  role: CaptureMessage['role']
  content: string
  nativeId: string
  kind: string
  toolName?: string
  toolArgs?: unknown
  toolResult?: string
  resultLength?: number
  extra?: Record<string, unknown>
}): CaptureMessage {
  const conversation = conversationId(parts.event.payload)
  if (!conversation) throw new Error('cursor capture message without a conversation id')
  const capped = capText(parts.content)
  const metadata = baseMetadata(parts.event, { native_event_id: parts.nativeId, ...parts.extra })
  if (capped.truncated) {
    metadata.truncated = true
    metadata.full_content_length = capped.fullLength
  }
  let toolResult: string | undefined
  if (parts.toolResult !== undefined) {
    const cappedResult = capText(parts.toolResult)
    toolResult = cappedResult.text
    if (cappedResult.truncated) {
      metadata.truncated = true
      metadata.full_tool_result_length = parts.resultLength ?? cappedResult.fullLength
    }
  }
  return {
    event_id: `${sessionKeyFor(conversation)}:${parts.kind}:${parts.nativeId}`,
    role: parts.role,
    content: capped.text,
    metadata,
    ...(parts.event.createdAt ? { created_at: parts.event.createdAt } : {}),
    ...(parts.toolName ? { tool_name: parts.toolName } : {}),
    ...(parts.toolArgs !== undefined ? { tool_args: parts.toolArgs } : {}),
    ...(toolResult !== undefined ? { tool_result: toolResult } : {}),
  }
}

function toolOutput(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

/** Map one Cursor hook event to zero or more memory rows. Stable ids, no email. */
export function messagesFromCursorEvent(event: SpoolEvent): CaptureMessage[] {
  const payload = event.payload
  if (!conversationId(payload)) return []
  switch (event.event) {
    case 'beforeSubmitPrompt': {
      const prompt = asString(payload.prompt)
      if (!prompt) return []
      const generation = asString(payload.generation_id) ?? 'none'
      const attachments = Array.isArray(payload.attachments) ? payload.attachments.length : 0
      return [
        message({
          event,
          role: 'user',
          content: prompt,
          kind: 'user',
          nativeId: `${generation}:${sha256(prompt).slice(0, 12)}`,
          ...(attachments > 0 ? { extra: { attachment_count: attachments } } : {}),
        }),
      ]
    }
    case 'afterAgentResponse': {
      const text = asString(payload.text)
      if (!text) return []
      const generation = asString(payload.generation_id) ?? 'none'
      return [
        message({
          event,
          role: 'assistant',
          content: text,
          kind: 'assistant',
          nativeId: `${generation}:${sha256(text).slice(0, 12)}`,
        }),
      ]
    }
    case 'postToolUse': {
      const toolName = asString(payload.tool_name) ?? 'tool'
      const toolUseId = asString(payload.tool_use_id)
      const result = toolOutput(payload.tool_output)
      const nativeId = toolUseId ?? sha256(`${toolName}\0${result}`).slice(0, 16)
      return [
        message({
          event,
          role: 'tool',
          content: toolName,
          kind: 'tool',
          nativeId,
          toolName,
          toolArgs: payload.tool_input,
          toolResult: result,
        }),
      ]
    }
    case 'sessionEnd': {
      const reason = asString(payload.reason) ?? asString(payload.final_status) ?? 'completed'
      return [
        message({
          event,
          role: 'system',
          content: `[cursor.sessionEnd] ${reason}`,
          kind: 'sessionEnd',
          nativeId: 'end',
        }),
      ]
    }
    case 'subagentStop': {
      const summary =
        asString(payload.summary) ?? asString(payload.result) ?? asString(payload.text)
      const status = asString(payload.status) ?? 'completed'
      const subId =
        asString(payload.subagent_id) ??
        asString(payload.agent_id) ??
        asString(payload.tool_use_id) ??
        sha256(summary ?? status).slice(0, 12)
      return [
        message({
          event,
          role: summary ? 'assistant' : 'system',
          content: summary ?? `[cursor.subagentStop] ${status}`,
          kind: 'subagent',
          nativeId: subId,
        }),
      ]
    }
    default:
      return []
  }
}

function titleFrom(messages: CaptureMessage[]): string | undefined {
  const user = messages.find((row) => row.role === 'user')
  if (!user) return undefined
  const collapsed = user.content.replace(/\s+/g, ' ').trim()
  return collapsed.length > 0 ? collapsed.slice(0, 120) : undefined
}

function settingsFrom(events: SpoolEvent[], conversation: string): Record<string, unknown> {
  const settings: Record<string, unknown> = { source: 'cursor-hook', conversationId: conversation }
  for (const event of events) {
    const model = asString(event.payload.model)
    const version = asString(event.payload.cursor_version)
    const transcript = asString(event.payload.transcript_path)
    const roots = stringList(event.payload.workspace_roots, 8)
    if (model && model !== 'default') settings.model = model
    if (version) settings.cursor_version = version
    if (transcript) settings.transcript_path = transcript
    if (roots) settings.workspace_roots = roots
  }
  return settings
}

/** Group spool events into one batch per conversation, in time order. */
export function batchesFromEvents(events: SpoolEvent[]): CaptureBatch[] {
  const ordered = [...events].sort((a, b) => {
    const stamp = (a.createdAt ?? '').localeCompare(b.createdAt ?? '')
    if (stamp !== 0) return stamp
    return (a.file ?? '').localeCompare(b.file ?? '')
  })
  const groups = new Map<
    string,
    { events: SpoolEvent[]; messages: CaptureMessage[]; finalize: boolean }
  >()
  for (const event of ordered) {
    const conversation = conversationId(event.payload)
    if (!conversation) continue
    const messages = messagesFromCursorEvent(event)
    const finalize = event.event === 'sessionEnd'
    if (messages.length === 0 && !finalize) continue
    const key = sessionKeyFor(conversation)
    const group = groups.get(key) ?? { events: [], messages: [], finalize: false }
    group.events.push(event)
    group.messages.push(...messages)
    group.finalize = group.finalize || finalize
    groups.set(key, group)
  }
  const batches: CaptureBatch[] = []
  for (const [sessionKey, group] of groups) {
    const seen = new Set<string>()
    const messages = group.messages.filter((row) => {
      if (seen.has(row.event_id)) return false
      seen.add(row.event_id)
      return true
    })
    const conversation = sessionKey.slice('cursor:'.length)
    const title = titleFrom(messages)
    batches.push({
      session_key: sessionKey,
      agent: CAPTURE_AGENT,
      channel: CAPTURE_CHANNEL,
      ...(title ? { title } : {}),
      settings: settingsFrom(group.events, conversation),
      ...(group.finalize ? { finalize: true } : {}),
      messages,
    })
  }
  return batches
}

export function fetchWithCa(caPath: string | undefined): typeof fetch {
  let ca: string | undefined
  if (caPath) {
    try {
      ca = fs.readFileSync(caPath, 'utf8')
    } catch {
      ca = undefined
    }
  }
  if (!ca) return globalThis.fetch
  const trusted = ca
  return (input, init) =>
    new Promise((resolve, reject) => {
      const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url
      if (!url.startsWith('https:')) {
        resolve(globalThis.fetch(input, init))
        return
      }
      const body = typeof init?.body === 'string' ? init.body : undefined
      const headers: Record<string, string> = {}
      const headerInit = init?.headers
      if (isRecord(headerInit)) {
        for (const [key, value] of Object.entries(headerInit)) {
          if (typeof value === 'string') headers[key] = value
        }
      }
      const req = https.request(
        url,
        { method: init?.method, headers, ca: trusted, timeout: 20_000 },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () => {
            const flat: Record<string, string> = {}
            for (const [key, value] of Object.entries(res.headers)) {
              if (typeof value === 'string') flat[key] = value
              else if (Array.isArray(value)) flat[key] = value.join(', ')
            }
            resolve(
              new Response(Buffer.concat(chunks), { status: res.statusCode ?? 0, headers: flat }),
            )
          })
        },
      )
      req.on('timeout', () => req.destroy(new Error('den capture timeout')))
      req.on('error', reject)
      req.end(body)
    })
}

export async function ingestBatches(
  batches: CaptureBatch[],
  sink: Partial<CaptureWriterOptions> = {},
): Promise<IngestCounts> {
  const counts: IngestCounts = {
    files: 0,
    conversations: batches.length,
    inserted: 0,
    skipped: 0,
    spooled: 0,
    failed: 0,
  }
  if (batches.length === 0) return counts
  const transport = resolveCaptureTransport(process.env)
  if (transport.kind === 'none') throw new Error(transport.reason)
  if (transport.kind === 'pg') {
    throw new Error(
      'cursor capture writes through the den; RIVETOS_CAPTURE_TRANSPORT=pg is not supported',
    )
  }
  const den = resolveDenUrl(process.env)
  const writer = createCaptureWriter({
    ...sink,
    denUrl: transport.denUrl,
    fetch: sink.fetch ?? fetchWithCa(den?.caPath),
    log: sink.log ?? ((line) => console.error(line)),
  })
  for (const batch of batches) {
    try {
      const result = await writer.write(batch)
      if ('spooled' in result) {
        if (result.spooled) counts.spooled += 1
        else {
          counts.failed += 1
          console.error(`ingest failed ${batch.session_key}: ${result.error}`)
        }
        continue
      }
      counts.inserted += result.inserted
      counts.skipped += result.skipped
    } catch (error) {
      counts.failed += 1
      console.error(
        `ingest failed ${batch.session_key}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  return counts
}

export function loadSpoolDir(dir: string): { events: SpoolEvent[]; unreadable: number } {
  let names: string[]
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith('.json'))
  } catch (error) {
    throw new Error(`spool unreadable: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    })
  }
  const events: SpoolEvent[] = []
  let unreadable = 0
  for (const name of names) {
    const file = path.join(dir, name)
    try {
      const record = readSpoolRecord(JSON.parse(fs.readFileSync(file, 'utf8')), name)
      if (record) events.push(record)
      else unreadable += 1
    } catch {
      unreadable += 1
    }
  }
  return { events, unreadable }
}

export interface PendingTool {
  line: number
  part: number
  name: string
  /** Name used to pair with a hook result. MCP hook names fold onto CallDynamicTool. */
  matchName: string
  inputKey: string
  toolArgs: unknown
}

export interface QueuedResult {
  name: string
  matchName: string
  inputKey: string
  output: string
  toolUseId?: string
  toolArgs?: unknown
}

/** Per-conversation tail of one agent transcript. */
export interface ConvState {
  transcript: string
  offset: number
  nextLine: number
  pending: PendingTool[]
  results: QueuedResult[]
}

export function emptyConvState(transcript = ''): ConvState {
  return { transcript, offset: 0, nextLine: 0, pending: [], results: [] }
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`
  }
  const encoded = JSON.stringify(value)
  return typeof encoded === 'string' ? encoded : 'null'
}

export function toolInputKey(name: string, input: unknown): string {
  return `${name}\0${stableJson(input)}`
}

function pathOf(input: Record<string, unknown>): string {
  return asString(input.path) ?? asString(input.file_path) ?? ''
}

/**
 * Pair a transcript tool_use with a postToolUse result.
 * Cursor's hook payload renames fields (`file_path` vs `path`, `MCP:echo` vs
 * CallDynamicTool) and adds hook-only keys (`cwd`, `timeout`, `description`).
 * The key keeps the fields both sides share.
 */
export function canonicalTool(name: string, input: unknown): { name: string; inputKey: string } {
  const rec = isRecord(input) ? input : {}
  if (name.startsWith('MCP:')) {
    const toolName = name.slice('MCP:'.length)
    return {
      name: 'CallDynamicTool',
      inputKey: toolInputKey('CallDynamicTool', { arguments: rec, toolName }),
    }
  }
  if (name === 'CallDynamicTool') {
    const args = isRecord(rec.arguments) ? rec.arguments : {}
    return {
      name: 'CallDynamicTool',
      inputKey: toolInputKey('CallDynamicTool', {
        arguments: args,
        toolName: asString(rec.toolName) ?? '',
      }),
    }
  }
  if (name === 'Read') return { name, inputKey: toolInputKey(name, { path: pathOf(rec) }) }
  if (name === 'Shell')
    return { name, inputKey: toolInputKey(name, { command: asString(rec.command) ?? '' }) }
  if (name === 'Grep')
    return {
      name,
      inputKey: toolInputKey(name, { path: pathOf(rec), pattern: rec.pattern ?? null }),
    }
  if (name === 'Write') return { name, inputKey: toolInputKey(name, { path: pathOf(rec) }) }
  if (name === 'StrReplace') {
    return {
      name,
      inputKey: toolInputKey(name, { old_string: rec.old_string ?? null, path: pathOf(rec) }),
    }
  }
  if (name === 'Glob') {
    return {
      name,
      inputKey: toolInputKey(name, {
        glob_pattern: rec.glob_pattern ?? null,
        target_directory: rec.target_directory ?? null,
      }),
    }
  }
  return { name, inputKey: toolInputKey(name, input) }
}

/** Complete newline-terminated lines only. A trailing partial line stays unconsumed. */
export function splitCompleteLines(buf: Buffer): { lines: string[]; consumed: number } {
  const last = buf.lastIndexOf(0x0a)
  if (last < 0) return { lines: [], consumed: 0 }
  const text = buf.subarray(0, last + 1).toString('utf8')
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return { lines, consumed: last + 1 }
}

interface TranscriptPiece {
  kind: 'text' | 'tool'
  role: 'user' | 'assistant'
  text?: string
  name?: string
  input?: unknown
}

function piecesFromContent(role: 'user' | 'assistant', content: unknown): TranscriptPiece[] {
  if (typeof content === 'string') {
    return content.length > 0 ? [{ kind: 'text', role, text: content }] : []
  }
  if (!Array.isArray(content)) return []
  const pieces: TranscriptPiece[] = []
  for (const part of content) {
    if (!isRecord(part)) continue
    if (part.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
      pieces.push({ kind: 'text', role, text: part.text })
    } else if (part.type === 'tool_use' && typeof part.name === 'string') {
      pieces.push({ kind: 'tool', role, name: part.name, input: part.input })
    }
  }
  return pieces
}

export function piecesFromTranscriptLine(raw: unknown): TranscriptPiece[] {
  if (!isRecord(raw)) return []
  const role = raw.role === 'user' || raw.role === 'assistant' ? raw.role : null
  if (!role) return []
  const message = isRecord(raw.message) ? raw.message : raw
  return piecesFromContent(role, message.content)
}

function isReadStub(output: string): boolean {
  try {
    const parsed: unknown = JSON.parse(output)
    if (!isRecord(parsed)) return false
    return typeof parsed.content_length === 'number' && typeof parsed.content !== 'string'
  } catch {
    return false
  }
}

/** Replace a Read stub (path + length) with the file slice the call asked for. */
export function enrichReadOutput(toolName: string, toolArgs: unknown, output: string): string {
  if (toolName !== 'Read' || !isReadStub(output)) return output
  if (!isRecord(toolArgs)) return output
  const filePath = asString(toolArgs.path) ?? asString(toolArgs.file_path)
  if (!filePath) return output
  let stat: fs.Stats
  try {
    stat = fs.statSync(filePath)
  } catch {
    return output
  }
  if (!stat.isFile() || stat.size > 2_000_000) return output
  const offset =
    typeof toolArgs.offset === 'number' && toolArgs.offset > 0 ? Math.floor(toolArgs.offset) : 1
  let text: string
  try {
    text = fs.readFileSync(filePath, 'utf8')
  } catch {
    return output
  }
  const lines = text.split('\n').slice(offset - 1)
  const limit =
    typeof toolArgs.limit === 'number' && toolArgs.limit > 0
      ? Math.min(Math.floor(toolArgs.limit), lines.length)
      : lines.length
  return lines.slice(0, limit).join('\n')
}

function transcriptMessage(opts: {
  conversationId: string
  file: string
  line: number
  part: number
  role: CaptureMessage['role']
  content: string
  createdAt?: string
  toolName?: string
  toolArgs?: unknown
  toolResult?: string
  toolUseId?: string
}): CaptureMessage {
  const capped = capText(opts.content)
  const metadata: Record<string, unknown> = {
    source: 'cursor-transcript',
    session_jsonl_path: opts.file,
    session_jsonl_line: opts.line,
    native_event_id: `line:${opts.line}:part:${opts.part}`,
  }
  if (capped.truncated) {
    metadata.truncated = true
    metadata.full_content_length = capped.fullLength
  }
  let toolResult: string | undefined
  if (opts.toolResult !== undefined) {
    const cappedResult = capText(opts.toolResult)
    toolResult = cappedResult.text
    if (cappedResult.truncated) {
      metadata.truncated = true
      metadata.full_tool_result_length = cappedResult.fullLength
    }
  }
  if (opts.toolUseId) metadata.tool_use_id = opts.toolUseId
  return {
    event_id: `cursor:${opts.conversationId}:line:${opts.line}:part:${opts.part}`,
    role: opts.role,
    content: capped.text,
    metadata,
    ...(opts.createdAt ? { created_at: opts.createdAt } : {}),
    ...(opts.toolName ? { tool_name: opts.toolName } : {}),
    ...(opts.toolArgs !== undefined ? { tool_args: opts.toolArgs } : {}),
    ...(toolResult !== undefined ? { tool_result: toolResult } : {}),
  }
}

function takeMatch<T extends { matchName: string; inputKey: string }>(
  queue: T[],
  matchName: string,
  inputKey: string,
): T | undefined {
  const index = queue.findIndex(
    (item) => item.matchName === matchName && item.inputKey === inputKey,
  )
  if (index < 0) return undefined
  return queue.splice(index, 1)[0]
}

function lineStamp(mtimeMs: number, line: number, lastLine: number, part: number): string {
  return new Date(mtimeMs - Math.max(0, lastLine - line) * 1000 + part).toISOString()
}

/** Ingest complete new lines. Tool calls wait for a queued result instead of emitting twice. */
export function consumeTranscript(opts: {
  conversationId: string
  file: string
  chunk: Buffer
  state: ConvState
  mtimeMs: number
}): { state: ConvState; messages: CaptureMessage[] } {
  const split = splitCompleteLines(opts.chunk)
  const state: ConvState = {
    ...opts.state,
    transcript: opts.file,
    offset: opts.state.offset + split.consumed,
    pending: [...opts.state.pending],
    results: [...opts.state.results],
  }
  const messages: CaptureMessage[] = []
  const lastLine = state.nextLine + split.lines.length - 1
  split.lines.forEach((line, index) => {
    const lineNo = state.nextLine + index
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      return
    }
    piecesFromTranscriptLine(raw).forEach((piece, part) => {
      const createdAt = lineStamp(opts.mtimeMs, lineNo, Math.max(lastLine, lineNo), part)
      if (piece.kind === 'text' && piece.text) {
        messages.push(
          transcriptMessage({
            conversationId: opts.conversationId,
            file: opts.file,
            line: lineNo,
            part,
            role: piece.role,
            content: piece.text,
            createdAt,
          }),
        )
        return
      }
      if (piece.kind !== 'tool' || !piece.name) return
      const id = canonicalTool(piece.name, piece.input)
      const matched = takeMatch(state.results, id.name, id.inputKey)
      if (!matched) {
        state.pending.push({
          line: lineNo,
          part,
          name: piece.name,
          matchName: id.name,
          inputKey: id.inputKey,
          toolArgs: piece.input,
        })
        return
      }
      messages.push(
        transcriptMessage({
          conversationId: opts.conversationId,
          file: opts.file,
          line: lineNo,
          part,
          role: 'tool',
          content: piece.name,
          createdAt,
          toolName: piece.name,
          toolArgs: piece.input,
          toolResult: enrichReadOutput(piece.name, piece.input, matched.output),
          toolUseId: matched.toolUseId,
        }),
      )
    })
  })
  state.nextLine += split.lines.length
  return { state, messages }
}

export function applyToolResult(
  state: ConvState,
  result: QueuedResult,
  conversationId: string,
): { state: ConvState; messages: CaptureMessage[] } {
  const pending = [...state.pending]
  const matched = takeMatch(pending, result.matchName, result.inputKey)
  if (!matched) {
    return { state: { ...state, pending, results: [...state.results, result] }, messages: [] }
  }
  return {
    state: { ...state, pending, results: [...state.results] },
    messages: [
      transcriptMessage({
        conversationId,
        file: state.transcript,
        line: matched.line,
        part: matched.part,
        role: 'tool',
        content: matched.name,
        toolName: matched.name,
        toolArgs: matched.toolArgs,
        toolResult: enrichReadOutput(matched.name, matched.toolArgs, result.output),
        toolUseId: result.toolUseId,
      }),
    ],
  }
}

export function flushConvState(
  state: ConvState,
  conversationId: string,
): { state: ConvState; messages: CaptureMessage[] } {
  const messages: CaptureMessage[] = []
  for (const pending of state.pending) {
    messages.push(
      transcriptMessage({
        conversationId,
        file: state.transcript,
        line: pending.line,
        part: pending.part,
        role: 'tool',
        content: pending.name,
        toolName: pending.name,
        toolArgs: pending.toolArgs,
      }),
    )
  }
  for (const result of state.results) {
    const nativeId = result.toolUseId ?? sha256(`${result.name}\0${result.output}`).slice(0, 16)
    messages.push({
      event_id: `cursor:${conversationId}:tool:${nativeId}`,
      role: 'tool',
      content: result.name,
      tool_name: result.name,
      tool_result: capText(enrichReadOutput(result.name, result.toolArgs, result.output)).text,
      metadata: { source: 'cursor-hook', tool_use_id: result.toolUseId },
    })
  }
  return { state: { ...state, pending: [], results: [] }, messages }
}

function readTranscriptChunk(
  file: string,
  offset: number,
): { chunk: Buffer; mtimeMs: number } | null {
  let stat: fs.Stats
  try {
    stat = fs.statSync(file)
  } catch {
    return null
  }
  if (!stat.isFile() || stat.size <= offset)
    return { chunk: Buffer.alloc(0), mtimeMs: stat.mtimeMs }
  const length = stat.size - offset
  const chunk = Buffer.alloc(length)
  const fd = fs.openSync(file, 'r')
  try {
    fs.readSync(fd, chunk, 0, length, offset)
  } finally {
    fs.closeSync(fd)
  }
  return { chunk, mtimeMs: stat.mtimeMs }
}

function resultFromEvent(event: SpoolEvent): QueuedResult | null {
  if (event.event !== 'postToolUse') return null
  const name = asString(event.payload.tool_name) ?? 'tool'
  const id = canonicalTool(name, event.payload.tool_input)
  return {
    name,
    matchName: id.name,
    inputKey: id.inputKey,
    output: toolOutput(event.payload.tool_output),
    toolArgs: event.payload.tool_input,
    ...(asString(event.payload.tool_use_id)
      ? { toolUseId: asString(event.payload.tool_use_id) ?? undefined }
      : {}),
  }
}

export function normalizeConvState(value: ConvState | null, transcript: string): ConvState {
  if (!value) return emptyConvState(transcript)
  const pending = Array.isArray(value.pending) ? value.pending : []
  const results = Array.isArray(value.results) ? value.results : []
  if (transcript && value.transcript && value.transcript !== transcript)
    return emptyConvState(transcript)
  return {
    transcript: transcript || value.transcript,
    offset: typeof value.offset === 'number' && value.offset >= 0 ? value.offset : 0,
    nextLine: typeof value.nextLine === 'number' && value.nextLine >= 0 ? value.nextLine : 0,
    pending,
    results,
  }
}

/**
 * Tail the transcript when the hook names one. Hook user/assistant/tool bodies
 * are not stored in that case, so a turn is not written twice. Tool results
 * still come from postToolUse.
 */
export function planCursorHook(
  event: SpoolEvent,
  prev: ConvState | null,
): { state: ConvState; messages: CaptureMessage[] } {
  const conversation = conversationId(event.payload)
  const transcript = asString(event.payload.transcript_path)
  if (!conversation) return { state: prev ?? emptyConvState(transcript ?? ''), messages: [] }
  if (!transcript)
    return { state: prev ?? emptyConvState(), messages: messagesFromCursorEvent(event) }

  let state = normalizeConvState(prev, transcript)
  const messages: CaptureMessage[] = []
  const loaded = readTranscriptChunk(transcript, state.offset)
  if (loaded && loaded.chunk.length > 0) {
    const consumed = consumeTranscript({
      conversationId: conversation,
      file: transcript,
      chunk: loaded.chunk,
      state,
      mtimeMs: loaded.mtimeMs,
    })
    state = consumed.state
    messages.push(...consumed.messages)
  }
  const result = resultFromEvent(event)
  if (result) {
    const applied = applyToolResult(state, result, conversation)
    state = applied.state
    messages.push(...applied.messages)
  }
  if (event.event === 'stop' || event.event === 'sessionEnd') {
    const flushed = flushConvState(state, conversation)
    state = flushed.state
    messages.push(...flushed.messages)
  }
  if (event.event === 'sessionEnd' || event.event === 'subagentStop') {
    messages.push(
      ...messagesFromCursorEvent({
        ...event,
        event: event.event === 'sessionEnd' ? 'sessionEnd' : 'subagentStop',
      }),
    )
  }
  return { state, messages }
}

export function discoverAgentTranscripts(
  projectsRoot: string,
): Array<{ file: string; conversationId: string }> {
  const found: Array<{ file: string; conversationId: string }> = []
  let projects: string[]
  try {
    projects = fs.readdirSync(projectsRoot)
  } catch {
    return found
  }
  for (const project of projects) {
    const dir = path.join(projectsRoot, project, 'agent-transcripts')
    let convs: string[]
    try {
      convs = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const conv of convs) {
      const file = path.join(dir, conv, `${conv}.jsonl`)
      if (fs.existsSync(file)) found.push({ file, conversationId: conv })
    }
  }
  return found
}

interface TranscriptStore {
  conversations: Record<string, ConvState>
}

function transcriptStatePath(): string {
  return (
    process.env.RIVETOS_CURSOR_TRANSCRIPT_STATE ??
    path.join(os.homedir(), '.rivetos', 'cursor-transcript-state.json')
  )
}

function readTranscriptStore(file: string): TranscriptStore {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!isRecord(parsed) || !isRecord(parsed.conversations)) return { conversations: {} }
    return { conversations: parsed.conversations as Record<string, ConvState> }
  } catch {
    return { conversations: {} }
  }
}

function writeTranscriptStore(file: string, store: TranscriptStore): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(store))
  fs.renameSync(tmp, file)
}

function batchFor(
  conversation: string,
  messages: CaptureMessage[],
  event: SpoolEvent | undefined,
  finalize: boolean,
): CaptureBatch {
  const seen = new Set<string>()
  const unique = messages.filter((row) => {
    if (seen.has(row.event_id)) return false
    seen.add(row.event_id)
    return true
  })
  const title = titleFrom(unique)
  return {
    session_key: sessionKeyFor(conversation),
    agent: CAPTURE_AGENT,
    channel: CAPTURE_CHANNEL,
    ...(title ? { title } : {}),
    ...(event
      ? { settings: settingsFrom([event], conversation) }
      : { settings: { source: 'cursor-transcript', conversationId: conversation } }),
    ...(finalize ? { finalize: true } : {}),
    messages: unique,
  }
}

function applyHouseEnv(): void {
  const file = process.env.RIVETOS_ENV_FILE ?? path.join(os.homedir(), '.rivetos', '.env')
  for (const [key, value] of Object.entries(loadEnvFile(file))) {
    if (!process.env[key]) process.env[key] = value
  }
}

function asBytes(chunk: unknown): Uint8Array {
  if (typeof chunk === 'string') return Buffer.from(chunk)
  if (chunk instanceof Uint8Array) return chunk
  return Buffer.alloc(0)
}

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = []
  for await (const chunk of process.stdin) chunks.push(asBytes(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

function printCounts(label: string, counts: IngestCounts): void {
  console.log(
    `${label} files=${counts.files} conversations=${counts.conversations} inserted=${counts.inserted} skipped=${counts.skipped} spooled=${counts.spooled} failed=${counts.failed}`,
  )
}

async function main(): Promise<void> {
  applyHouseEnv()
  const args = process.argv.slice(2)
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(USAGE)
    return
  }
  if (args[0] === '--status') {
    const transport = resolveCaptureTransport(process.env)
    console.log(`transport=${transport.kind} agent=${CAPTURE_AGENT} channel=${CAPTURE_CHANNEL}`)
    return
  }
  if (args[0] === '--hook') {
    const event = args[1] || 'unknown'
    try {
      const text = (await readStdin()).trim()
      const parsed: unknown = text ? JSON.parse(text) : {}
      const record = readSpoolRecord(
        isRecord(parsed) && isRecord(parsed.payload)
          ? parsed
          : { hook_event_name: event, ...(isRecord(parsed) ? parsed : {}) },
      )
      const spoolEvent: SpoolEvent = record ?? { event, payload: {} }
      if (!record) spoolEvent.event = event
      const conversation = conversationId(spoolEvent.payload)
      const stateFile = transcriptStatePath()
      const counts = await withFileLock(
        `${stateFile}.lock`,
        async () => {
          const store = readTranscriptStore(stateFile)
          const prev = conversation ? (store.conversations[conversation] ?? null) : null
          const next = planCursorHook(
            spoolEvent,
            normalizeConvState(prev, asString(spoolEvent.payload.transcript_path) ?? ''),
          )
          const result: IngestCounts = {
            files: 1,
            conversations: 0,
            inserted: 0,
            skipped: 0,
            spooled: 0,
            failed: 0,
          }
          if (next.messages.length > 0 && conversation) {
            const ingested = await ingestBatches([
              batchFor(conversation, next.messages, spoolEvent, spoolEvent.event === 'sessionEnd'),
            ])
            result.conversations = ingested.conversations
            result.inserted = ingested.inserted
            result.skipped = ingested.skipped
            result.spooled = ingested.spooled
            result.failed = ingested.failed
            if (ingested.failed > 0) return result
          }
          if (conversation) {
            store.conversations[conversation] = next.state
            writeTranscriptStore(stateFile, store)
          }
          return result
        },
        { waitMs: 3000 },
      )
      if (
        counts.inserted === 0 &&
        counts.skipped === 0 &&
        counts.failed === 0 &&
        counts.spooled === 0
      ) {
        console.log(`ingest skipped event=${event}`)
        return
      }
      printCounts('ingest', counts)
    } catch (error) {
      console.error(`ingest error: ${error instanceof Error ? error.message : String(error)}`)
    }
    return
  }
  if (args[0] === '--backfill') {
    const spoolFlag = args.indexOf('--spool')
    const dir =
      spoolFlag >= 0 && args[spoolFlag + 1]
        ? args[spoolFlag + 1]
        : path.join(os.homedir(), '.rivetos', 'cursor-capture', 'spool')
    const projectsFlag = args.indexOf('--projects')
    const projects =
      projectsFlag >= 0 && args[projectsFlag + 1]
        ? args[projectsFlag + 1]
        : path.join(os.homedir(), '.cursor', 'projects')
    const loaded = loadSpoolDir(dir)
    const resultsByConv = new Map<string, QueuedResult[]>()
    const finalize = new Set<string>()
    for (const event of [...loaded.events].sort((a, b) =>
      (a.createdAt ?? '').localeCompare(b.createdAt ?? ''),
    )) {
      const conversation = conversationId(event.payload)
      if (!conversation) continue
      if (event.event === 'sessionEnd') finalize.add(conversation)
      const result = resultFromEvent(event)
      if (!result) continue
      const list = resultsByConv.get(conversation) ?? []
      list.push(result)
      resultsByConv.set(conversation, list)
    }
    const transcripts = discoverAgentTranscripts(projects)
    const stateFile = transcriptStatePath()
    const counts = await withFileLock(
      `${stateFile}.lock`,
      async () => {
        const batches: CaptureBatch[] = []
        const store = readTranscriptStore(stateFile)
        for (const transcript of transcripts) {
          const results = resultsByConv.get(transcript.conversationId) ?? []
          resultsByConv.delete(transcript.conversationId)
          const state = emptyConvState(transcript.file)
          state.results = results
          const loadedFile = readTranscriptChunk(transcript.file, 0)
          const consumed = consumeTranscript({
            conversationId: transcript.conversationId,
            file: transcript.file,
            chunk: loadedFile?.chunk ?? Buffer.alloc(0),
            state,
            mtimeMs: loadedFile?.mtimeMs ?? Date.now(),
          })
          const flushed = flushConvState(consumed.state, transcript.conversationId)
          store.conversations[transcript.conversationId] = flushed.state
          const messages = [...consumed.messages, ...flushed.messages]
          if (finalize.has(transcript.conversationId)) {
            messages.push(
              ...messagesFromCursorEvent({
                event: 'sessionEnd',
                payload: { conversation_id: transcript.conversationId, reason: 'completed' },
              }),
            )
          }
          if (messages.length > 0) {
            batches.push(
              batchFor(
                transcript.conversationId,
                messages,
                undefined,
                finalize.has(transcript.conversationId),
              ),
            )
          }
        }
        for (const [conversation, results] of resultsByConv) {
          const flushed = flushConvState({ ...emptyConvState(), results }, conversation)
          if (flushed.messages.length > 0) {
            batches.push(
              batchFor(conversation, flushed.messages, undefined, finalize.has(conversation)),
            )
          }
        }
        const ingested = await ingestBatches(batches)
        if (ingested.failed === 0) writeTranscriptStore(stateFile, store)
        ingested.files = transcripts.length
        ingested.failed += loaded.unreadable
        return ingested
      },
      { waitMs: 60_000 },
    )
    printCounts('backfill', counts)
    if (counts.failed > 0) process.exitCode = 1
    return
  }
  console.log(USAGE)
  process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(`fatal: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(process.argv.includes('--hook') ? 0 : 1)
  })
}
