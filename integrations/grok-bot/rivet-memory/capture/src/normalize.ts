import {
  capForStorage,
  eventIdFromContent,
  isRecord,
  occurrenceIndex,
  type CaptureMessage,
  type CaptureRole,
  type OccurrenceKey,
} from '@rivetos/capture-core'
import { classifyHidden, extractAgentMessage, systemMarker } from './hidden.js'
import {
  CAPTURE_CHANNEL,
  STORAGE_LIMIT,
  type HiddenKind,
  type IngestRow,
  type NormalizeOptions,
  type NormalizeResult,
  type NormalizeStats,
} from './types.js'
import { partText, recordParts, recordRole, toolResultBody } from './parse.js'
import { addMs, extractTimestampTag } from './timestamps.js'
import { extractUserText } from './wrappers.js'

const ROLE_MAP: Partial<Record<string, CaptureRole>> = {
  user: 'user',
  human: 'user',
  assistant: 'assistant',
  model: 'assistant',
  bot: 'assistant',
  tool: 'tool',
  system: 'system',
}

export function normalizeRecords(records: unknown[], opts: NormalizeOptions): NormalizeResult {
  const start = opts.startPosition ?? 0
  let lastKnown: string | undefined = opts.lastKnownTime
  let lastTsPos = lastKnown ? start - 1 : undefined
  const messages: CaptureMessage[] = []
  const seenSystem = new Set<string>()
  const occKeys: OccurrenceKey[] = []
  let dropped = 0
  let systemEvents = 0
  let truncated = 0

  for (let i = 0; i < records.length; i++) {
    const position = start + i
    const rec = records[i]
    const rawRole = recordRole(rec)
    const role = ROLE_MAP[rawRole] ?? (rawRole ? undefined : 'assistant')
    const parts = recordParts(rec)
    const rawText = parts.map(partText).filter(Boolean).join('\n')
    const stamped = extractTimestampTag(rawText)
    if (stamped) {
      lastKnown = stamped
      lastTsPos = position
    }
    const createdAt = inheritTime(lastKnown, lastTsPos, position)

    if (role === 'tool') {
      const emitted = emitToolParts(parts, {
        opts,
        position,
        createdAt,
        occKeys,
      })
      truncated += emitted.truncated
      messages.push(...emitted.rows)
      continue
    }

    if (role === 'assistant' || role === 'system') {
      const emitted = emitAssistantParts(parts, {
        opts,
        position,
        createdAt,
        occKeys,
        role: role === 'system' ? 'assistant' : 'assistant',
      })
      truncated += emitted.truncated
      if (emitted.rows.length === 0) dropped += 1
      messages.push(...emitted.rows)
      continue
    }

    if (role !== 'user') {
      dropped += 1
      continue
    }

    const kind = classifyHidden(rawText)
    const userText = extractUserText(rawText)
    if (userText) {
      const row = makeMessage({
        opts,
        role: 'user',
        content: userText,
        position,
        createdAt,
        occKeys,
      })
      if (row.metadata?.truncated) truncated += 1
      messages.push(row)
      continue
    }

    if (kind === 'agent_message') {
      const agent = extractAgentMessage(rawText)
      const content = agent?.text ?? systemMarker('agent_message')
      const dedupeKey = `agent_message\0${content}`
      if (seenSystem.has(dedupeKey)) {
        dropped += 1
        continue
      }
      seenSystem.add(dedupeKey)
      const row = makeMessage({
        opts,
        role: 'system',
        content,
        position,
        createdAt,
        occKeys,
        extra: {
          kind: 'agent_message',
          from_agent: agent?.fromAgent,
          from_agent_id: agent?.fromAgentId,
        },
      })
      messages.push(row)
      systemEvents += 1
      continue
    }

    if (kind) {
      const extra = hiddenExtra(kind, rawText)
      const content = systemMarker(kind, extra)
      const dedupeKey = `${kind}\0${content}`
      if (seenSystem.has(dedupeKey)) {
        dropped += 1
        continue
      }
      seenSystem.add(dedupeKey)
      const row = makeMessage({
        opts,
        role: 'system',
        content,
        position,
        createdAt,
        occKeys,
        extra: { kind },
      })
      messages.push(row)
      systemEvents += 1
      continue
    }

    dropped += 1
  }

  const stats: NormalizeStats = {
    in: records.length,
    out: messages.length,
    dropped,
    systemEvents,
    user: countRole(messages, 'user'),
    assistant: countRole(messages, 'assistant'),
    tool: countRole(messages, 'tool'),
    system: countRole(messages, 'system'),
    truncated,
    timeKnown: Boolean(lastKnown),
    lastKnownTime: lastKnown,
  }
  return { messages, stats, lastKnownTime: lastKnown, timeKnown: Boolean(lastKnown) }
}

function inheritTime(
  lastKnown: string | undefined,
  lastTsPos: number | undefined,
  position: number,
): string | undefined {
  if (!lastKnown) return undefined
  const basePos = lastTsPos ?? position
  return addMs(lastKnown, Math.max(0, position - basePos))
}

function emitAssistantParts(
  parts: unknown[],
  ctx: {
    opts: NormalizeOptions
    position: number
    createdAt?: string
    occKeys: OccurrenceKey[]
    role: CaptureRole
  },
): { rows: CaptureMessage[]; truncated: number } {
  const rows: CaptureMessage[] = []
  let truncated = 0
  const texts: string[] = []
  const tools: Array<{ name: string; input: unknown; id?: string }> = []
  for (const part of parts) {
    if (!isRecord(part)) {
      const t = partText(part)
      if (t) texts.push(t)
      continue
    }
    const t = part.type
    if (t === 'tool_use' || t === 'tool_call' || t === 'function_call') {
      const name =
        (typeof part.name === 'string' && part.name) ||
        (typeof part.toolName === 'string' && part.toolName) ||
        'tool'
      const input = 'input' in part ? part.input : (part.arguments ?? {})
      tools.push({
        name,
        input,
        id: typeof part.id === 'string' ? part.id : undefined,
      })
      continue
    }
    if (t === 'tool_result') {
      const body = toolResultBody(part)
      const name = typeof part.name === 'string' ? part.name : undefined
      const row = makeMessage({
        opts: ctx.opts,
        role: 'tool',
        content: '',
        toolName: name,
        toolResult: body,
        position: ctx.position,
        createdAt: ctx.createdAt,
        occKeys: ctx.occKeys,
      })
      if (row.metadata?.truncated) truncated += 1
      rows.push(row)
      continue
    }
    const text = partText(part)
    if (text) texts.push(text)
  }
  const content = texts.join('\n').trim()
  if (content) {
    const row = makeMessage({
      opts: ctx.opts,
      role: 'assistant',
      content,
      position: ctx.position,
      createdAt: ctx.createdAt,
      occKeys: ctx.occKeys,
    })
    if (row.metadata?.truncated) truncated += 1
    rows.push(row)
  }
  for (const tool of tools) {
    const row = makeMessage({
      opts: ctx.opts,
      role: 'assistant',
      content: '',
      toolName: tool.name,
      toolArgs: tool.input,
      position: ctx.position,
      createdAt: ctx.createdAt,
      occKeys: ctx.occKeys,
      extra: tool.id ? { tool_id: tool.id } : undefined,
    })
    rows.push(row)
  }
  return { rows, truncated }
}

function emitToolParts(
  parts: unknown[],
  ctx: {
    opts: NormalizeOptions
    position: number
    createdAt?: string
    occKeys: OccurrenceKey[]
  },
): { rows: CaptureMessage[]; truncated: number } {
  const rows: CaptureMessage[] = []
  let truncated = 0
  let saw = false
  for (const part of parts) {
    if (isRecord(part) && part.type === 'tool_result') {
      saw = true
      const body = toolResultBody(part)
      const name = typeof part.name === 'string' ? part.name : undefined
      const row = makeMessage({
        opts: ctx.opts,
        role: 'tool',
        content: '',
        toolName: name,
        toolResult: body,
        position: ctx.position,
        createdAt: ctx.createdAt,
        occKeys: ctx.occKeys,
      })
      if (row.metadata?.truncated) truncated += 1
      rows.push(row)
    }
  }
  if (!saw) {
    const body = parts.map((p) => (isRecord(p) ? toolResultBody(p) : partText(p))).join('\n')
    const row = makeMessage({
      opts: ctx.opts,
      role: 'tool',
      content: '',
      toolResult: body,
      position: ctx.position,
      createdAt: ctx.createdAt,
      occKeys: ctx.occKeys,
    })
    if (row.metadata?.truncated) truncated += 1
    rows.push(row)
  }
  return { rows, truncated }
}

function makeMessage(args: {
  opts: NormalizeOptions
  role: CaptureRole
  content: string
  position: number
  createdAt?: string
  occKeys: OccurrenceKey[]
  toolName?: string
  toolArgs?: unknown
  toolResult?: string
  extra?: Record<string, unknown>
}): CaptureMessage {
  const metadata: Record<string, unknown> = {
    channel: args.opts.channel ?? CAPTURE_CHANNEL,
    source: args.opts.format === 'page' ? 'grokbot-readtranscript' : 'grokbot-transcript',
    position: args.position,
    ordinal: args.position,
  }
  if (args.opts.agentId) metadata.agent_id = args.opts.agentId
  if (args.opts.persona) metadata.persona = args.opts.persona
  if (args.extra) Object.assign(metadata, args.extra)

  let content = args.content
  if (content) {
    const cap = capForStorage(content, { limit: STORAGE_LIMIT })
    content = cap.text
    if (cap.truncated) {
      metadata.truncated = true
      metadata.full_content_length = cap.fullLength
    }
  }

  let toolResult = args.toolResult
  if (toolResult !== undefined) {
    const cap = capForStorage(toolResult, { limit: STORAGE_LIMIT })
    toolResult = cap.text
    if (cap.truncated) {
      metadata.truncated = true
      metadata.full_tool_result_length = cap.fullLength
    }
  }

  const occKey: OccurrenceKey = {
    role: args.role,
    content: content || toolResult || args.toolName || '',
    toolName: args.toolName,
    toolArgs: args.toolArgs,
  }
  const occurrence = occurrenceIndex([...args.occKeys, occKey], occKey)
  args.occKeys.push(occKey)

  const event_id = eventIdFromContent({
    sessionKey: args.opts.sessionKey,
    role: args.role,
    content: content || toolResult || '',
    toolName: args.toolName,
    toolArgs: args.toolArgs,
    occurrence,
  })

  const msg: CaptureMessage = {
    event_id,
    role: args.role,
    content,
    metadata,
  }
  if (args.toolName) msg.tool_name = args.toolName
  if (args.toolArgs !== undefined) msg.tool_args = args.toolArgs
  if (toolResult !== undefined) msg.tool_result = toolResult
  if (args.createdAt) msg.created_at = args.createdAt
  return msg
}

function hiddenExtra(kind: HiddenKind, raw: string): string | undefined {
  if (kind === 'routine') {
    const m = /\[routine\]\s*"([^"]+)"/i.exec(raw)
    return m?.[1]
  }
  if (kind === 'background_task') {
    const m = /Background task "([^"]+)"/i.exec(raw)
    return m?.[1]
  }
  if (kind === 'event') {
    const m = /\[event\][^\n]*\n(?:[^\n]*\n)?-\s*([^\n]+)/i.exec(raw)
    return m?.[1]?.trim()
  }
  if (kind === 'profile_update') {
    const m = /Current name:\s*([^\n]+)/i.exec(raw)
    return m?.[1]?.trim()
  }
  return undefined
}

function countRole(messages: CaptureMessage[], role: CaptureRole): number {
  return messages.filter((m) => m.role === role).length
}

export function toIngestRows(messages: CaptureMessage[]): IngestRow[] {
  return messages.map((m) => {
    const row: IngestRow = {
      role: m.role,
      content: m.role === 'tool' ? (m.tool_result ?? m.content) : m.content,
      metadata: m.metadata,
    }
    if (m.created_at) row.createdAt = m.created_at
    if (m.tool_name) {
      row.toolCalls = [{ name: m.tool_name, input: m.tool_args }]
    }
    return row
  })
}
