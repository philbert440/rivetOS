/**
 * Write cleaned grok-bot rows through PostgresMemory.append.
 *
 * The shared memory_ingest_session ignores caller ordinals, event ids,
 * per-row metadata, and tool_result. This writer keeps those on the row
 * the normalizer already built, under the same session lock the other
 * ros_messages writers use.
 */
import { createHash } from 'node:crypto'

export interface GrokbotIngestMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  createdAt?: Date | string
  toolCalls?: Array<{ id?: string; name: string; input?: unknown }>
  ordinal?: number
  event_id?: string
  eventId?: string
  metadata?: Record<string, unknown>
  toolResult?: string
}

export interface GrokbotIngestInput {
  sessionId: string
  messages: GrokbotIngestMessage[]
  source?: string
  agent?: string
  persona?: string
  channel?: string
}

export interface GrokbotIngestResult {
  session_id: string
  ingested: number
  skipped: number
  ids: string[]
  source: string
  agent: string
  channel: string
  persona?: string
  truncated?: boolean
  full_content_length?: number
}

interface QueryClient {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: Array<{ ordinal?: string | null; event_id?: string | null }> }>
  release?: () => void
}

interface PoolLike {
  connect: () => Promise<QueryClient>
}

export interface GrokbotIngestMemory {
  append(
    entry: {
      sessionId: string
      agent: string
      channel: string
      role: GrokbotIngestMessage['role']
      content: string
      toolName?: string
      toolArgs?: Record<string, unknown>
      toolResult?: string
      metadata?: Record<string, unknown>
      createdAt?: Date
    },
    options?: { client?: QueryClient },
  ): Promise<string>
  getPool(): PoolLike
}

function asFiniteInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number.parseInt(value, 10)
    if (!Number.isNaN(n)) return n
  }
  return undefined
}

function resolveOrdinal(item: GrokbotIngestMessage, index: number): number {
  return asFiniteInt(item.ordinal) ?? asFiniteInt(item.metadata?.ordinal) ?? index
}

function resolveEventId(item: GrokbotIngestMessage): string | undefined {
  if (typeof item.event_id === 'string' && item.event_id.trim()) return item.event_id.trim()
  if (typeof item.eventId === 'string' && item.eventId.trim()) return item.eventId.trim()
  const fromMeta = item.metadata?.event_id
  if (typeof fromMeta === 'string' && fromMeta.trim()) return fromMeta.trim()
  return undefined
}

function fallbackEventId(parts: {
  sessionId: string
  agent: string
  role: string
  content: string
  ordinal: number
  toolName?: string
}): string {
  const material = [
    parts.sessionId,
    parts.agent,
    parts.role,
    parts.content,
    String(parts.ordinal),
    parts.toolName ?? '',
  ].join('\0')
  return createHash('sha256').update(material, 'utf8').digest('hex')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export async function ingestGrokbotSession(
  memory: GrokbotIngestMemory,
  input: GrokbotIngestInput,
): Promise<GrokbotIngestResult> {
  const source = (input.source ?? process.env.RIVETOS_MEMORY_SOURCE ?? 'grokbot').trim()
  const agent = (input.agent ?? process.env.RIVETOS_MEMORY_AGENT ?? 'rivet-grokbot').trim()
  const channel = (input.channel ?? process.env.RIVETOS_MEMORY_CHANNEL ?? 'grokbot').trim()
  const persona = (input.persona ?? process.env.RIVETOS_MEMORY_PERSONA ?? '').trim()

  const client = await memory.getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [input.sessionId])
    const existing = await client.query(
      `SELECT m.metadata->>'ordinal' AS ordinal,
              m.metadata->>'event_id' AS event_id
         FROM ros_messages m
         JOIN ros_conversations c ON c.id = m.conversation_id
        WHERE c.session_key = $1 AND c.agent = $2`,
      [input.sessionId, agent],
    )
    const seenOrdinals = new Set<number>()
    const seenEventIds = new Set<string>()
    for (const row of existing.rows) {
      if (row.ordinal != null) {
        const n = Number.parseInt(row.ordinal, 10)
        if (!Number.isNaN(n)) seenOrdinals.add(n)
      }
      if (row.event_id) seenEventIds.add(row.event_id)
    }

    const ids: string[] = []
    let skipped = 0
    let anyTruncated = false
    let maxFullLength: number | undefined

    for (const [index, item] of input.messages.entries()) {
      const toolCalls = item.toolCalls
      const toolResult = typeof item.toolResult === 'string' ? item.toolResult : undefined
      const ordinal = resolveOrdinal(item, index)
      if (!item.content && !toolResult && (!toolCalls || toolCalls.length === 0)) {
        skipped += 1
        continue
      }

      const primary = toolCalls?.[0]
      const toolName = primary?.name
      const eventId =
        resolveEventId(item) ??
        fallbackEventId({
          sessionId: input.sessionId,
          agent,
          role: item.role,
          content: item.content || toolResult || '',
          ordinal,
          toolName,
        })

      if (seenEventIds.has(eventId)) {
        skipped += 1
        seenOrdinals.add(ordinal)
        continue
      }
      if (seenOrdinals.has(ordinal)) {
        console.warn(
          `[grokbot ingest] Ordinal ${String(ordinal)} already exists in session ${input.sessionId} but event_id differs. Skipping to preserve existing data.`,
        )
        skipped += 1
        continue
      }

      let createdAt: Date | undefined
      if (item.createdAt) {
        const candidate = new Date(item.createdAt)
        if (Number.isNaN(candidate.getTime())) {
          console.warn(
            `[grokbot ingest] Invalid createdAt for message ${String(ordinal)} in session ${input.sessionId}: ${String(item.createdAt)}`,
          )
          skipped += 1
          continue
        }
        createdAt = candidate
      }

      const metadata: Record<string, unknown> = { ...(item.metadata ?? {}) }
      if (typeof metadata.source === 'string' && metadata.source && metadata.source !== source) {
        metadata.capture_source = metadata.source
      }
      metadata.source = source
      metadata.ordinal = ordinal
      metadata.event_id = eventId
      if (persona) metadata.persona = persona
      if (toolCalls && toolCalls.length > 0) metadata.tool_calls = toolCalls

      const content = item.content
      const storedToolResult = toolResult
      if (metadata.truncated === true) anyTruncated = true
      if (typeof metadata.full_content_length === 'number') {
        maxFullLength = Math.max(maxFullLength ?? 0, metadata.full_content_length)
      }

      const id = await memory.append(
        {
          sessionId: input.sessionId,
          agent,
          channel,
          role: item.role,
          content,
          toolName,
          toolArgs: isRecord(primary?.input) ? primary.input : undefined,
          toolResult: storedToolResult,
          metadata,
          createdAt,
        },
        { client },
      )
      ids.push(id)
      seenOrdinals.add(ordinal)
      seenEventIds.add(eventId)
    }

    await client.query('COMMIT')
    const result: GrokbotIngestResult = {
      session_id: input.sessionId,
      ingested: ids.length,
      skipped,
      ids,
      source,
      agent,
      channel,
    }
    if (persona) result.persona = persona
    if (anyTruncated) {
      result.truncated = true
      if (maxFullLength !== undefined) result.full_content_length = maxFullLength
    }
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release?.()
  }
}
