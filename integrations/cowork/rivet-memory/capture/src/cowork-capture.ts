/**
 * Cowork memory capture.
 *
 * Hooks are the primary path: a Desktop plugin `mcp_tool` hook calls
 * `memory_capture_event` on this host-side MCP sidecar, which works when the
 * full-VM sandbox hides the transcript. `--backfill` reads host transcripts
 * on demand (never a resident poll).
 *
 * Hook `session_id` is the CLI session id, the same value as task metadata
 * `cliSessionId` and the transcript filename `<cliSessionId>.jsonl`. The
 * task file's own `sessionId` (`local_<task-uuid>`) is a different value and
 * is never the session key. `sessionPart` prefers an explicit `cliSessionId`
 * only when that field is the CLI id.
 *
 * When a hook's `transcript_path` is a file this process can read, the hook
 * does not emit its own text. It runs the same cursor-based transcript ingest
 * as `--backfill` for that one file, so both paths store transcript ids. A
 * line that is not flushed yet is left for the next hook or for backfill.
 * Hook-only text (`cowork:<session>:hook:<hash>`) is only for a transcript
 * the host cannot read. The store rewrites those rows onto the transcript id
 * once the file becomes readable.
 *
 * Capture is always on. There is no harness allow-list and no on/off switch.
 */

import { openSync, readSync, closeSync, statSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { contentTupleHash, occurrenceIndex, type OccurrenceKey } from '@rivetos/capture-core'
import type { CaptureBatch, CaptureMessage, CaptureWriter } from '@rivetos/capture-core'

export const CAPTURE_AGENT = 'rivet-cowork'
export const CAPTURE_CHANNEL = 'cowork'
export const CAPTURE_TOOL = 'memory_capture_event'

export function splitCompleteLines(text: string): { lines: string[]; rest: string } {
  const parts = text.split('\n')
  const rest = parts.pop() ?? ''
  return { lines: parts, rest }
}

/** Bytes of `chunk` that end on a newline. The tail is not a line yet. */
export function consumeTranscriptChunk(chunk: string): { lines: string[]; consumed: number } {
  const { lines, rest } = splitCompleteLines(chunk)
  const consumed = Buffer.byteLength(chunk, 'utf8') - Buffer.byteLength(rest, 'utf8')
  return {
    lines: lines.map((line) => line.trim()).filter((line) => line !== ''),
    consumed,
  }
}

export function readFileFromOffset(
  file: string,
  offset: number,
): { lines: string[]; nextOffset: number } {
  const size = statSync(file).size
  const start = offset > size ? 0 : offset
  if (start >= size) return { lines: [], nextOffset: start }
  const length = size - start
  const buf = Buffer.alloc(length)
  const fh = openSync(file, 'r')
  try {
    readSync(fh, buf, 0, length, start)
  } finally {
    closeSync(fh)
  }
  const { lines, consumed } = consumeTranscriptChunk(buf.toString('utf8'))
  return { lines, nextOffset: start + consumed }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function sessionPart(input: { cliSessionId?: string; session_id?: string }): string {
  return input.cliSessionId || input.session_id || 'unknown'
}

export function sessionKey(part: string): string {
  return `cowork:${part}`
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => (isRecord(block) && block.type === 'text' ? (asString(block.text) ?? '') : ''))
    .filter((part) => part !== '')
    .join('\n')
}

interface ToolUse {
  id?: string
  name: string
  input: unknown
}

interface ToolResult {
  id?: string
  text: string
}

function toolUses(content: unknown): ToolUse[] {
  if (!Array.isArray(content)) return []
  const out: ToolUse[] = []
  for (const block of content) {
    if (!isRecord(block) || block.type !== 'tool_use') continue
    out.push({
      id: asString(block.id),
      name: asString(block.name) ?? 'unknown',
      input: block.input,
    })
  }
  return out
}

function toolResults(content: unknown): ToolResult[] {
  if (!Array.isArray(content)) return []
  const out: ToolResult[] = []
  for (const block of content) {
    if (!isRecord(block) || block.type !== 'tool_result') continue
    const text =
      typeof block.content === 'string'
        ? block.content
        : textOf(block.content) || asString(block.output) || ''
    out.push({ id: asString(block.tool_use_id), text })
  }
  return out
}

function occEventId(part: string, key: OccurrenceKey, seen: OccurrenceKey[]): string {
  const n = occurrenceIndex([...seen, key], key)
  seen.push(key)
  return `cowork:${part}:occ:${contentTupleHash(key)}:${String(n)}`
}

export interface HookInput {
  hook_event_name?: string
  session_id?: string
  cliSessionId?: string
  cli_session_id?: string
  prompt?: string
  cwd?: string
  uuid?: string
  message_id?: string
  prompt_id?: string
  /** Host path of `<cliSessionId>.jsonl`, when the hook template expanded it. */
  transcript_path?: string
  tool_name?: string
  tool_input?: unknown
  tool_use_id?: string
  tool_response?: unknown
  last_assistant_message?: string
  agent_id?: string
  agent_type?: string
}

function hookId(input: HookInput): string | undefined {
  return asString(input.uuid) || asString(input.message_id) || asString(input.prompt_id)
}

function toolResponseText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** One hook payload → capture messages. Empty when the event carries no text. */
export function messagesFromHook(input: HookInput): CaptureMessage[] {
  const part = sessionPart({
    cliSessionId: asString(input.cliSessionId) || asString(input.cli_session_id),
    session_id: asString(input.session_id),
  })
  const event = asString(input.hook_event_name) ?? 'unknown'
  const native = hookId(input)
  const cwd = asString(input.cwd)
  const baseMeta: Record<string, unknown> = { source: 'cowork-hook', hook: event }
  if (cwd) baseMeta.cwd = cwd

  if (event === 'UserPromptSubmit') {
    const prompt = asString(input.prompt)
    if (!prompt) return []
    const key: OccurrenceKey = { role: 'user', content: prompt }
    const eventId = native
      ? `cowork:${part}:${native}`
      : `cowork:${part}:hook:${contentTupleHash(key)}`
    return [{ event_id: eventId, role: 'user', content: prompt, metadata: baseMeta }]
  }

  if (event === 'PostToolUse' || event === 'PostToolUseFailure') {
    const name = asString(input.tool_name) ?? 'unknown'
    const toolUseId = asString(input.tool_use_id)
    const result = toolResponseText(input.tool_response)
    const key: OccurrenceKey = {
      role: 'tool',
      content: `[tool call] ${name}`,
      toolName: name,
      toolArgs: input.tool_input,
    }
    const eventId = toolUseId
      ? `cowork:${part}:tool:${toolUseId}`
      : `cowork:${part}:hook:${contentTupleHash(key)}`
    const metadata: Record<string, unknown> = { ...baseMeta }
    if (toolUseId) metadata.tool_use_id = toolUseId
    if (!result) metadata.pending_result = true
    return [
      {
        event_id: eventId,
        role: 'tool',
        content: `[tool call] ${name}`,
        tool_name: name,
        tool_args: input.tool_input,
        ...(result ? { tool_result: result } : {}),
        metadata,
      },
    ]
  }

  if (event === 'Stop' || event === 'SubagentStop') {
    const text = asString(input.last_assistant_message)
    if (!text) return []
    const key: OccurrenceKey = { role: 'assistant', content: text }
    const eventId = native
      ? `cowork:${part}:${native}`
      : `cowork:${part}:hook:${contentTupleHash(key)}`
    const metadata: Record<string, unknown> = { ...baseMeta }
    const agentId = asString(input.agent_id)
    if (agentId) metadata.agent_id = agentId
    const agentType = asString(input.agent_type)
    if (agentType) metadata.agent_type = agentType
    return [{ event_id: eventId, role: 'assistant', content: text, metadata }]
  }

  return []
}

export interface TranscriptParse {
  messages: CaptureMessage[]
  aiTitle?: string
  firstPrompt?: string
}

/**
 * Claude Code JSONL objects → capture messages. `pending` remembers a tool
 * use that has no result yet so a later chunk (or a later backfill) attaches
 * the result to the same event id.
 */
export function messagesFromTranscript(
  lines: string[],
  part: string,
  pending: Map<string, { name: string }> = new Map(),
): TranscriptParse {
  const messages: CaptureMessage[] = []
  const seen: OccurrenceKey[] = []
  let aiTitle: string | undefined
  let firstPrompt: string | undefined
  const results = new Map<string, string>()

  const parsed: Array<{ line: Record<string, unknown>; content: unknown }> = []
  for (const line of lines) {
    let value: unknown
    try {
      value = JSON.parse(line) as unknown
    } catch {
      continue
    }
    if (!isRecord(value)) continue
    if (!aiTitle && (value.type === 'ai-title' || value.type === 'summary')) {
      aiTitle = asString(value.title) || asString(value.summary)
    }
    const message = isRecord(value.message) ? value.message : value
    const content = message.content
    for (const result of toolResults(content)) {
      if (result.id) results.set(result.id, result.text)
    }
    parsed.push({ line: value, content })
  }

  for (const { line, content } of parsed) {
    const uuid = asString(line.uuid)
    const stamp = asString(line.timestamp)
    const created = stamp ? { created_at: stamp } : {}
    const prompt = textOf(content)
    const uses = toolUses(content)
    const resultsHere = toolResults(content)
    const assistant =
      line.type === 'assistant' || (isRecord(line.message) && line.message.role === 'assistant')

    if (prompt && uses.length === 0 && resultsHere.length === 0 && line.type !== 'ai-title') {
      const role = assistant ? 'assistant' : 'user'
      if (role === 'user' && !firstPrompt) firstPrompt = prompt
      const key: OccurrenceKey = { role, content: prompt }
      messages.push({
        event_id: uuid ? `cowork:${part}:${uuid}` : occEventId(part, key, seen),
        role,
        content: prompt,
        metadata: { source: 'cowork-transcript' },
        ...created,
      })
    } else if (prompt && uses.length > 0) {
      const key: OccurrenceKey = { role: 'assistant', content: prompt }
      messages.push({
        event_id: uuid ? `cowork:${part}:${uuid}` : occEventId(part, key, seen),
        role: 'assistant',
        content: prompt,
        metadata: { source: 'cowork-transcript' },
        ...created,
      })
    }

    for (const tool of uses) {
      const result = tool.id ? results.get(tool.id) : undefined
      const key: OccurrenceKey = {
        role: 'tool',
        content: `[tool call] ${tool.name}`,
        toolName: tool.name,
        toolArgs: tool.input,
      }
      const eventId = tool.id ? `cowork:${part}:tool:${tool.id}` : occEventId(part, key, seen)
      if (tool.id && !result) pending.set(tool.id, { name: tool.name })
      if (tool.id && result) pending.delete(tool.id)
      messages.push({
        event_id: eventId,
        role: 'tool',
        content: `[tool call] ${tool.name}`,
        tool_name: tool.name,
        tool_args: tool.input,
        ...(result ? { tool_result: result } : {}),
        metadata: {
          source: 'cowork-transcript',
          ...(tool.id ? { tool_use_id: tool.id } : {}),
          ...(result ? {} : { pending_result: true }),
        },
        ...created,
      })
    }

    for (const result of resultsHere) {
      if (!result.id || uses.some((tool) => tool.id === result.id)) continue
      const known = pending.get(result.id)
      pending.delete(result.id)
      const name = known?.name ?? 'tool'
      messages.push({
        event_id: `cowork:${part}:tool:${result.id}`,
        role: 'tool',
        content: `[tool call] ${name}`,
        tool_name: name,
        tool_result: result.text,
        metadata: { source: 'cowork-transcript', tool_use_id: result.id, pending_result: false },
        ...created,
      })
    }
  }

  return { messages, aiTitle, firstPrompt }
}

export function pickTitle(
  metaTitle: string | undefined,
  aiTitle: string | undefined,
  firstPrompt: string | undefined,
): string | undefined {
  return metaTitle || aiTitle || (firstPrompt ? firstPrompt.slice(0, 80) : undefined)
}

export function isoFromEpoch(ms: number): string {
  return new Date(ms).toISOString()
}

export function batchFor(opts: {
  part: string
  messages: CaptureMessage[]
  cwd?: string
  title?: string
  source: string
  createdAtMs?: number
  updatedAtMs?: number
  folders?: string[]
}): CaptureBatch | undefined {
  if (opts.messages.length === 0) return undefined
  const settings: Record<string, unknown> = {
    source: opts.source,
    cliSessionId: opts.part,
  }
  if (opts.cwd) settings.cwd = opts.cwd
  if (opts.folders && opts.folders.length > 0) settings.folders = opts.folders
  return {
    session_key: sessionKey(opts.part),
    agent: CAPTURE_AGENT,
    channel: CAPTURE_CHANNEL,
    ...(opts.title ? { title: opts.title } : {}),
    settings,
    ...(opts.createdAtMs !== undefined ? { created_at: isoFromEpoch(opts.createdAtMs) } : {}),
    ...(opts.updatedAtMs !== undefined ? { updated_at: isoFromEpoch(opts.updatedAtMs) } : {}),
    messages: opts.messages,
  }
}

export interface CoworkTaskFile {
  cliSessionId: string
  title?: string
  cwd?: string
  /** Repos the person attached. Empty when the task has none. */
  folders?: string[]
  createdAtMs?: number
  updatedAtMs?: number
  archived?: boolean
  transcriptPath?: string
}

const META_RE = /^local_.+\.json$/

function sameDir(a: string, b: string): boolean {
  return a.replace(/\\/g, '/').replace(/\/+$/, '') === b.replace(/\\/g, '/').replace(/\/+$/, '')
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value
    .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    .map((item) => item.trim())
  return out.length > 0 ? out : undefined
}

/**
 * Task directories to try, in order. Older builds use `local_<task>` next to
 * the metadata file. Desktop 2.19675.1 uses the first 8 hex of the task uuid
 * (no `local_` prefix); the metadata `cwd` is `<that dir>/outputs`.
 */
export function taskDirectoryCandidates(metaFile: string, cwd?: string): string[] {
  const dir = dirname(metaFile)
  const base = basename(metaFile, '.json')
  const out: string[] = []
  const push = (candidate: string): void => {
    if (out.some((item) => sameDir(item, candidate))) return
    out.push(candidate)
  }
  push(join(dir, base))
  if (cwd && cwd.trim() !== '') {
    const parent = dirname(cwd.trim())
    if (sameDir(dirname(parent), dir)) push(parent)
  }
  const uuid = base.startsWith('local_') ? base.slice('local_'.length) : ''
  if (uuid.length >= 8) push(join(dir, uuid.slice(0, 8)))
  return out
}

/** Newest `<cliSessionId>.jsonl` under `projects/`. Does not rebuild the slug. */
function findTranscriptFile(taskDir: string, id: string): string | undefined {
  const projects = join(taskDir, '.claude', 'projects')
  let best: { path: string; mtime: number } | undefined
  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (name.includes('..')) continue
      const full = join(dir, name)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) walk(full, depth + 1)
      else if (st.isFile() && name === `${id}.jsonl` && (!best || st.mtimeMs >= best.mtime)) {
        best = { path: full, mtime: st.mtimeMs }
      }
    }
  }
  walk(projects, 0)
  return best?.path
}

function transcriptForMeta(metaFile: string, id: string, cwd?: string): string | undefined {
  for (const taskDir of taskDirectoryCandidates(metaFile, cwd)) {
    const found = findTranscriptFile(taskDir, id)
    if (found) return found
  }
  return undefined
}

function isReadableFile(file: string): boolean {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

function epochMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const asNum = Number(value)
    if (Number.isFinite(asNum) && asNum > 1_000_000_000) return asNum
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/** Host metadata + sibling transcript. Does not import the den. */
export function discoverTasks(roots: string[]): CoworkTaskFile[] {
  const files: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (name.startsWith('.')) continue
      const full = join(dir, name)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) walk(full, depth + 1)
      else if (META_RE.test(name)) files.push(full)
    }
  }
  for (const root of roots) walk(root, 0)
  const byId = new Map<string, CoworkTaskFile>()
  for (const file of files) {
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    } catch {
      continue
    }
    if (!isRecord(parsed)) continue
    const id = asString(parsed.cliSessionId)
    if (!id || id.includes('/') || id.includes('..') || id.includes('\\')) continue
    // Never key on the task file's sessionId (`local_<uuid>`). cliSessionId is the CLI id.
    const cwd = asString(parsed.cwd)
    const folders = stringList(parsed.userSelectedFolders)
    const row: CoworkTaskFile = {
      cliSessionId: id,
      title: asString(parsed.title),
      cwd,
      ...(folders ? { folders } : {}),
      createdAtMs: epochMs(parsed.createdAt) ?? epochMs(parsed.created_at),
      updatedAtMs:
        epochMs(parsed.lastActivityAt) ?? epochMs(parsed.updatedAt) ?? epochMs(parsed.createdAt),
      archived: parsed.archived === true || parsed.isArchived === true,
      transcriptPath: transcriptForMeta(file, id, cwd),
    }
    const prev = byId.get(id)
    if (!prev || (row.updatedAtMs ?? 0) >= (prev.updatedAtMs ?? 0)) byId.set(id, row)
  }
  return [...byId.values()]
}

export interface BackfillState {
  offsets: Record<string, number>
  pending: Record<string, { name: string; session: string }>
}

export function emptyState(): BackfillState {
  return { offsets: {}, pending: {} }
}

export function defaultStatePath(home = homedir()): string {
  return join(home, '.rivetos', 'cowork-capture-state.json')
}

/** New complete lines of one transcript, advancing the byte cursor. */
export function backfillTranscript(
  task: CoworkTaskFile,
  state: BackfillState,
): CaptureBatch | undefined {
  if (!task.transcriptPath) return undefined
  const offset = state.offsets[task.transcriptPath] ?? 0
  const { lines, nextOffset } = readFileFromOffset(task.transcriptPath, offset)
  state.offsets[task.transcriptPath] = nextOffset
  const pending = new Map<string, { name: string }>()
  for (const [id, row] of Object.entries(state.pending)) {
    if (row.session === task.cliSessionId) pending.set(id, { name: row.name })
  }
  const parsed = messagesFromTranscript(lines, task.cliSessionId, pending)
  for (const id of Object.keys(state.pending)) {
    if (state.pending[id]?.session === task.cliSessionId) delete state.pending[id]
  }
  for (const [id, row] of pending) {
    state.pending[id] = { name: row.name, session: task.cliSessionId }
  }
  return batchFor({
    part: task.cliSessionId,
    messages: parsed.messages,
    cwd: task.cwd,
    folders: task.folders,
    title: pickTitle(task.title, parsed.aiTitle, parsed.firstPrompt),
    source: 'cowork-transcript',
    createdAtMs: task.createdAtMs,
    updatedAtMs: task.updatedAtMs,
  })
}

/**
 * Metadata for this CLI session, walking up from the transcript. The task
 * file sits next to the task directory, not inside it. Ignores `sessionId`.
 */
function metaForTranscript(transcriptPath: string, cliSessionId: string): CoworkTaskFile | undefined {
  let dir = dirname(transcriptPath)
  for (let depth = 0; depth < 8; depth++) {
    let names: string[] = []
    try {
      names = readdirSync(dir)
    } catch {
      names = []
    }
    for (const name of names) {
      if (!META_RE.test(name)) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(readFileSync(join(dir, name), 'utf8')) as unknown
      } catch {
        continue
      }
      if (!isRecord(parsed) || asString(parsed.cliSessionId) !== cliSessionId) continue
      const cwd = asString(parsed.cwd)
      const folders = stringList(parsed.userSelectedFolders)
      return {
        cliSessionId,
        title: asString(parsed.title),
        cwd,
        ...(folders ? { folders } : {}),
        createdAtMs: epochMs(parsed.createdAt) ?? epochMs(parsed.created_at),
        updatedAtMs:
          epochMs(parsed.lastActivityAt) ?? epochMs(parsed.updatedAt) ?? epochMs(parsed.createdAt),
        archived: parsed.archived === true || parsed.isArchived === true,
        transcriptPath,
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/**
 * Readable transcript: ingest that file and do not also emit hook text.
 * Unreadable (full-VM): the hook payload is the only copy.
 */
export function captureFromHook(input: HookInput, state: BackfillState): CaptureBatch | undefined {
  const transcriptPath = asString(input.transcript_path)
  if (transcriptPath && isReadableFile(transcriptPath)) {
    const part = sessionPart({
      cliSessionId: asString(input.cliSessionId) || asString(input.cli_session_id),
      session_id: asString(input.session_id),
    })
    const meta = metaForTranscript(transcriptPath, part)
    return backfillTranscript(
      {
        cliSessionId: part,
        transcriptPath,
        title: meta?.title,
        cwd: meta?.cwd,
        folders: meta?.folders,
        createdAtMs: meta?.createdAtMs,
        updatedAtMs: meta?.updatedAtMs,
        archived: meta?.archived,
      },
      state,
    )
  }
  return hookBatch(input)
}

/** Post, or keep the batch. `{ spooled: true }` is not a drop. 4xx still throws. */
export async function deliverBatch(
  batch: CaptureBatch | undefined,
  writer: Pick<CaptureWriter, 'write'>,
): Promise<{ inserted: number; skipped: number; spooled: boolean }> {
  if (!batch) return { inserted: 0, skipped: 0, spooled: false }
  const result = await writer.write(batch)
  if ('inserted' in result) return { inserted: result.inserted, skipped: result.skipped, spooled: false }
  if ('error' in result) throw new Error(result.error)
  return { inserted: 0, skipped: 0, spooled: true }
}

export function encodeFrame(payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  return Buffer.concat([
    Buffer.from(`Content-Length: ${String(body.length)}\r\n\r\n`, 'utf8'),
    body,
  ])
}

export function pushFrames(buf: Buffer, chunk: Buffer): { buf: Buffer; messages: unknown[] } {
  let rest = Buffer.concat([buf, chunk])
  const messages: unknown[] = []
  while (rest.length > 0) {
    const headerEnd = rest.indexOf('\r\n\r\n')
    if (headerEnd < 0) break
    const header = rest.subarray(0, headerEnd).toString('utf8')
    const match = /content-length:\s*(\d+)/i.exec(header)
    if (!match) {
      rest = rest.subarray(headerEnd + 4)
      continue
    }
    const length = Number(match[1])
    const start = headerEnd + 4
    if (rest.length < start + length) break
    const body = rest.subarray(start, start + length).toString('utf8')
    rest = rest.subarray(start + length)
    try {
      messages.push(JSON.parse(body) as unknown)
    } catch {
      /* skip a bad frame */
    }
  }
  return { buf: rest, messages }
}

export interface McpDeps {
  onCapture(input: HookInput): Promise<{ inserted: number; skipped: number }>
}

/** One JSON-RPC message. Undefined means no response (a notification). */
export async function handleMcp(
  message: unknown,
  deps: McpDeps,
): Promise<Record<string, unknown> | undefined> {
  if (!isRecord(message) || message.jsonrpc !== '2.0') return undefined
  const id = message.id
  const respond = (result: unknown): Record<string, unknown> => ({ jsonrpc: '2.0', id, result })
  const fail = (code: number, errorMessage: string): Record<string, unknown> => ({
    jsonrpc: '2.0',
    id,
    error: { code, message: errorMessage },
  })
  if (id === undefined) return undefined
  const method = asString(message.method)
  if (method === 'initialize') {
    return respond({
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'rivet-cowork-capture', version: '0.1.0' },
    })
  }
  if (method === 'ping') return respond({})
  if (method === 'tools/list') {
    return respond({
      tools: [
        {
          name: CAPTURE_TOOL,
          description: 'Record one Cowork hook event into RivetOS memory. Capture is always on.',
          inputSchema: {
            type: 'object',
            properties: {
              hook_event_name: { type: 'string' },
              session_id: { type: 'string' },
              cliSessionId: { type: 'string' },
              prompt: { type: 'string' },
              cwd: { type: 'string' },
              transcript_path: { type: 'string' },
              uuid: { type: 'string' },
              tool_name: { type: 'string' },
              tool_use_id: { type: 'string' },
              tool_input: {},
              tool_response: {},
              last_assistant_message: { type: 'string' },
            },
          },
        },
      ],
    })
  }
  if (method === 'tools/call') {
    const params = isRecord(message.params) ? message.params : {}
    if (asString(params.name) !== CAPTURE_TOOL) return fail(-32602, 'unknown tool')
    const args = isRecord(params.arguments) ? (params.arguments as HookInput) : {}
    try {
      const counts = await deps.onCapture(args)
      return respond({
        content: [
          {
            type: 'text',
            text: `inserted ${String(counts.inserted)} skipped ${String(counts.skipped)}`,
          },
        ],
      })
    } catch (error) {
      return fail(-32000, error instanceof Error ? error.message : String(error))
    }
  }
  return fail(-32601, 'method not found')
}

export function hookBatch(input: HookInput): CaptureBatch | undefined {
  const part = sessionPart({
    cliSessionId: asString(input.cliSessionId) || asString(input.cli_session_id),
    session_id: asString(input.session_id),
  })
  return batchFor({
    part,
    messages: messagesFromHook(input),
    cwd: asString(input.cwd),
    title: asString(input.prompt)?.slice(0, 80),
    source: 'cowork-hook',
  })
}
