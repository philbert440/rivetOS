import { describe, expect, it, vi } from 'vitest'
import { ingestGrokbotSession, type GrokbotIngestMemory } from '../src/ingest-rows.js'

function fakeMemory(existing: Array<{ ordinal: string | null; event_id: string | null }> = []) {
  const appended: Array<Record<string, unknown>> = []
  const client = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("metadata->>'ordinal'")) return { rows: existing }
      return { rows: [] }
    }),
    release: vi.fn(),
  }
  const memory: GrokbotIngestMemory = {
    getPool: () => ({
      connect: () => Promise.resolve(client),
    }),
    append: (entry) => {
      appended.push(entry as unknown as Record<string, unknown>)
      return Promise.resolve(`id-${String(appended.length)}`)
    },
  }
  return { memory, appended, client }
}

describe('ingestGrokbotSession', () => {
  it('stores the normalizer ordinal, event id, tool result, and capture source', async () => {
    const { memory, appended, client } = fakeMemory()
    const result = await ingestGrokbotSession(memory, {
      sessionId: 'grokbot-rivet-grokbot-v3',
      agent: 'rivet-grokbot',
      persona: 'Rivet',
      source: 'grokbot',
      channel: 'grokbot',
      messages: [
        {
          role: 'tool',
          content: '',
          ordinal: 4000,
          event_id: 'evt-1',
          toolResult: 'diff',
          toolCalls: [{ name: 'shell', input: { command: 'git diff' } }],
          metadata: { source: 'grokbot-transcript', position: 4 },
          createdAt: '2026-09-27T20:06:00.000Z',
        },
      ],
    })

    expect(result).toMatchObject({
      session_id: 'grokbot-rivet-grokbot-v3',
      ingested: 1,
      skipped: 0,
      agent: 'rivet-grokbot',
      persona: 'Rivet',
    })
    expect(appended[0]).toMatchObject({
      content: '',
      toolName: 'shell',
      toolResult: 'diff',
      toolArgs: { command: 'git diff' },
      metadata: {
        source: 'grokbot',
        capture_source: 'grokbot-transcript',
        ordinal: 4000,
        event_id: 'evt-1',
        position: 4,
        persona: 'Rivet',
      },
    })
    expect(client.query).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock(hashtext($1))', [
      'grokbot-rivet-grokbot-v3',
    ])
    expect(client.query).toHaveBeenCalledWith('COMMIT')
  })

  it('skips a repeated event id and an ordinal that already belongs to another id', async () => {
    const { memory, appended } = fakeMemory([
      { ordinal: '1', event_id: 'evt-old' },
      { ordinal: '2', event_id: 'evt-keep' },
    ])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const result = await ingestGrokbotSession(memory, {
      sessionId: 's',
      agent: 'rivet-grokbot',
      messages: [
        { role: 'user', content: 'again', ordinal: 9, event_id: 'evt-keep' },
        { role: 'user', content: 'clash', ordinal: 1, event_id: 'evt-new' },
        { role: 'user', content: 'fresh', ordinal: 3, event_id: 'evt-fresh' },
      ],
    })
    warn.mockRestore()
    expect(result.ingested).toBe(1)
    expect(result.skipped).toBe(2)
    expect(appended.map((row) => row.content)).toEqual(['fresh'])
  })
})
