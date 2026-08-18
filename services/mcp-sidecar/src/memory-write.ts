import type { Tool } from '@rivetos/types'
import type { PostgresMemory } from '@rivetos/memory-postgres'
import { z } from 'zod'
import type { ToolRegistration } from '@rivetos/mcp'
import { adaptRivetTool } from '@rivetos/mcp'

export interface MemoryWriteTags {
  source: string
  agent: string
  channel: string
  persona?: string
}

export interface IngestMessage {
  role?: 'user' | 'assistant' | 'system' | 'tool'
  content: string
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
  content: z.string().min(1).describe('Message text'),
  role: roleSchema.optional(),
  agent: z.string().optional(),
  persona: z.string().optional(),
  source: z.string().optional(),
  channel: z.string().optional(),
} satisfies z.ZodRawShape

export const memoryIngestSessionInputSchema = {
  session_id: z.string().min(1),
  messages: z
    .array(
      z.object({
        role: roleSchema.optional(),
        content: z.string().min(1),
      }),
    )
    .min(1),
  agent: z.string().optional(),
  persona: z.string().optional(),
  source: z.string().optional(),
  channel: z.string().optional(),
} satisfies z.ZodRawShape

async function existingOrdinals(
  memory: PostgresMemory,
  sessionId: string,
  agent: string,
): Promise<Set<number>> {
  const result = await memory.getPool().query<{ ordinal: string | null }>(
    `SELECT m.metadata->>'ordinal' AS ordinal
       FROM ros_messages m
       JOIN ros_conversations c ON c.id = m.conversation_id
      WHERE c.session_key = $1 AND c.agent = $2`,
    [sessionId, agent],
  )
  const found = new Set<number>()
  for (const row of result.rows) {
    if (row.ordinal == null) continue
    const n = Number.parseInt(row.ordinal, 10)
    if (!Number.isNaN(n)) found.add(n)
  }
  return found
}

export async function ingestSession(
  memory: PostgresMemory,
  input: IngestSessionInput,
): Promise<{
  session_id: string
  ingested: number
  skipped: number
  ids: string[]
} & MemoryWriteTags> {
  const tags = resolveMemoryWriteTags({
    source: input.source,
    agent: input.agent,
    persona: input.persona,
    channel: input.channel,
  })
  const seen = await existingOrdinals(memory, input.sessionId, tags.agent)
  const ids: string[] = []
  let skipped = 0
  for (const [i, item] of input.messages.entries()) {
    if (seen.has(i)) {
      skipped += 1
      continue
    }
    const role = item.role ?? 'assistant'
    const content = item.content
    if (!content) {
      skipped += 1
      continue
    }
    const metadata: Record<string, unknown> = { source: tags.source, ordinal: i }
    if (tags.persona) metadata.persona = tags.persona
    ids.push(
      await memory.append({
        sessionId: input.sessionId,
        agent: tags.agent,
        channel: tags.channel,
        role,
        content,
        metadata,
      }),
    )
    seen.add(i)
  }
  return {
    session_id: input.sessionId,
    ingested: ids.length,
    skipped,
    ids,
    ...tags,
  }
}

export function createMemoryWriteTools(
  memory: PostgresMemory,
  prefix = '',
): ToolRegistration[] {
  const appendTool: Tool = {
    name: 'memory_append',
    description:
      'Append one message to RivetOS memory. Tags source/agent/persona from args or env.',
    parameters: {},
    async execute(args) {
      const sessionId = asString(args.session_id).trim()
      const content = asString(args.content)
      const role = asString(args.role) || 'assistant'
      if (!sessionId) throw new Error('memory_append: session_id is required')
      if (!content) throw new Error('memory_append: content is required')
      if (!['user', 'assistant', 'system', 'tool'].includes(role)) {
        throw new Error('memory_append: role must be user|assistant|system|tool')
      }
      const tags = tagsFromArgs(args)
      const metadata: Record<string, unknown> = { source: tags.source }
      if (tags.persona) metadata.persona = tags.persona
      const id = await memory.append({
        sessionId,
        agent: tags.agent,
        channel: tags.channel,
        role: role as 'user' | 'assistant' | 'system' | 'tool',
        content,
        metadata,
      })
      return JSON.stringify({ id, session_id: sessionId, ...tags })
    },
  }

  const ingestTool: Tool = {
    name: 'memory_ingest_session',
    description:
      'Ingest a session into RivetOS memory. Skips ordinals already stored for that session.',
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
        const role = asString(rec.role) || 'assistant'
        const content = asString(rec.content)
        if (!['user', 'assistant', 'system', 'tool'].includes(role)) {
          throw new Error('memory_ingest_session: invalid role')
        }
        messages.push({
          role: role as IngestMessage['role'],
          content,
        })
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
      annotations: { readOnlyHint: false, idempotentHint: false },
    }),
    adaptRivetTool(ingestTool, memoryIngestSessionInputSchema, {
      name: `${prefix}memory_ingest_session`,
      annotations: { readOnlyHint: false, idempotentHint: true },
    }),
  ]
}
