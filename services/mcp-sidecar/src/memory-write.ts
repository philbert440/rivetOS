import type { Tool } from '@rivetos/types'
import type { PostgresMemory } from '@rivetos/memory-postgres'
import { z } from 'zod'
import type { ToolRegistration } from '@rivetos/mcp'
import { adaptRivetTool } from '@rivetos/mcp'
import crypto from 'node:crypto'
import type { PoolClient } from 'pg'

const MAX_CONTENT = 16000 // keep in sync with integrations/grok/rivet-memory/capture
const TRUNCATION_MARKER = '\n…[truncated]'

export interface MemoryWriteTags {
  source: string
  agent: string
  channel: string
  persona?: string
}

export interface IngestMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  createdAt?: Date | string
}

export interface IngestSessionInput {
  sessionId: string
  messages: IngestMessage[]
  source?: string
  agent?: string
  persona?: string
  channel?: string
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * Truncate content to MAX_CONTENT chars, recording original length in metadata.
 * Matches the pattern from integrations/grok/rivet-memory/capture. Exported for testing.
 *
 * Skips truncation when content already ends with TRUNCATION_MARKER to avoid
 * double-truncation on re-ingest (a stored truncated row is up to 16,013 units).
 *
 * Backs off one unit if we'd split a UTF-16 high surrogate (0xD800–0xDBFF).
 * Low surrogates (0xDC00–0xDFFF) are the second half of a complete pair, so
 * backing off there would incorrectly split the pair.
 */
export function truncateContent(
  content: string,
  metadata: Record<string, unknown>,
  fieldPrefix = '',
): string {
  if (content.length <= MAX_CONTENT) return content
  // Skip if already truncated (e.g. re-ingest from DB)
  if (content.endsWith(TRUNCATION_MARKER)) {
    // Preserve existing full_content_length if present
    return content
  }
  const fullLengthKey = fieldPrefix ? `full_${fieldPrefix}_length` : 'full_content_length'
  metadata[fullLengthKey] = content.length
  metadata.truncated = true
  let cutAt = MAX_CONTENT
  // Back off one unit if we'd split a UTF-16 high surrogate (0xD800–0xDBFF).
  const charCode = content.charCodeAt(cutAt - 1)
  if (charCode >= 0xd800 && charCode <= 0xdbff) {
    cutAt -= 1
  }
  return content.slice(0, cutAt) + TRUNCATION_MARKER
}

/**
 * Content-hash event_id for memory_ingest_session.
 *
 * Includes ordinal to prevent data loss: repeated identical lines ("ok" twice)
 * must hash differently. Without ordinal in the hash, the second "ok" would be
 * skipped forever.
 */
export function ingestEventId(parts: {
  sessionId: string
  agent: string
  role: string
  content: string
  ordinal: number
  toolName?: string | null
}): string {
  const material = [
    parts.sessionId,
    parts.agent,
    parts.role,
    parts.content,
    String(parts.ordinal),
    parts.toolName ?? '',
  ].join('\0')
  return crypto.createHash('sha256').update(material, 'utf8').digest('hex')
}

/**
 * Content-hash event_id for memory_append.
 *
 * Does NOT include ordinal — collapsing identical repeated append calls is OK
 * (idempotent single-message writes). Hash domain differs from ingest so an
 * ingested row never blocks a later legitimate append of the same text.
 */
export function appendEventId(parts: {
  sessionId: string
  agent: string
  role: string
  content: string
  toolName?: string | null
}): string {
  const material = [
    'append', // domain separator
    parts.sessionId,
    parts.agent,
    parts.role,
    parts.content,
    parts.toolName ?? '',
  ].join('\0')
  return crypto.createHash('sha256').update(material, 'utf8').digest('hex')
}

export function resolveMemoryWriteTags(input: {
  source?: string
  agent?: string
  persona?: string
  channel?: string
}): MemoryWriteTags {
  const source = (input.source ?? process.env.RIVETOS_MEMORY_SOURCE ?? 'mcp').trim()
  const agent = (input.agent ?? process.env.RIVETOS_MEMORY_AGENT ?? 'mcp').trim()
  const channel = (input.channel ?? process.env.RIVETOS_MEMORY_CHANNEL ?? 'mcp').trim()
  const persona = (input.persona ?? process.env.RIVETOS_MEMORY_PERSONA ?? '').trim()
  const tags: MemoryWriteTags = { source, agent, channel }
  if (persona) tags.persona = persona
  return tags
}

function tagsFromArgs(args: Record<string, unknown>): MemoryWriteTags {
  return resolveMemoryWriteTags({
    source: typeof args.source === 'string' ? args.source : undefined,
    agent: typeof args.agent === 'string' ? args.agent : undefined,
    persona: typeof args.persona === 'string' ? args.persona : undefined,
    channel: typeof args.channel === 'string' ? args.channel : undefined,
  })
}

const roleSchema = z.enum(['user', 'assistant', 'system', 'tool'])

export const memoryAppendInputSchema = {
  session_id: z.string().min(1).describe('Session / conversation key to append to'),
  content: z
    .string()
    .describe(
      'Message text (may be empty for tool-call messages with tool_name). Content longer than 16,000 chars is truncated; the elided tail is unrecoverable.',
    ),
  role: roleSchema.describe('Message role — user, assistant, system, or tool'),
  tool_name: z.string().optional().describe('Tool name (for assistant tool-call messages)'),
  tool_args: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Tool arguments as JSON object (for assistant tool-call messages)'),
  tool_result: z
    .string()
    .optional()
    .describe(
      'Tool result (for tool-role messages). Results longer than 16,000 chars are truncated; the elided tail is unrecoverable.',
    ),
  event_id: z.string().optional().describe('Optional idempotency key — skip if already present'),
  agent: z.string().optional(),
  persona: z.string().optional(),
  source: z.string().optional(),
  channel: z.string().optional(),
} satisfies z.ZodRawShape

// TODO: memory_ingest_session messages still can't carry tool fields
// (tool_name/tool_args/tool_result) — memory_append has them; extend for parity.
export const memoryIngestSessionInputSchema = {
  session_id: z.string().min(1),
  messages: z
    .array(
      z.object({
        role: roleSchema,
        content: z
          .string()
          .min(1)
          .describe(
            'Message text. Content longer than 16,000 chars is truncated; the elided tail is unrecoverable.',
          ),
        // Wire schema: ISO string only — Date objects cannot cross JSON-RPC and
        // z.date() is not representable in JSON Schema (breaks tools/list).
        created_at: z.iso.datetime({ offset: true }).optional(),
      }),
    )
    .min(1),
  agent: z.string().optional(),
  persona: z.string().optional(),
  source: z.string().optional(),
  channel: z.string().optional(),
} satisfies z.ZodRawShape

/**
 * Fetch both existing ordinals and event_ids in a single query (performance).
 * Avoids N queries on unindexed metadata->>'event_id' per message.
 */
async function existingOrdinalsAndEventIds(
  client: PoolClient,
  sessionId: string,
  agent: string,
): Promise<{ ordinals: Set<number>; eventIds: Set<string> }> {
  const result = await client.query<{ ordinal: string | null; event_id: string | null }>(
    `SELECT m.metadata->>'ordinal' AS ordinal,
            m.metadata->>'event_id' AS event_id
       FROM ros_messages m
       JOIN ros_conversations c ON c.id = m.conversation_id
      WHERE c.session_key = $1 AND c.agent = $2`,
    [sessionId, agent],
  )
  const ordinals = new Set<number>()
  const eventIds = new Set<string>()
  for (const row of result.rows) {
    if (row.ordinal != null) {
      const n = Number.parseInt(row.ordinal, 10)
      if (!Number.isNaN(n)) ordinals.add(n)
    }
    if (row.event_id != null) {
      eventIds.add(row.event_id)
    }
  }
  return { ordinals, eventIds }
}

export async function ingestSession(
  memory: PostgresMemory,
  input: IngestSessionInput,
): Promise<
  {
    session_id: string
    ingested: number
    skipped: number
    ids: string[]
    truncated?: boolean
    full_content_length?: number
  } & MemoryWriteTags
> {
  const tags = resolveMemoryWriteTags({
    source: input.source,
    agent: input.agent,
    persona: input.persona,
    channel: input.channel,
  })

  const pool = memory.getPool()
  const client = await pool.connect()

  try {
    // Advisory lock + transaction for concurrent-ingest safety (grok/kimi pattern)
    await client.query('BEGIN')
    // CONVENTION (load-bearing): every ros_messages writer — grok/kimi capture
    // workers and both sidecar write tools — takes pg_advisory_xact_lock on
    // hashtext(session_key) before check-then-insert. New writers MUST too.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [input.sessionId])

    // Fetch existing ordinals and event_ids once (performance: single query)
    const { ordinals: seenOrdinals, eventIds: seenEventIds } = await existingOrdinalsAndEventIds(
      client,
      input.sessionId,
      tags.agent,
    )

    const ids: string[] = []
    let skipped = 0
    let anyTruncated = false
    let maxFullLength: number | undefined

    for (const [i, item] of input.messages.entries()) {
      const role = item.role
      const content = item.content
      if (!content) {
        skipped += 1
        continue
      }

      // Ingest-domain event_id includes ordinal (prevents data loss on repeated text)
      // Hash the PRE-truncation content so retry of oversized payload dedupes correctly
      const eventId = ingestEventId({
        sessionId: input.sessionId,
        agent: tags.agent,
        role,
        content, // pre-truncation
        ordinal: i,
      })

      // C2/H2: Check event_id FIRST, then ordinal. Allows session extension with
      // new event_id even if ordinal is taken (rewritten history).
      if (seenEventIds.has(eventId)) {
        skipped += 1
        seenOrdinals.add(i)
        continue
      }

      if (seenOrdinals.has(i)) {
        // H2: Ordinal is taken but event_id differs — likely rewritten session head.
        // Warn and skip to preserve existing data.
        console.warn(
          `[ingestSession] Ordinal ${i} already exists in session ${input.sessionId} but event_id differs. Skipping to preserve existing data.`,
        )
        skipped += 1
        continue
      }

      const metadata: Record<string, unknown> = {
        source: tags.source,
        ordinal: i,
        event_id: eventId,
      }
      if (tags.persona) metadata.persona = tags.persona

      // Truncate content after hashing
      const truncatedContent = truncateContent(content, metadata)
      if (metadata.truncated) anyTruncated = true
      if (metadata.full_content_length) {
        maxFullLength = Math.max(maxFullLength ?? 0, metadata.full_content_length as number)
      }

      // Guard against invalid dates: schema validates ISO strings, but runtime
      // Date objects or edge cases could still produce Invalid Date. Skip rather
      // than poison the entire ingest mid-loop.
      let createdAt: Date | undefined
      if (item.createdAt) {
        const candidate = new Date(item.createdAt)
        if (Number.isNaN(candidate.getTime())) {
          console.warn(
            `[ingestSession] Invalid createdAt for message ${i} in session ${input.sessionId}: ${String(item.createdAt)}`,
          )
          skipped += 1
          continue
        }
        createdAt = candidate
      }

      // Append using the locked client (avoids self-deadlock, makes ROLLBACK real)
      const id = await memory.append(
        {
          sessionId: input.sessionId,
          agent: tags.agent,
          channel: tags.channel,
          role,
          content: truncatedContent,
          metadata,
          createdAt,
        },
        { client },
      )

      ids.push(id)
      seenOrdinals.add(i)
      seenEventIds.add(eventId)
    }

    await client.query('COMMIT')

    const result: {
      session_id: string
      ingested: number
      skipped: number
      ids: string[]
      truncated?: boolean
      full_content_length?: number
    } & MemoryWriteTags = {
      session_id: input.sessionId,
      ingested: ids.length,
      skipped,
      ids,
      ...tags,
    }

    if (anyTruncated) {
      result.truncated = true
      if (maxFullLength) result.full_content_length = maxFullLength
    }

    return result
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

export function createMemoryWriteTools(memory: PostgresMemory, prefix = ''): ToolRegistration[] {
  const appendTool: Tool = {
    name: 'memory_append',
    description:
      'Append one message to RivetOS memory. Tags source/agent/persona from args or env. Optional event_id for idempotency. Content and tool_result are capped at 16,000 chars; the elided tail is unrecoverable. Returns truncated+full_content_length when truncation occurs.',
    parameters: {},
    async execute(args) {
      const sessionId = asString(args.session_id).trim()
      const content = asString(args.content)
      const role = asString(args.role)
      const toolName = typeof args.tool_name === 'string' ? args.tool_name : undefined
      // M1: Normalize empty or whitespace-only event_id to undefined
      const eventIdArg =
        typeof args.event_id === 'string' && args.event_id.trim() !== ''
          ? args.event_id.trim()
          : undefined

      if (!sessionId) throw new Error('memory_append: session_id is required')
      if (!role) throw new Error('memory_append: role is required')
      if (!['user', 'assistant', 'system', 'tool'].includes(role)) {
        throw new Error('memory_append: role must be user|assistant|system|tool')
      }
      if (!content && !toolName && role !== 'tool') {
        throw new Error(
          'memory_append: content is required (or provide tool_name for tool-call messages)',
        )
      }

      const tags = tagsFromArgs(args)

      // Append-domain event_id (no ordinal — collapsing identical appends is OK)
      // Hash the PRE-truncation content so retry of oversized payload dedupes correctly
      const eventId =
        eventIdArg ??
        appendEventId({
          sessionId,
          agent: tags.agent,
          role,
          content, // pre-truncation
          toolName,
        })

      // Advisory lock + check for existing event_id (idempotency)
      const pool = memory.getPool()
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        // Same lock convention as ingestSession — see comment there.
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [sessionId])

        // M2: Check if event_id exists and return existing row id on skip
        const existingResult = await client.query<{ id: string; event_id: string | null }>(
          `SELECT m.id, m.metadata->>'event_id' AS event_id
             FROM ros_messages m
             JOIN ros_conversations c ON c.id = m.conversation_id
            WHERE c.session_key = $1 AND c.agent = $2
              AND m.metadata->>'event_id' = $3
            LIMIT 1`,
          [sessionId, tags.agent, eventId],
        )

        if (existingResult.rows.length > 0) {
          await client.query('COMMIT')
          return JSON.stringify({
            skipped: true,
            id: existingResult.rows[0].id,
            event_id: eventId,
            session_id: sessionId,
            ...tags,
          })
        }

        const metadata: Record<string, unknown> = { source: tags.source, event_id: eventId }
        if (tags.persona) metadata.persona = tags.persona

        // Truncate content and tool_result after hashing
        const truncatedContent = truncateContent(content, metadata)

        const toolArgs =
          args.tool_args != null &&
          typeof args.tool_args === 'object' &&
          !Array.isArray(args.tool_args)
            ? (args.tool_args as Record<string, unknown>)
            : undefined
        const toolResult = typeof args.tool_result === 'string' ? args.tool_result : undefined
        const truncatedToolResult = toolResult
          ? truncateContent(toolResult, metadata, 'tool_result')
          : undefined

        // Append using the locked client (avoids self-deadlock, makes ROLLBACK real)
        const id = await memory.append(
          {
            sessionId,
            agent: tags.agent,
            channel: tags.channel,
            role: role as 'user' | 'assistant' | 'system' | 'tool',
            content: truncatedContent,
            toolName,
            toolArgs,
            toolResult: truncatedToolResult,
            metadata,
          },
          { client },
        )

        await client.query('COMMIT')

        const result: Record<string, unknown> = {
          id,
          event_id: eventId,
          session_id: sessionId,
          ...tags,
        }

        if (metadata.truncated) {
          result.truncated = true
          const contentLen = metadata.full_content_length as number | undefined
          const toolResultLen = metadata.full_tool_result_length as number | undefined
          if (contentLen || toolResultLen) {
            result.full_content_length = Math.max(contentLen ?? 0, toolResultLen ?? 0)
          }
        }

        return JSON.stringify(result)
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        client.release()
      }
    },
  }

  const ingestTool: Tool = {
    name: 'memory_ingest_session',
    description:
      'Ingest a session into RivetOS memory. Skips ordinals and event_ids already stored for that session. Content is capped at 16,000 chars; the elided tail is unrecoverable. Returns truncated+full_content_length when truncation occurs.',
    parameters: {},
    async execute(args) {
      const sessionId = asString(args.session_id).trim()
      if (!sessionId) throw new Error('memory_ingest_session: session_id is required')
      const raw = args.messages
      if (!Array.isArray(raw) || raw.length === 0) {
        throw new Error('memory_ingest_session: messages must be a non-empty array')
      }
      const messages: IngestMessage[] = []
      for (const item of raw) {
        if (!item || typeof item !== 'object') {
          throw new Error('memory_ingest_session: bad message')
        }
        const rec = item as Record<string, unknown>
        const role = asString(rec.role)
        const content = asString(rec.content)
        if (!role) {
          throw new Error('memory_ingest_session: role is required for each message')
        }
        if (!['user', 'assistant', 'system', 'tool'].includes(role)) {
          throw new Error('memory_ingest_session: invalid role')
        }
        const msg: IngestMessage = {
          role: role as IngestMessage['role'],
          content,
        }
        if (rec.created_at) {
          msg.createdAt = rec.created_at as Date | string
        }
        messages.push(msg)
      }
      const result = await ingestSession(memory, {
        sessionId,
        messages,
        source: typeof args.source === 'string' ? args.source : undefined,
        agent: typeof args.agent === 'string' ? args.agent : undefined,
        persona: typeof args.persona === 'string' ? args.persona : undefined,
        channel: typeof args.channel === 'string' ? args.channel : undefined,
      })
      return JSON.stringify(result)
    },
  }

  return [
    adaptRivetTool(appendTool, memoryAppendInputSchema, {
      name: `${prefix}memory_append`,
      annotations: { readOnlyHint: false, idempotentHint: true },
    }),
    adaptRivetTool(ingestTool, memoryIngestSessionInputSchema, {
      name: `${prefix}memory_ingest_session`,
      annotations: { readOnlyHint: false, idempotentHint: true },
    }),
  ]
}
