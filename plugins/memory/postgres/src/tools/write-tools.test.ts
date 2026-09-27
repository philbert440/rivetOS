import { describe, expect, it, afterEach, vi } from 'vitest'
import type { PostgresMemory } from '../adapter.js'
import {
  appendEventId,
  ingestEventId,
  resolveMemoryWriteTags,
  truncateContent,
  ingestSession,
} from './write-tools.js'

const MAX_CONTENT = 16000
const TRUNCATION_MARKER = '\n…[truncated]'

describe('memory write helpers', () => {
  afterEach(() => {
    delete process.env.RIVETOS_MEMORY_SOURCE
    delete process.env.RIVETOS_MEMORY_AGENT
    delete process.env.RIVETOS_MEMORY_PERSONA
    delete process.env.RIVETOS_MEMORY_CHANNEL
  })

  it('ingestEventId includes ordinal so repeated text does not collapse', () => {
    const base = {
      sessionId: 's',
      agent: 'a',
      role: 'user',
      content: 'ok',
    }
    const first = ingestEventId({ ...base, ordinal: 0 })
    const second = ingestEventId({ ...base, ordinal: 1 })
    expect(first).not.toBe(second)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
  })

  it('appendEventId is a different domain from ingestEventId', () => {
    const ingest = ingestEventId({
      sessionId: 's',
      agent: 'a',
      role: 'user',
      content: 'test',
      ordinal: 0,
    })
    const append = appendEventId({
      sessionId: 's',
      agent: 'a',
      role: 'user',
      content: 'test',
    })
    expect(append).not.toBe(ingest)
  })

  it('truncateContent records the original length and skips an already-marked tail', () => {
    const metadata: Record<string, unknown> = {}
    const out = truncateContent('x'.repeat(MAX_CONTENT + 20), metadata)
    expect(out.endsWith(TRUNCATION_MARKER)).toBe(true)
    expect(out.length).toBe(MAX_CONTENT + TRUNCATION_MARKER.length)
    expect(metadata.full_content_length).toBe(MAX_CONTENT + 20)
    expect(metadata.truncated).toBe(true)

    const again = truncateContent(out, {})
    expect(again).toBe(out)
  })

  it('resolveMemoryWriteTags prefers args over env', () => {
    process.env.RIVETOS_MEMORY_SOURCE = 'env-source'
    process.env.RIVETOS_MEMORY_AGENT = 'env-agent'
    expect(resolveMemoryWriteTags({ source: 'arg-source' })).toEqual({
      source: 'arg-source',
      agent: 'env-agent',
      channel: 'mcp',
    })
  })
})

describe('shared ingest transaction', () => {
  it('preserves item.metadata and honors item.ordinal / event_id', async () => {
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes('AS ordinal') ? [] : [],
    }))
    const release = vi.fn()
    const client = { query, release }
    const append = vi.fn(async () => 'new-id')
    const memory = {
      getPool: () => ({ connect: async () => client }),
      append,
    } as unknown as PostgresMemory
    const result = await ingestSession(memory, {
      sessionId: 'grokbot-rivet-grokbot-v3',
      agent: 'rivet-grokbot',
      persona: 'Rivet',
      source: 'grokbot',
      channel: 'grokbot',
      messages: [
        {
          role: 'system',
          content: '[grokbot.agent_message] Told Philip.',
          createdAt: '2026-09-27T20:06:00.000Z',
          ordinal: 1880_000,
          event_id: 'capture-core-event-id',
          metadata: {
            channel: 'grokbot',
            source: 'grokbot-transcript',
            agent_id: '6a155e75-0dd5-4c8a-8391-994878ed683a',
            kind: 'agent_message',
            from_agent: 'Bob',
            from_agent_id: '00df02ea-4f5f-4d3e-945a-864e1c9c78dc',
            position: 1880,
            ordinal: 1880_000,
            truncated: true,
            full_tool_result_length: 20_000,
          },
        },
      ],
    })
    expect(result).toMatchObject({ ingested: 1, skipped: 0, ids: ['new-id'] })
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          agent_id: '6a155e75-0dd5-4c8a-8391-994878ed683a',
          kind: 'agent_message',
          from_agent: 'Bob',
          from_agent_id: '00df02ea-4f5f-4d3e-945a-864e1c9c78dc',
          position: 1880,
          truncated: true,
          full_tool_result_length: 20_000,
          ordinal: 1880_000,
          event_id: 'capture-core-event-id',
          source: 'grokbot',
          persona: 'Rivet',
        }),
      }),
      { client },
    )
  })

  it('dedupes by caller event_id across overlapping page order', async () => {
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes('AS ordinal') ? [{ ordinal: '1000', event_id: 'same-event' }] : [],
    }))
    const release = vi.fn()
    const client = { query, release }
    const append = vi.fn(async () => 'should-not-run')
    const memory = {
      getPool: () => ({ connect: async () => client }),
      append,
    } as unknown as PostgresMemory
    const result = await ingestSession(memory, {
      sessionId: 'session',
      agent: 'rivet',
      messages: [
        {
          role: 'user',
          content: 'hello',
          ordinal: 5000,
          event_id: 'same-event',
          metadata: { position: 5, ordinal: 5000 },
        },
      ],
    })
    expect(result.ingested).toBe(0)
    expect(result.skipped).toBe(1)
    expect(append).not.toHaveBeenCalled()
  })

  it('rows without ordinal/event_id/metadata keep array-index ordinal and ingestEventId', async () => {
    const query = vi.fn(async () => ({ rows: [] }))
    const release = vi.fn()
    const client = { query, release }
    const append = vi.fn(async () => 'new-id')
    const memory = {
      getPool: () => ({ connect: async () => client }),
      append,
    } as unknown as PostgresMemory
    const result = await ingestSession(memory, {
      sessionId: 'session',
      agent: 'rivet',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'world' },
      ],
    })
    expect(result.ingested).toBe(2)
    const firstId = ingestEventId({
      sessionId: 'session',
      agent: 'rivet',
      role: 'user',
      content: 'hello',
      ordinal: 0,
    })
    const secondId = ingestEventId({
      sessionId: 'session',
      agent: 'rivet',
      role: 'assistant',
      content: 'world',
      ordinal: 1,
    })
    expect(append).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        content: 'hello',
        metadata: expect.objectContaining({ ordinal: 0, event_id: firstId }),
      }),
      { client },
    )
    expect(append).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        content: 'world',
        metadata: expect.objectContaining({ ordinal: 1, event_id: secondId }),
      }),
      { client },
    )
  })

  it('keeps MCP ordinal dedupe and appends on the locked client', async () => {
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes('AS ordinal') ? [{ ordinal: '0', event_id: 'old' }] : [],
    }))
    const release = vi.fn()
    const client = { query, release }
    const append = vi.fn(async () => 'new-id')
    const memory = {
      getPool: () => ({ connect: async () => client }),
      append,
    } as unknown as PostgresMemory
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const result = await ingestSession(memory, {
        sessionId: 'session',
        agent: 'rivet',
        messages: [
          { role: 'user', content: 'old text' },
          { role: 'assistant', content: 'new text' },
        ],
      })
      expect(result).toMatchObject({ ingested: 1, skipped: 1, ids: ['new-id'] })
      expect(append).toHaveBeenCalledWith(expect.objectContaining({ content: 'new text' }), {
        client,
      })
      expect(query.mock.calls.map(([sql]) => sql).slice(0, 2)).toEqual([
        'BEGIN',
        'SELECT pg_advisory_xact_lock(hashtext($1))',
      ])
      expect(query.mock.calls.at(-1)).toEqual(['COMMIT'])
      expect(release).toHaveBeenCalledOnce()
    } finally {
      warn.mockRestore()
    }
  })
})
