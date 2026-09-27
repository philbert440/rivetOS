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
