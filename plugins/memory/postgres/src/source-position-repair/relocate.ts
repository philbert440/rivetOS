import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs'
import type { Pool, PoolClient } from 'pg'
import { isRelocateRejection, RelocateRejection } from './errors.js'
import { conversationStateHash, type HashableMessage } from './hash.js'
import {
  derivedCaptureEventId,
  derivedIngestEventId,
  rewriteBackfillSourceId,
  sourceOrdinal,
  sourceSubIndex,
} from './ordinal.js'
import type { RelocateMode, SourcePositionRepairPlan, SourcePositionRelocation } from './plan.js'

interface MessageRow extends HashableMessage {
  agent: string
}

interface SummarySourceRow {
  summary_id: string
  message_id: string
  ordinal: number
}

export interface RelocateMoveReport {
  messageId: string
  fromPosition: number
  toPosition: number
  fromOrdinal: number
  toOrdinal: number
  eventIdRewritten: boolean
  sourceIdRewritten: boolean
}

export interface RelocateReport {
  conversationId: string
  sessionKey: string
  provenanceRef: string
  datesRepaired: false
  alreadyApplied: boolean
  moves: RelocateMoveReport[]
}

export type RelocateOutcome =
  | { kind: 'dry-run'; report: RelocateReport }
  | { kind: 'applied'; report: RelocateReport; backupPath: string }
  | { kind: 'already-applied'; report: RelocateReport }

interface PreparedMove {
  relocation: SourcePositionRelocation
  row: MessageRow
  sub: number
  toOrdinal: number
  toEventId: string
  toSourceId: string | undefined
  eventIdRewritten: boolean
  sourceIdRewritten: boolean
  nextMetadata: Record<string, unknown>
}

function metaNumber(meta: Record<string, unknown>, key: string): number | undefined {
  const value = meta[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function metaString(meta: Record<string, unknown>, key: string): string | undefined {
  const value = meta[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function asMetadata(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return { ...(value as Record<string, unknown>) }
  }
  return {}
}

function locatorOf(row: MessageRow): {
  position: number | undefined
  ordinal: number | undefined
  eventId: string | undefined
  captureSource: string | undefined
  sourceId: string | undefined
} {
  return {
    position: metaNumber(row.metadata, 'position'),
    ordinal: metaNumber(row.metadata, 'ordinal'),
    eventId: metaString(row.metadata, 'event_id'),
    captureSource: metaString(row.metadata, 'capture_source'),
    sourceId: metaString(row.metadata, 'source_id'),
  }
}

function occupancyKey(position: number, ordinal: number): string {
  return `${String(position)}:${String(ordinal)}`
}

function pgCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = error.code
    return typeof code === 'string' ? code : undefined
  }
  return undefined
}

function writeBackupFile(path: string, body: string): void {
  let fd: number | undefined
  try {
    fd = openSync(path, 'wx', 0o600)
    writeSync(fd, body)
    fsyncSync(fd)
  } catch (error) {
    throw new RelocateRejection(
      'backup_failed',
      `could not persist before-state backup: ${error instanceof Error ? error.message : String(error)}`,
    )
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function matchesFrom(row: MessageRow, relocation: SourcePositionRelocation): boolean {
  const loc = locatorOf(row)
  const from = relocation.from
  if (
    loc.position !== from.position ||
    loc.ordinal !== from.ordinal ||
    loc.eventId !== from.eventId
  ) {
    return false
  }
  if (from.captureSource !== undefined && loc.captureSource !== from.captureSource) return false
  if (from.sourceId !== undefined && loc.sourceId !== from.sourceId) return false
  return true
}

function alreadyAtTarget(prepared: PreparedMove): boolean {
  const loc = locatorOf(prepared.row)
  if (loc.position !== prepared.relocation.to.position) return false
  if (loc.ordinal !== prepared.toOrdinal) return false
  if (loc.eventId !== prepared.toEventId) return false
  if (prepared.toSourceId !== undefined && loc.sourceId !== prepared.toSourceId) return false
  return true
}

function prepareMove(
  plan: SourcePositionRepairPlan,
  row: MessageRow,
  relocation: SourcePositionRelocation,
): PreparedMove {
  const sub = sourceSubIndex(relocation.from.position, relocation.from.ordinal)
  if (sub === undefined) {
    throw new RelocateRejection(
      'unsupported_ordinal',
      `message ${relocation.messageId} ordinal is not position*stride+sub`,
    )
  }
  const toOrdinal = sourceOrdinal(relocation.to.position, sub)
  const captureContent = row.content || row.tool_result || ''
  const toolArgs = row.tool_args === null ? undefined : row.tool_args
  const fromCaptureId = derivedCaptureEventId({
    sessionKey: plan.sessionKey,
    role: row.role,
    content: captureContent,
    toolName: row.tool_name,
    toolArgs,
    ordinal: relocation.from.ordinal,
  })
  const fromIngestId = derivedIngestEventId({
    sessionId: plan.sessionKey,
    agent: plan.agent,
    role: row.role,
    content: row.content,
    ordinal: relocation.from.ordinal,
    toolName: row.tool_name,
  })
  let toEventId = relocation.from.eventId
  if (relocation.from.eventId === fromCaptureId) {
    toEventId = derivedCaptureEventId({
      sessionKey: plan.sessionKey,
      role: row.role,
      content: captureContent,
      toolName: row.tool_name,
      toolArgs,
      ordinal: toOrdinal,
    })
  } else if (relocation.from.eventId === fromIngestId) {
    toEventId = derivedIngestEventId({
      sessionId: plan.sessionKey,
      agent: plan.agent,
      role: row.role,
      content: row.content,
      ordinal: toOrdinal,
      toolName: row.tool_name,
    })
  }
  const fromSourceId = relocation.from.sourceId ?? metaString(row.metadata, 'source_id')
  const toSourceId =
    fromSourceId === undefined
      ? undefined
      : (rewriteBackfillSourceId(
          fromSourceId,
          relocation.from.position,
          relocation.to.position,
          sub,
        ) ?? fromSourceId)
  const nextMetadata: Record<string, unknown> = {
    ...row.metadata,
    position: relocation.to.position,
    ordinal: toOrdinal,
    event_id: toEventId,
  }
  if (toSourceId !== undefined) nextMetadata.source_id = toSourceId
  if (typeof nextMetadata.sub_index === 'number') nextMetadata.sub_index = sub
  return {
    relocation,
    row,
    sub,
    toOrdinal,
    toEventId,
    toSourceId,
    eventIdRewritten: toEventId !== relocation.from.eventId,
    sourceIdRewritten: toSourceId !== undefined && toSourceId !== fromSourceId,
    nextMetadata,
  }
}

function rejectDuplicatePlanIds(plan: SourcePositionRepairPlan): void {
  const seen = new Set<string>()
  for (const relocation of plan.relocations) {
    if (seen.has(relocation.messageId)) {
      throw new RelocateRejection(
        'duplicate_message',
        `message ${relocation.messageId} is listed more than once`,
      )
    }
    seen.add(relocation.messageId)
  }
}

function rejectSplitEntries(rows: MessageRow[], prepared: PreparedMove[]): void {
  const moving = new Map(prepared.map((item) => [item.row.id, item]))
  const groups = new Map<string, MessageRow[]>()
  for (const row of rows) {
    const loc = locatorOf(row)
    if (loc.position === undefined || loc.ordinal === undefined) continue
    const sub = sourceSubIndex(loc.position, loc.ordinal)
    if (sub === undefined) continue
    const key = `${loc.captureSource ?? ''}:${String(loc.position)}`
    const group = groups.get(key) ?? []
    group.push(row)
    groups.set(key, group)
  }
  for (const group of groups.values()) {
    const subs = new Set(
      group.map((row) =>
        sourceSubIndex(locatorOf(row).position ?? -1, locatorOf(row).ordinal ?? -1),
      ),
    )
    if (group.length < 2 || subs.size < 2) continue
    const inPlan = group.filter((row) => moving.has(row.id))
    if (inPlan.length === 0) continue
    if (inPlan.length !== group.length) {
      throw new RelocateRejection(
        'split_entry',
        'plan moves part of a multi-sub source entry; include every sibling at that position',
      )
    }
    const dest = new Set(inPlan.map((row) => moving.get(row.id)?.relocation.to.position))
    if (dest.size !== 1) {
      throw new RelocateRejection(
        'split_entry',
        'plan sends siblings of one source entry to different positions',
      )
    }
  }
}

function rejectOccupancy(rows: MessageRow[], prepared: PreparedMove[]): void {
  const movingIds = new Set(prepared.map((item) => item.row.id))
  const finals = new Map<string, string>()
  for (const row of rows) {
    const loc = locatorOf(row)
    const move = prepared.find((item) => item.row.id === row.id)
    const position = move ? move.relocation.to.position : loc.position
    const ordinal = move ? move.toOrdinal : loc.ordinal
    if (position === undefined || ordinal === undefined) continue
    const key = occupancyKey(position, ordinal)
    const owner = finals.get(key)
    if (owner && owner !== row.id) {
      const bothMoving = movingIds.has(owner) && movingIds.has(row.id)
      throw new RelocateRejection(
        bothMoving ? 'duplicate_target' : 'occupied_target',
        bothMoving
          ? `two rows target occupancy ${key}`
          : `position/ordinal ${key} is occupied outside the plan's dependency closure`,
      )
    }
    finals.set(key, row.id)
  }
  const eventOwners = new Map<string, string>()
  for (const row of rows) {
    const move = prepared.find((item) => item.row.id === row.id)
    const eventId = move ? move.toEventId : locatorOf(row).eventId
    if (!eventId) continue
    const owner = eventOwners.get(eventId)
    if (owner && owner !== row.id) {
      throw new RelocateRejection(
        'duplicate_target',
        `event_id collision within the conversation after apply`,
      )
    }
    eventOwners.set(eventId, row.id)
  }
}

function rejectTimestampOrder(rows: MessageRow[], prepared: PreparedMove[]): void {
  const byId = new Map(prepared.map((item) => [item.row.id, item]))
  const positioned = rows
    .map((row) => {
      const move = byId.get(row.id)
      const loc = locatorOf(row)
      const position = move ? move.relocation.to.position : loc.position
      const ordinal = move ? move.toOrdinal : loc.ordinal
      if (position === undefined || ordinal === undefined) return null
      return { id: row.id, position, ordinal, createdAt: row.created_at.getTime() }
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
  const bySource = [...positioned].sort((a, b) => {
    if (a.position !== b.position) return a.position - b.position
    if (a.ordinal !== b.ordinal) return a.ordinal - b.ordinal
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
  const byTime = [...positioned].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
    if (a.position !== b.position) return a.position - b.position
    if (a.ordinal !== b.ordinal) return a.ordinal - b.ordinal
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
  for (let i = 0; i < bySource.length; i++) {
    if (bySource[i].id !== byTime[i].id) {
      throw new RelocateRejection(
        'timestamp_order',
        'destination source order disagrees with created_at browse order; v1 does not repair dates, and timestamps from the old position are not destination proof',
      )
    }
  }
}

function rejectSummaryContiguity(
  rows: MessageRow[],
  prepared: PreparedMove[],
  sources: SummarySourceRow[],
): void {
  if (sources.length === 0) return
  const moved = new Set(prepared.map((item) => item.row.id))
  if (![...moved].some((id) => sources.some((source) => source.message_id === id))) return
  const byId = new Map(rows.map((row) => [row.id, row]))
  const moveById = new Map(prepared.map((item) => [item.row.id, item]))
  const grouped = new Map<string, SummarySourceRow[]>()
  for (const source of sources) {
    const list = grouped.get(source.summary_id) ?? []
    list.push(source)
    grouped.set(source.summary_id, list)
  }
  for (const group of grouped.values()) {
    if (!group.some((source) => moved.has(source.message_id))) continue
    const ordered = [...group].sort((a, b) => a.ordinal - b.ordinal)
    for (let i = 1; i < ordered.length; i++) {
      const prev = byId.get(ordered[i - 1].message_id)
      const next = byId.get(ordered[i].message_id)
      if (!prev || !next) {
        throw new RelocateRejection('summary_contiguity', 'summary source row is missing')
      }
      if (prev.created_at.getTime() > next.created_at.getTime()) {
        throw new RelocateRejection(
          'summary_contiguity',
          'summary source ordinals are not created_at-contiguous',
        )
      }
      const prevMove = moveById.get(prev.id)
      const nextMove = moveById.get(next.id)
      const prevPos = prevMove ? prevMove.relocation.to.position : locatorOf(prev).position
      const nextPos = nextMove ? nextMove.relocation.to.position : locatorOf(next).position
      if (prevPos !== undefined && nextPos !== undefined && prevPos > nextPos) {
        throw new RelocateRejection(
          'summary_contiguity',
          'summary source ordinals would run backward against destination positions',
        )
      }
    }
  }
}

async function loadLockedState(
  client: PoolClient,
  plan: SourcePositionRepairPlan,
): Promise<{ rows: MessageRow[]; sources: SummarySourceRow[] }> {
  const conversation = await client.query<{ id: string; session_key: string; agent: string }>(
    `SELECT id, session_key, agent FROM ros_conversations WHERE id = $1 FOR UPDATE`,
    [plan.conversationId],
  )
  if (conversation.rows.length === 0) {
    throw new RelocateRejection('missing_row', `conversation ${plan.conversationId} does not exist`)
  }
  const conv = conversation.rows[0]
  if (conv.session_key !== plan.sessionKey || conv.agent !== plan.agent) {
    throw new RelocateRejection(
      'cross_conversation',
      'plan session_key/agent does not match the conversation row',
    )
  }
  const messages = await client.query<Omit<MessageRow, 'metadata'> & { metadata: unknown }>(
    `SELECT id, conversation_id, agent, role, content, tool_name, tool_args, tool_result,
            created_at, access_count, metadata
       FROM ros_messages
      WHERE conversation_id = $1
      ORDER BY id
        FOR UPDATE`,
    [plan.conversationId],
  )
  const rows: MessageRow[] = messages.rows.map((row) => ({
    ...row,
    metadata: asMetadata(row.metadata),
  }))
  const sources = await client.query<SummarySourceRow>(
    `SELECT ss.summary_id, ss.message_id, ss.ordinal
       FROM ros_summary_sources ss
       JOIN ros_messages m ON m.id = ss.message_id
      WHERE m.conversation_id = $1`,
    [plan.conversationId],
  )
  return { rows, sources: sources.rows }
}

function classify(plan: SourcePositionRepairPlan, rows: MessageRow[]): PreparedMove[] {
  rejectDuplicatePlanIds(plan)
  const byId = new Map(rows.map((row) => [row.id, row]))
  const prepared: PreparedMove[] = []
  let pending = 0
  let applied = 0
  for (const relocation of plan.relocations) {
    const row = byId.get(relocation.messageId)
    if (!row) {
      throw new RelocateRejection('missing_row', `message ${relocation.messageId} does not exist`)
    }
    if (row.conversation_id !== plan.conversationId) {
      throw new RelocateRejection(
        'cross_conversation',
        `message ${relocation.messageId} is not in the plan conversation`,
      )
    }
    const move = prepareMove(plan, row, relocation)
    if (matchesFrom(row, relocation)) {
      pending += 1
      prepared.push(move)
      continue
    }
    if (alreadyAtTarget(move)) {
      applied += 1
      prepared.push(move)
      continue
    }
    throw new RelocateRejection(
      'stale_hash',
      `message ${relocation.messageId} matches neither from-locator nor already-applied target`,
    )
  }
  if (applied > 0 && pending > 0) {
    throw new RelocateRejection(
      'ambiguous',
      'plan is mixed already-applied and pending; submit only the remaining from-state rows',
    )
  }
  return prepared
}

function reportOf(
  plan: SourcePositionRepairPlan,
  prepared: PreparedMove[],
  alreadyApplied: boolean,
): RelocateReport {
  return {
    conversationId: plan.conversationId,
    sessionKey: plan.sessionKey,
    provenanceRef: plan.provenanceRef,
    datesRepaired: false,
    alreadyApplied,
    moves: prepared.map((item) => ({
      messageId: item.row.id,
      fromPosition: item.relocation.from.position,
      toPosition: item.relocation.to.position,
      fromOrdinal: item.relocation.from.ordinal,
      toOrdinal: item.toOrdinal,
      eventIdRewritten: alreadyApplied ? false : item.eventIdRewritten,
      sourceIdRewritten: alreadyApplied ? false : item.sourceIdRewritten,
    })),
  }
}

async function applyUpdates(client: PoolClient, prepared: PreparedMove[]): Promise<void> {
  for (const item of prepared) {
    if (alreadyAtTarget(item)) continue
    const result = await client.query(
      `UPDATE ros_messages
          SET metadata = $2::jsonb
        WHERE id = $1
          AND conversation_id = $3
          AND content = $4
          AND role = $5
          AND COALESCE(tool_name, '') = COALESCE($6, '')`,
      [
        item.row.id,
        JSON.stringify(item.nextMetadata),
        item.row.conversation_id,
        item.row.content,
        item.row.role,
        item.row.tool_name,
      ],
    )
    if (result.rowCount !== 1) {
      throw new RelocateRejection('stale_hash', `message ${item.row.id} changed during apply`)
    }
  }
}

export async function relocateSourcePositions(
  source: Pool | PoolClient,
  plan: SourcePositionRepairPlan,
  mode: RelocateMode,
): Promise<RelocateOutcome> {
  const owned = !('release' in source)
  const client = owned ? await source.connect() : source
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [plan.sessionKey])
    if (mode.kind === 'apply') {
      await client.query('LOCK TABLE ros_messages IN SHARE ROW EXCLUSIVE MODE')
    }
    const { rows, sources } = await loadLockedState(client, plan)
    const hash = conversationStateHash(rows)
    const prepared = classify(plan, rows)
    const allApplied = prepared.every((item) => alreadyAtTarget(item))
    if (!allApplied && hash !== plan.expectedStateHash) {
      throw new RelocateRejection(
        'stale_hash',
        'conversation state does not match expectedStateHash',
      )
    }
    if (allApplied) {
      if (mode.kind === 'apply') {
        await client.query('COMMIT')
        return { kind: 'already-applied', report: reportOf(plan, prepared, true) }
      }
      await client.query('ROLLBACK')
      return { kind: 'dry-run', report: reportOf(plan, prepared, true) }
    }
    rejectSplitEntries(rows, prepared)
    rejectOccupancy(rows, prepared)
    rejectTimestampOrder(rows, prepared)
    rejectSummaryContiguity(rows, prepared, sources)
    const report = reportOf(plan, prepared, false)
    if (mode.kind === 'dry-run') {
      await client.query('ROLLBACK')
      return { kind: 'dry-run', report }
    }
    writeBackupFile(
      mode.backupPath,
      `${JSON.stringify({
        schemaVersion: 1,
        provenanceRef: plan.provenanceRef,
        conversationId: plan.conversationId,
        sessionKey: plan.sessionKey,
        agent: plan.agent,
        expectedStateHash: plan.expectedStateHash,
        before: prepared.map((item) => ({
          id: item.row.id,
          metadata: item.row.metadata,
          created_at: item.row.created_at.toISOString(),
        })),
      })}\n`,
    )
    await applyUpdates(client, prepared)
    const after = await loadLockedState(client, plan)
    if (after.rows.length !== rows.length) {
      throw new RelocateRejection('concurrent_insert', 'message set changed before commit')
    }
    rejectOccupancy(after.rows, [])
    await client.query('COMMIT')
    return { kind: 'applied', report, backupPath: mode.backupPath }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    if (isRelocateRejection(error)) throw error
    if (pgCode(error) === '40001' || pgCode(error) === '40P01' || pgCode(error) === '55P03') {
      throw new RelocateRejection(
        'concurrent_insert',
        'serializable conflict or lock timeout with a competing writer',
      )
    }
    throw error
  } finally {
    if (owned) client.release()
  }
}
