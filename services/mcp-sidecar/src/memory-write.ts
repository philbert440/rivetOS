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

export function resolveMemoryWriteTags(input: {
  source?: string
  agent?: string
  persona?: string
  channel?: string
}): MemoryWriteTags {
  const source = (input.source ?? process.env.RIVETOS_MEMORY_SOURCE ?? 'mcp').trim()
  const agent = (input.agent ?? process.env.RIVETOS_MEMORY_AGENT ?? 'grokbot').trim()
  const channel = (input.channel ?? process.env.RIVETOS_MEMORY_CHANNEL ?? 'grokbot').trim()
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

export const memoryAppendInputSchema = {
  session_id: z.string().min(1).describe('Session / conversation key to append to'),
  content: z.string().min(1).describe('Message text'),
  role: z.enum(['user', 'assistant', 'system', 'tool']).optional(),
  agent: z.string().optional(),
  persona: z.string().optional(),
  source: z.string().optional(),
  channel: z.string().optional(),
} satisfies z.ZodRawShape

export const memoryIngestSessionInputSchema = {
  session_id: z.string().min(1),
  messages: z
    .array(z.object({ role: z.enum(['user', 'assistant', 'system', 'tool']).optional(), content: z.string().min(1) }))
    .min(1),
  agent: z.string().optional(),
  persona: z.string().optional(),
  source: z.string().optional(),
  channel: z.string().optional(),
} satisfies z.ZodRawShape

export function createMemoryWriteTools(memory: PostgresMemory, prefix = ''): ToolRegistration[] {
  const appendTool: Tool = {
    name: 'memory_append',
    description: 'Append one message to RivetOS memory. Tags source/agent/persona (Grok Bot defaults source=grokbot).',
    parameters: {},
    async execute(args) {
      const sessionId = String(args.session_id ?? '').trim()
      const content = String(args.content ?? '')
      const role = String(args.role ?? 'assistant')
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
    description: 'Ingest a session (role/content messages) into RivetOS memory tagged source/agent/persona.',
    parameters: {},
    async execute(args) {
      const sessionId = String(args.session_id ?? '').trim()
      if (!sessionId) throw new Error('memory_ingest_session: session_id is required')
      const raw = args.messages
      if (!Array.isArray(raw) || raw.length === 0) {
        throw new Error('memory_ingest_session: messages must be a non-empty array')
      }
      const tags = tagsFromArgs(args)
      const ids: string[] = []
      for (const [i, item] of raw.entries()) {
        if (!item || typeof item !== 'object') throw new Error('memory_ingest_session: bad message')
        const rec = item as Record<string, unknown>
        const role = String(rec.role ?? 'assistant')
        const content = String(rec.content ?? '')
        if (!content) continue
        if (!['user', 'assistant', 'system', 'tool'].includes(role)) {
          throw new Error('memory_ingest_session: invalid role')
        }
        const metadata: Record<string, unknown> = { source: tags.source, ordinal: i }
        if (tags.persona) metadata.persona = tags.persona
        ids.push(
          await memory.append({
            sessionId,
            agent: tags.agent,
            channel: tags.channel,
            role: role as 'user' | 'assistant' | 'system' | 'tool',
            content,
            metadata,
          }),
        )
      }
      return JSON.stringify({ session_id: sessionId, ingested: ids.length, ids, ...tags })
    },
  }

  return [
    adaptRivetTool(appendTool, memoryAppendInputSchema, {
      name: `${prefix}memory_append`,
      annotations: { readOnlyHint: false, idempotentHint: false },
    }),
    adaptRivetTool(ingestTool, memoryIngestSessionInputSchema, {
      name: `${prefix}memory_ingest_session`,
      annotations: { readOnlyHint: false, idempotentHint: false },
    }),
  ]
}
