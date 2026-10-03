import {
  eventIdFromContent,
  isRecord,
  type CaptureMessage,
  type CaptureRole,
  type OccurrenceKey,
} from '@rivetos/capture-core'
import { classifyHidden, extractAgentMessage, systemMarker } from './hidden.js'
import {
  CAPTURE_CHANNEL,
  ORDINAL_STRIDE,
  type HiddenKind,
  type IngestRow,
  type NormalizeOptions,
  type NormalizeResult,
  type NormalizeStats,
} from './types.js'
import { partText, recordParts, recordRole, toolResultBody } from './parse.js'
import { deriveCreatedAt, extractTimestampTag, recordExplicitTime } from './timestamps.js'
import { boundStoredText, pointerMeta } from './storage.js'
import { extractUserText, hasSandMarker } from './wrappers.js'

export interface TimeClock {
  last?: string
  lastOriginal?: string
  lastAdjustmentMs?: number
}

/** A replay is a stamped user turn plus at least one following record. */
export const REPLAY_MIN_LEN = 2
/**
 * Re-append blocks on real transcripts are 20+ identical rows. Drop a run of
 * this many consecutive records that match an earlier run and share a defined
 * created_at (or user timestamp tag). Short identical polling pairs stay.
 */
export const REPLAY_IDENTICAL_RUN_MIN = 10

function recordHash(rec: unknown): string {
  try {
    return JSON.stringify(rec)
  } catch {
    return String(rec)
  }
}

function stampedUserTime(rec: unknown): string | undefined {
  const role = recordRole(rec)
  if (role !== 'user' && role !== 'human') return undefined
  const raw = recordParts(rec).map(partText).filter(Boolean).join('\n')
  return extractTimestampTag(raw)
}

/**
 * Skip a concatenated replay: a stamped user turn whose stamp repeats an
 * earlier stamped user, followed by the same next records. Isolated
 * same-minute user turns and repeated tool_use/tool_result pairs are kept.
 * Indexed by stamp so a long transcript is linear in the number of records.
 */
export function replaySkipIndices(records: unknown[]): Set<number> {
  const hashes = records.map(recordHash)
  const stamps = records.map(stampedUserTime)
  const firstByStamp = new Map<string, number>()
  const skip = new Set<number>()
  let j = 0
  while (j < hashes.length) {
    const stamp = stamps[j]
    if (!stamp) {
      j += 1
      continue
    }
    const prev = firstByStamp.get(stamp)
    if (prev === undefined) {
      firstByStamp.set(stamp, j)
      j += 1
      continue
    }
    let len = 0
    while (prev + len < j && j + len < hashes.length && hashes[prev + len] === hashes[j + len]) {
      len += 1
    }
    if (len >= REPLAY_MIN_LEN) {
      for (let k = 0; k < len; k++) skip.add(j + k)
      j += len
    } else {
      j += 1
    }
  }
  skipIdenticalCreatedAtRuns(records, hashes, skip)
  return skip
}

function recordCreatedAtKey(rec: unknown): string | undefined {
  if (isRecord(rec)) {
    const raw = rec.created_at ?? rec.createdAt
    if (typeof raw === 'string' && raw.trim()) return raw
    if (raw instanceof Date && !Number.isNaN(raw.getTime())) return raw.toISOString()
  }
  return stampedUserTime(rec)
}

/**
 * Drop runs of REPLAY_IDENTICAL_RUN_MIN+ consecutive records that are
 * identical to an earlier run and share a defined created_at. A later run
 * must have at least one defined time. Unstamped short polling pairs and
 * 10+ identical tools at different times are kept.
 *
 * Matches every earlier row with the same hash, not just the first. That
 * drops 15 more real re-append rows than first-match-only. Candidate
 * walks are bounded (next-hash filter + a small cap) so one record that
 * repeats many times is not O(k²). Rows skipped inside a matched run are
 * still added to byHash so a later copy can match after older starts
 * fall out of the candidate window.
 */
function skipIdenticalCreatedAtRuns(records: unknown[], hashes: string[], skip: Set<number>): void {
  const times = records.map(recordCreatedAtKey)
  const byHash = new Map<string, number[]>()
  let j = 0
  while (j < hashes.length) {
    const hash = hashes[j] ?? ''
    if (skip.has(j)) {
      rememberHash(byHash, hash, j)
      j += 1
      continue
    }
    const earlier = identicalRunCandidates(byHash.get(hash) ?? [], hashes, j)
    let bestLen = 0
    let bestSawTime = false
    for (const prev of earlier) {
      let len = 0
      let sawTime = false
      while (prev + len < j && j + len < hashes.length && !skip.has(j + len)) {
        if (hashes[prev + len] !== hashes[j + len]) break
        const later = times[j + len]
        const earlierTime = times[prev + len]
        if (later) {
          if (later !== earlierTime) break
          sawTime = true
        } else if (earlierTime) {
          break
        }
        len += 1
      }
      if (len > bestLen) {
        bestLen = len
        bestSawTime = sawTime
      }
    }
    if (bestLen >= REPLAY_IDENTICAL_RUN_MIN && bestSawTime) {
      for (let k = 0; k < bestLen; k++) {
        skip.add(j + k)
        rememberHash(byHash, hashes[j + k] ?? '', j + k)
      }
      j += bestLen
    } else {
      rememberHash(byHash, hash, j)
      j += 1
    }
  }
}

/** Prefer starts whose next hash also matches, then keep earliest + recent. */
const IDENTICAL_RUN_CANDIDATE_CAP = 8

function identicalRunCandidates(earlier: number[], hashes: string[], j: number): number[] {
  if (earlier.length === 0) return []
  let filtered = earlier
  if (j + 1 < hashes.length) {
    const next = hashes[j + 1]
    const nextMatch = earlier.filter((prev) => hashes[prev + 1] === next)
    if (nextMatch.length > 0) filtered = nextMatch
  }
  if (filtered.length <= IDENTICAL_RUN_CANDIDATE_CAP) return filtered
  const head = filtered[0]
  const tail = filtered.slice(-(IDENTICAL_RUN_CANDIDATE_CAP - 1))
  return head === tail[0] ? tail : [head, ...tail.filter((i) => i !== head)]
}

function rememberHash(byHash: Map<string, number[]>, hash: string, idx: number): void {
  const arr = byHash.get(hash)
  if (arr) arr.push(idx)
  else byHash.set(hash, [idx])
}

export function clampCreatedAt(clock: TimeClock, candidate?: string): string | undefined {
  if (!candidate) {
    clock.lastOriginal = undefined
    clock.lastAdjustmentMs = 0
    return undefined
  }
  const t = Date.parse(candidate)
  if (Number.isNaN(t)) {
    clock.lastOriginal = undefined
    clock.lastAdjustmentMs = 0
    return candidate
  }
  const min = clock.last !== undefined ? Date.parse(clock.last) + 1 : Number.NEGATIVE_INFINITY
  if (t >= min) {
    clock.last = candidate
    clock.lastOriginal = undefined
    clock.lastAdjustmentMs = 0
    return candidate
  }
  const iso = new Date(min).toISOString()
  clock.last = iso
  clock.lastOriginal = candidate
  clock.lastAdjustmentMs = min - t
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
  const positions = records.map((_, i) => opts.positions?.[i] ?? start + i)
  const maxPosition = positions.length ? Math.max(...positions) : start
  const minPosition = positions.length ? Math.min(...positions) : start
  const explicits = records.map((rec) => {
    const rawRole = recordRole(rec)
    const parts = recordParts(rec)
    const rawText = parts.map(partText).filter(Boolean).join('\n')
    const tagged = recordExplicitTime(rec, rawText, rawRole, parts)
    if (tagged) return tagged
    if (opts.useStoredCreatedAt) {
      const stored = recordStoredTime(rec)
      if (stored) return { time: stored, source: 'stored' as const }
    }
    return undefined
  })
  const laterByIndex: Array<{ time: string; position: number } | undefined> = Array.from(
    { length: records.length },
    () => undefined,
  )
  let nextLater: { time: string; position: number } | undefined
  for (let i = records.length - 1; i >= 0; i--) {
    laterByIndex[i] = nextLater
    const stamp = explicits[i]
    if (stamp) nextLater = { time: stamp.time, position: positions[i] ?? start + i }
  }
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
  let sawTimestamp = Boolean(opts.lastKnownTime)

  for (let i = 0; i < records.length; i++) {
    if (replaySkips.has(i)) {
      dropped += 1
      continue
    }
    const position = positions[i] ?? start + i
    const rec = records[i]
    const rawRole = recordRole(rec)
    const role = ROLE_MAP[rawRole] ?? (rawRole ? undefined : 'assistant')
    const parts = recordParts(rec)
    const rawText = parts.map(partText).filter(Boolean).join('\n')
    const userLike = role === 'user'
    const stamped = explicits[i]
    const sand = userLike && hasSandMarker(rawText)
    const kind = sand ? classifyHidden(rawText) : undefined
    const userText = userLike ? extractUserText(rawText) : ''

    const earlier = lastStampedUser
    if (stamped) {
      sawTimestamp = true
      lastStampedUser = { time: stamped.time, position }
    }

    const derived = deriveCreatedAt({
      explicit: stamped,
      position,
      earlier,
      later: laterByIndex[i],
      fileMtimeMs: opts.fileMtimeMs,
      fileBirthtimeMs: opts.fileBirthtimeMs,
      minPosition,
      maxPosition,
    })
    const createdAt = derived.time
    const timeSource = derived.source
    const sourceLine = opts.sourceLines?.[i] ?? position
    const fromList = opts.sourcePaths?.[i]
    const recordSource = fromList && fromList.length > 0 ? fromList : opts.sourcePath
    const recordOpts: NormalizeOptions =
      recordSource && recordSource !== opts.sourcePath
        ? { ...opts, sourcePath: recordSource }
        : opts

    if (role === 'tool') {
      const emitted = emitToolParts(parts, {
        opts: recordOpts,
        position,
        createdAt,
        timeSource,
        sourceLine,
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
        opts: recordOpts,
        position,
        createdAt,
        timeSource,
        sourceLine,
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

    // Real user prose wins. Do not re-classify leftover text: unanchored
    // hidden tags in a normal message ("the [agent] tag should…") must stay
    // user. Hidden-only SAND turns have empty userText after extractUserText.
    if (userText) {
      const row = makeMessage({
        opts: recordOpts,
        role: 'user',
        content: userText,
        position,
        createdAt,
        timeSource,
        sourceLine,
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
      const dedupeKey = `agent_message\0${String(position)}\0${content}`
      if (seenSystem.has(dedupeKey)) {
        dropped += 1
        continue
      }
      seenSystem.add(dedupeKey)
      const row = makeMessage({
        opts: recordOpts,
        role: 'system',
        content,
        position,
        createdAt,
        timeSource,
        sourceLine,
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
      // Hidden kinds stay distinct by position so overlapping pages merge
      // stably and zero-text kinds (reaction, first_run, …) are not collapsed.
      const dedupeKey = `${kind}\0${String(position)}\0${content}`
      if (seenSystem.has(dedupeKey)) {
        dropped += 1
        continue
      }
      seenSystem.add(dedupeKey)
      const row = makeMessage({
        opts: recordOpts,
        role: 'system',
        content,
        position,
        createdAt,
        timeSource,
        sourceLine,
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
    timeKnown: sawTimestamp || messages.some((m) => Boolean(m.created_at)),
    lastKnownTime: lastStampedUser?.time ?? clock.last,
  }
  return {
    messages,
    stats,
    lastKnownTime: lastStampedUser?.time ?? clock.last,
    timeKnown: stats.timeKnown,
  }
}

function captureSource(format?: NormalizeOptions['format']): string {
  if (format === 'page') return 'grokbot-readtranscript'
  if (format === 'store') return 'grokbot-store'
  if (format === 'voice') return 'grokbot-voice'
  return 'grokbot-transcript'
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
    timeSource?: string
    sourceLine?: number
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
        toolArgs: toolArgsFromPart(part),
        toolResult: body,
        position: ctx.position,
        createdAt: ctx.createdAt,
        timeSource: ctx.timeSource,
        sourceLine: ctx.sourceLine,
        occKeys: ctx.occKeys,
        subByPos: ctx.subByPos,
        clock: ctx.clock,
        extra: toolResultExtra(part),
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
      timeSource: ctx.timeSource,
      sourceLine: ctx.sourceLine,
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
      timeSource: ctx.timeSource,
      sourceLine: ctx.sourceLine,
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
    timeSource?: string
    sourceLine?: number
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
      const toolArgs = toolArgsFromPart(part)
      const row = makeMessage({
        opts: ctx.opts,
        role: 'tool',
        content: '',
        toolName: name,
        toolArgs,
        toolResult: body,
        position: ctx.position,
        createdAt: ctx.createdAt,
        timeSource: ctx.timeSource,
        sourceLine: ctx.sourceLine,
        occKeys: ctx.occKeys,
        subByPos: ctx.subByPos,
        clock: ctx.clock,
        extra: toolResultExtra(part),
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
      timeSource: ctx.timeSource,
      sourceLine: ctx.sourceLine,
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
  timeSource?: string
  sourceLine?: number
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
    source: captureSource(args.opts.format),
    position: args.position,
    ordinal: args.position * ORDINAL_STRIDE + sub,
  }
  if (args.opts.agentId) metadata.agent_id = args.opts.agentId
  if (args.opts.persona) metadata.persona = args.opts.persona
  if (args.timeSource) metadata.time_source = args.timeSource
  if (args.extra) Object.assign(metadata, args.extra)

  const contentBound = boundStoredText(args.content)
  const toolBound = args.toolResult !== undefined ? boundStoredText(args.toolResult) : undefined
  const content = contentBound.text
  const toolResult = toolBound?.text
  const toolArgs = args.toolArgs
  const cut = contentBound.truncated || Boolean(toolBound?.truncated)
  if (cut) {
    metadata.truncated = true
    if (contentBound.truncated || contentBound.stubbed) {
      metadata.full_content_length = contentBound.fullLength
    }
    if (toolBound && (toolBound.truncated || toolBound.stubbed)) {
      metadata.full_tool_result_length = toolBound.fullLength
    }
    if (contentBound.stubbed || toolBound?.stubbed) metadata.image_stubbed = true
    if (args.opts.sourcePath) {
      Object.assign(metadata, pointerMeta(args.opts.sourcePath, args.sourceLine ?? args.position))
    }
  }

  const occKey: OccurrenceKey = {
    role: args.role,
    content: content || toolResult || args.toolName || '',
    toolName: args.toolName,
    toolArgs,
  }
  args.occKeys.push(occKey)

  // Hash the ingest ordinal so the same content at two positions cannot
  // collide, and a mid-transcript page produces the same event_id as a
  // full run from position 0.
  const event_id = eventIdFromContent({
    sessionKey: args.opts.sessionKey,
    role: args.role,
    content: content || toolResult || '',
    toolName: args.toolName,
    toolArgs,
    occurrence: metadata.ordinal as number,
  })

  const msg: CaptureMessage = {
    event_id,
    role: args.role,
    content,
    metadata,
  }
  if (args.toolName) msg.tool_name = args.toolName
  if (toolArgs !== undefined) msg.tool_args = toolArgs
  if (toolResult !== undefined) msg.tool_result = toolResult
  const createdAt = clampCreatedAt(args.clock, args.createdAt)
  if (createdAt) msg.created_at = createdAt
  if (args.clock.lastAdjustmentMs !== undefined && args.clock.lastAdjustmentMs > 1_000) {
    metadata.created_at_original = args.clock.lastOriginal
    metadata.created_at_adjusted_ms = args.clock.lastAdjustmentMs
  }
  return msg
}

function toolArgsFromPart(part: Record<string, unknown>): unknown {
  if (part.argumentsJson !== undefined) return part.argumentsJson
  if (part.arguments !== undefined) return part.arguments
  if (part.input !== undefined) return part.input
  return undefined
}

function toolUseIdFromPart(part: Record<string, unknown>): string | undefined {
  if (typeof part.tool_use_id === 'string' && part.tool_use_id) return part.tool_use_id
  if (typeof part.toolUseId === 'string' && part.toolUseId) return part.toolUseId
  if (typeof part.id === 'string' && part.id) return part.id
  return undefined
}

function truncationExtra(part: Record<string, unknown>): Record<string, unknown> | undefined {
  const extra: Record<string, unknown> = {}
  if (part.truncated === true) extra.truncated = true
  if (typeof part.full_tool_result_length === 'number') {
    extra.full_tool_result_length = part.full_tool_result_length
  }
  if (typeof part.full_arguments_length === 'number') {
    extra.full_arguments_length = part.full_arguments_length
  }
  return Object.keys(extra).length > 0 ? extra : undefined
}

function toolResultExtra(part: Record<string, unknown>): Record<string, unknown> | undefined {
  const extra = truncationExtra(part) ?? {}
  const id = toolUseIdFromPart(part)
  if (id) extra.tool_id = id
  return Object.keys(extra).length > 0 ? extra : undefined
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
    const metadata = m.metadata ? { ...m.metadata } : undefined
    if (metadata && typeof metadata.source === 'string') {
      metadata.capture_source = metadata.source
    }
    const row: IngestRow = {
      role: m.role,
      content: m.content,
      metadata,
      event_id: m.event_id,
    }
    if (typeof m.metadata?.ordinal === 'number') row.ordinal = m.metadata.ordinal
    if (m.created_at) row.createdAt = m.created_at
    if (m.tool_name) {
      row.toolCalls = [{ name: m.tool_name, input: m.tool_args }]
    }
    if (m.tool_result !== undefined) row.toolResult = m.tool_result
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
