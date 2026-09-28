import { describe, expect, it, vi } from 'vitest'
import { ingestGrokbotSession, type GrokbotIngestMemory } from '../src/ingest-rows.js'
import { normalizeRecords, toIngestRows } from '../src/normalize.js'

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
      sessionId: 'grokbot-alpha-v3',
      agent: 'grokbot-alpha',
      persona: 'Alpha',
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
      session_id: 'grokbot-alpha-v3',
      ingested: 1,
      skipped: 0,
      agent: 'grokbot-alpha',
      persona: 'Alpha',
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
        persona: 'Alpha',
      },
    })
    expect(client.query).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock(hashtext($1))', [
      'grokbot-alpha-v3',
    ])
    expect(client.query).toHaveBeenCalledWith('COMMIT')
  })

  it('keeps a >4 KB message and large tool result end to end (normalize + ingest)', async () => {
    const { memory, appended } = fakeMemory()
    const longMsg = 'm'.repeat(5_000)
    const longTool = 't'.repeat(12_000)
    const { messages } = normalizeRecords(
      [
        { role: 'user', message: { content: [{ type: 'text', text: longMsg }] } },
        {
          role: 'tool',
          message: { content: [{ type: 'tool_result', name: 'shell', result: longTool }] },
        },
      ],
      { sessionKey: 'grokbot-alpha-v4', agent: 'grokbot-alpha' },
    )
    const rows = toIngestRows(messages)
    expect(rows[0]?.content.length).toBe(5_000)
    expect(rows[1]?.toolResult?.length).toBe(12_000)
    expect(rows.every((r) => r.metadata?.truncated !== true)).toBe(true)
    const result = await ingestGrokbotSession(memory, {
      sessionId: 'grokbot-alpha-v4',
      agent: 'grokbot-alpha',
      messages: rows,
    })
    expect(result.truncated).toBeUndefined()
    expect(result.truncated === true).toBe(false)
    expect(appended[0]?.content).toBe(longMsg)
    expect(appended[1]?.toolResult).toBe(longTool)
  })

  it('stores a >4 KB message and a large tool result without truncated: true', async () => {
    const { memory, appended } = fakeMemory()
    const longMsg = 'm'.repeat(5_000)
    const longTool = 't'.repeat(12_000)
    const result = await ingestGrokbotSession(memory, {
      sessionId: 'grokbot-alpha-v4',
      agent: 'grokbot-alpha',
      messages: [
        { role: 'user', content: longMsg, ordinal: 0, event_id: 'evt-big-user' },
        {
          role: 'tool',
          content: '',
          ordinal: 1000,
          event_id: 'evt-big-tool',
          toolResult: longTool,
          toolCalls: [{ name: 'shell', input: { command: 'cat big.txt' } }],
        },
      ],
    })
    expect(result.truncated).toBeUndefined()
    expect(appended[0]?.content).toBe(longMsg)
    expect(appended[1]?.toolResult).toBe(longTool)
    expect((appended[0]?.metadata as { truncated?: boolean } | undefined)?.truncated).toBeUndefined()
    expect((appended[1]?.metadata as { truncated?: boolean } | undefined)?.truncated).toBeUndefined()
  })

  it('skips a repeated event id and an ordinal that already belongs to another id', async () => {
    const { memory, appended } = fakeMemory([
      { ordinal: '1', event_id: 'evt-old' },
      { ordinal: '2', event_id: 'evt-keep' },
    ])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const result = await ingestGrokbotSession(memory, {
      sessionId: 's',
      agent: 'grokbot-alpha',
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
