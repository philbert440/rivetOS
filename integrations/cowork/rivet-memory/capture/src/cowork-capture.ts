/**
 * Cowork memory capture.
 *
 * Hooks are the primary path: a Desktop plugin `mcp_tool` hook calls
 * `memory_capture_event` on this host-side MCP sidecar, which works when the
 * full-VM sandbox hides the transcript. `--backfill` reads host transcripts
 * on demand (never a resident poll). Event ids match across the two paths
 * when the hook carries a uuid, message id, or tool_use_id.
 *
 * A hook that has none of those uses `cowork:<session>:hook:<hash>`. That
 * row does not dedupe with a later occurrence-hash transcript row. Whether
 * the hook payload carries `cliSessionId` is unverified: the session key is
 * `cliSessionId`, else `session_id`, else `unknown`.
 *
 * Capture is always on. There is no harness allow-list and no on/off switch.
 */

import { openSync, readSync, closeSync, statSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import {
  contentTupleHash,
  occurrenceIndex,
  type OccurrenceKey,
} from '@rivetos/capture-core'
import type { CaptureBatch, CaptureMessage } from '@rivetos/capture-core'

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

export function sessionPart(input: {
  cliSessionId?: string
  session_id?: string
}): string {
  return input.cliSessionId || input.session_id || 'unknown'
}

export function sessionKey(part: string): string {
  return `cowork:${part}`
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => (isRecord(block) && block.type === 'text' ? asString(block.text) ?? '' : ''))
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
}): CaptureBatch | undefined {
  if (opts.messages.length === 0) return undefined
  const settings: Record<string, unknown> = {
    source: opts.source,
    cliSessionId: opts.part,
  }
  if (opts.cwd) settings.cwd = opts.cwd
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
  createdAtMs?: number
  updatedAtMs?: number
  transcriptPath?: string
}

const META_RE = /^local_.+\.json$/

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
    const taskDir = join(dirname(file), basename(file, '.json'))
    let transcriptPath: string | undefined
    const projects = join(taskDir, '.claude', 'projects')
    try {
      for (const slug of readdirSync(projects)) {
        if (slug.includes('..')) continue
        const candidate = join(projects, slug, `${id}.jsonl`)
        try {
          if (statSync(candidate).isFile()) transcriptPath = candidate
        } catch {
          /* miss */
        }
      }
    } catch {
      /* no transcript */
    }
    const row: CoworkTaskFile = {
      cliSessionId: id,
      title: asString(parsed.title),
      cwd: asString(parsed.cwd),
      createdAtMs: epochMs(parsed.createdAt),
      updatedAtMs: epochMs(parsed.lastActivityAt) ?? epochMs(parsed.createdAt),
      transcriptPath,
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
    title: pickTitle(task.title, parsed.aiTitle, parsed.firstPrompt),
    source: 'cowork-transcript',
    createdAtMs: task.createdAtMs,
    updatedAtMs: task.updatedAtMs,
  })
}

export function encodeFrame(payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  return Buffer.concat([Buffer.from(`Content-Length: ${String(body.length)}\r\n\r\n`, 'utf8'), body])
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
          description:
            'Record one Cowork hook event into RivetOS memory. Capture is always on.',
          inputSchema: {
            type: 'object',
            properties: {
              hook_event_name: { type: 'string' },
              session_id: { type: 'string' },
              cliSessionId: { type: 'string' },
              prompt: { type: 'string' },
              cwd: { type: 'string' },
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
        content: [{ type: 'text', text: `inserted ${String(counts.inserted)} skipped ${String(counts.skipped)}` }],
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
