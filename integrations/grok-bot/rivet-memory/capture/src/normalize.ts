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
  ORDINAL_STRIDE,
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

export interface TimeClock {
  last?: string
}

/**
 * Skip a concatenated replay block: a run of ≥2 consecutive records whose
 * JSON matches an earlier consecutive run. Isolated same-time same-text
 * user turns (minute precision) are kept — those are genuine repeats.
 */
export function replaySkipIndices(records: unknown[]): Set<number> {
  const hashes = records.map((r) => {
    try {
      return JSON.stringify(r)
    } catch {
      return String(r)
    }
  })
  const skip = new Set<number>()
  let j = 0
  while (j < hashes.length) {
    let matchedAt = -1
    for (let i = 0; i < j; i++) {
      if (hashes[i] === hashes[j] && j + 1 < hashes.length && hashes[i + 1] === hashes[j + 1]) {
        matchedAt = i
        break
      }
    }
    if (matchedAt >= 0) {
      while (j < hashes.length && matchedAt < hashes.length && hashes[j] === hashes[matchedAt]) {
        skip.add(j)
        j += 1
        matchedAt += 1
      }
    } else {
      j += 1
    }
  }
  return skip
}

export function clampCreatedAt(clock: TimeClock, candidate?: string): string | undefined {
  if (!candidate) return undefined
  const t = Date.parse(candidate)
  if (Number.isNaN(t)) return candidate
  const min = clock.last !== undefined ? Date.parse(clock.last) + 1 : Number.NEGATIVE_INFINITY
  if (t >= min) {
    clock.last = candidate
    return candidate
  }
  const iso = new Date(min).toISOString()
  clock.last = iso
  return iso
}

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
  let lastStampedUser: { time: string; position: number } | undefined = opts.lastKnownTime
    ? { time: opts.lastKnownTime, position: start - 1 }
    : undefined
  const messages: CaptureMessage[] = []
  const seenSystem = new Set<string>()
  const occKeys: OccurrenceKey[] = []
  const subByPos = new Map<number, number>()
  const clock: TimeClock = {}
  const replaySkips = replaySkipIndices(records)
  let dropped = 0
  let systemEvents = 0
  let truncated = 0

  for (let i = 0; i < records.length; i++) {
    if (replaySkips.has(i)) {
      dropped += 1
      continue
    }
    const position = opts.positions?.[i] ?? start + i
    const rec = records[i]
    const rawRole = recordRole(rec)
    const role = ROLE_MAP[rawRole] ?? (rawRole ? undefined : 'assistant')
    const parts = recordParts(rec)
    const rawText = parts.map(partText).filter(Boolean).join('\n')
    const storedTime = opts.useStoredCreatedAt ? recordStoredTime(rec) : undefined
    const userLike = role === 'user'
    const stamped = userLike ? extractTimestampTag(rawText) : undefined
    const kind = userLike ? classifyHidden(rawText) : undefined
    const userText = userLike ? extractUserText(rawText) : ''

    if (userLike) {
      if (stamped) {
        lastStampedUser = { time: stamped, position }
      } else if (userText) {
        // Later real user turn with no stamp: stop inheriting for the rest of the run.
        lastStampedUser = undefined
      }
    }

    const createdAt = createdAtFor({
      role: role ?? 'assistant',
      userText: Boolean(userText),
      stamped,
      storedTime,
      position,
      lastStampedUser,
      useStored: Boolean(opts.useStoredCreatedAt),
    })

    if (role === 'tool') {
      const emitted = emitToolParts(parts, {
        opts,
        position,
        createdAt,
        occKeys,
        subByPos,
        clock,
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
        subByPos,
        clock,
        role: role === 'system' ? 'system' : 'assistant',
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

    // Real user prose wins. If the leftover still classifies as a hidden
    // body (unsanded start-of-line [event], reaction, …), fall through and
    // store it as a system event so we don't keep the injected text as user.
    const leftoverHidden = userText ? classifyHidden(userText) : undefined
    if (userText && !leftoverHidden) {
      const row = makeMessage({
        opts,
        role: 'user',
        content: userText,
        position,
        createdAt,
        occKeys,
        subByPos,
        clock,
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
        subByPos,
        extra: {
          kind: 'agent_message',
          from_agent: agent?.fromAgent,
          from_agent_id: agent?.fromAgentId,
        },
        clock,
      })
      messages.push(row)
      systemEvents += 1
      continue
    }

    if (kind) {
      const extra = hiddenExtra(kind, rawText)
      const content = systemMarker(kind, extra)
      // Routine / background fires stay distinct by position so overlapping
      // pages merge to the same rows instead of collapsing by content.
      const distinctByPosition = kind === 'routine' || kind === 'background_task'
      const dedupeKey = distinctByPosition
        ? `${kind}\0${String(position)}\0${content}`
        : `${kind}\0${content}`
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
        subByPos,
        extra: { kind },
        clock,
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
    timeKnown: Boolean(lastStampedUser),
    lastKnownTime: lastStampedUser?.time,
  }
  return {
    messages,
    stats,
    lastKnownTime: lastStampedUser?.time,
    timeKnown: Boolean(lastStampedUser),
  }
}

function createdAtFor(args: {
  role: string
  userText: boolean
  stamped?: string
  storedTime?: string
  position: number
  lastStampedUser?: { time: string; position: number }
  useStored: boolean
}): string | undefined {
  if (args.role === 'user') {
    if (args.stamped) return args.stamped
    if (args.userText) return args.useStored ? args.storedTime : undefined
    // Hidden user-role turns inherit from the current stamped user when present.
    if (args.lastStampedUser) {
      return addMs(
        args.lastStampedUser.time,
        Math.max(0, args.position - args.lastStampedUser.position),
      )
    }
    return args.useStored ? args.storedTime : undefined
  }
  if (args.lastStampedUser) {
    return addMs(
      args.lastStampedUser.time,
      Math.max(0, args.position - args.lastStampedUser.position),
    )
  }
  return args.useStored ? args.storedTime : undefined
}

function recordStoredTime(rec: unknown): string | undefined {
  if (!isRecord(rec)) return undefined
  const raw = rec.created_at ?? rec.createdAt
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) return raw.toISOString()
  if (typeof raw === 'string' && raw.trim()) {
    const dt = new Date(raw)
    if (!Number.isNaN(dt.getTime())) return dt.toISOString()
  }
  return undefined
}

function emitAssistantParts(
  parts: unknown[],
  ctx: {
    opts: NormalizeOptions
    position: number
    createdAt?: string
    occKeys: OccurrenceKey[]
    subByPos: Map<number, number>
    role: CaptureRole
    clock: TimeClock
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
        subByPos: ctx.subByPos,
        clock: ctx.clock,
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
      role: ctx.role,
      content,
      position: ctx.position,
      createdAt: ctx.createdAt,
      occKeys: ctx.occKeys,
      subByPos: ctx.subByPos,
      clock: ctx.clock,
    })
    if (row.metadata?.truncated) truncated += 1
    rows.push(row)
  }
  for (const tool of tools) {
    const row = makeMessage({
      opts: ctx.opts,
      role: ctx.role,
      content: '',
      toolName: tool.name,
      toolArgs: tool.input,
      position: ctx.position,
      createdAt: ctx.createdAt,
      occKeys: ctx.occKeys,
      subByPos: ctx.subByPos,
      clock: ctx.clock,
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
    subByPos: Map<number, number>
    clock: TimeClock
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
        subByPos: ctx.subByPos,
        clock: ctx.clock,
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
      subByPos: ctx.subByPos,
      clock: ctx.clock,
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
  subByPos: Map<number, number>
  toolName?: string
  toolArgs?: unknown
  toolResult?: string
  extra?: Record<string, unknown>
  clock: TimeClock
}): CaptureMessage {
  const sub = nextSub(args.subByPos, args.position)
  const metadata: Record<string, unknown> = {
    channel: args.opts.channel ?? CAPTURE_CHANNEL,
    source: args.opts.format === 'page' ? 'grokbot-readtranscript' : 'grokbot-transcript',
    position: args.position,
    ordinal: args.position * ORDINAL_STRIDE + sub,
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
  const createdAt = clampCreatedAt(args.clock, args.createdAt)
  if (createdAt) msg.created_at = createdAt
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
      event_id: m.event_id,
    }
    if (typeof m.metadata?.ordinal === 'number') row.ordinal = m.metadata.ordinal
    if (m.created_at) row.createdAt = m.created_at
    if (m.tool_name) {
      row.toolCalls = [{ name: m.tool_name, input: m.tool_args }]
    }
    return row
  })
}

function nextSub(subByPos: Map<number, number>, position: number): number {
  const n = subByPos.get(position) ?? 0
  if (n >= ORDINAL_STRIDE) {
    throw new Error(
      `ordinal sub-index ${String(n)} >= ${String(ORDINAL_STRIDE)} at position ${String(position)}`,
    )
  }
  subByPos.set(position, n + 1)
  return n
}
