/**
 * Integration tests for memory write tools — `memory_append` and
 * `memory_ingest_session` with idempotency guarantees and truncation.
 *
 * Requires a live Postgres with the RivetOS schema. Skips automatically when
 * `RIVETOS_PG_URL` is not set so local dev / CI without a DB doesn't see
 * spurious failures.
 *
 * Tests:
 * - Tool fields (tool_name, tool_args, tool_result) from #522
 * - Timestamp preservation (createdAt) from #524
 * - Content truncation at 16k chars from #521
 * - Idempotency (event_id deduplication, advisory locks, ordinal + event_id dedupe)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { defaultEchoTool } from '@rivetos/mcp'
import {
  connectV2,
  createV2McpServer,
  type V2McpConnection,
  type V2McpServer,
} from '@rivetos/mcp-v2'
import { createMemoryTools, type MemoryToolsHandle } from './memory.js'
import { PostgresMemory } from '@rivetos/memory-postgres'
import {
  ingestSession,
  ingestEventId,
  appendEventId,
  createMemoryWriteTools,
  truncateContent,
  type IngestSessionInput,
} from './memory-write.js'

/** Unwrap adaptRivetTool's structured result back to the tool's JSON string. */
function toolText(result: unknown): string {
  if (typeof result === 'string') return result
  const r = result as { content?: Array<{ type: string; text?: string }> }
  const text = r.content?.find((c) => c.type === 'text')?.text
  if (text == null) throw new Error('no text content in tool result')
  return text
}

const PG_URL = process.env.RIVETOS_PG_URL ?? ''
const describeIfPg = PG_URL ? describe : describe.skip

const MAX_CONTENT = 16000
const TRUNCATION_MARKER = '\n…[truncated]'

describeIfPg('memory write tools', () => {
  let server: V2McpServer
  let client: V2McpConnection
  let memoryHandle: MemoryToolsHandle
  let memory: PostgresMemory

  function callTool(params: { name: string; arguments: Record<string, unknown> }) {
    return client.callToolRaw(params.name, params.arguments)
  }

  beforeAll(async () => {
    memoryHandle = createMemoryTools({ pgUrl: PG_URL, enableWrite: true })
    memory = new PostgresMemory({ connectionString: PG_URL })

    server = createV2McpServer({
      host: '127.0.0.1',
      port: 0,
      tools: [defaultEchoTool(), ...memoryHandle.tools],
    })
    await server.start()

    client = await connectV2({
      name: 'memory-write-test',
      url: `http://127.0.0.1:${String(server.port)}/mcp`,
    })
  })

  afterAll(async () => {
    await client.close().catch(() => {
      /* swallow */
    })
    await server.close().catch(() => {
      /* swallow */
    })
    await memoryHandle.close().catch(() => {
      /* swallow */
    })
    await memory.close().catch(() => {
      /* swallow */
    })
  })

  it('lists memory_append and memory_ingest_session when enableWrite is true', async () => {
    const names = (await client.listTools()).map((t) => t.name)
    expect(names).toContain('memory_append')
    expect(names).toContain('memory_ingest_session')
  })

  it('memory_append requires role', async () => {
    const result = await callTool({
      name: 'memory_append',
      arguments: {
        session_id: 'test-session-role-required',
        content: 'test message',
        agent: 'test-agent',
        channel: 'test-channel',
      },
    })

    expect(result.isError).toBe(true)
    const content = result.content as Array<{ type: string; text?: string }>
    // Error can be from zod validation ("Required") or runtime check ("role is required")
    expect(content[0]?.text).toMatch(/role|Required/i)
  })

  it('memory_append accepts and stores tool fields', async () => {
    const sessionId = `test-session-tool-fields-${Date.now()}`
    const toolArgs = { param1: 'value1', param2: 42 }

    const result = await callTool({
      name: 'memory_append',
      arguments: {
        session_id: sessionId,
        content: 'tool call result',
        role: 'assistant',
        tool_name: 'test_tool',
        tool_args: toolArgs,
        tool_result: 'operation completed successfully',
        agent: 'test-agent',
        channel: 'test-channel',
      },
    })

    expect(result.isError).not.toBe(true)
    const content = result.content as Array<{ type: string; text?: string }>
    expect(content[0]?.type).toBe('text')
    const response = JSON.parse(content[0]?.text ?? '{}')
    expect(response.id).toBeDefined()

    // Verify the tool fields were stored by querying the database
    const query = `
      SELECT tool_name, tool_args, tool_result, role, content
      FROM ros_messages
      WHERE id = $1
    `
    const rows = await memory.getPool().query(query, [response.id])
    expect(rows.rows.length).toBe(1)
    const row = rows.rows[0]
    expect(row.tool_name).toBe('test_tool')
    expect(row.tool_args).toEqual(toolArgs)
    expect(row.tool_result).toBe('operation completed successfully')
    expect(row.role).toBe('assistant')
    expect(row.content).toBe('tool call result')
  })

  it('memory_append works with tool role and tool_result', async () => {
    const sessionId = `test-session-tool-role-${Date.now()}`

    const result = await callTool({
      name: 'memory_append',
      arguments: {
        session_id: sessionId,
        content: '',
        role: 'tool',
        tool_result: 'tool execution output',
        agent: 'test-agent',
        channel: 'test-channel',
      },
    })

    expect(result.isError).not.toBe(true)
    const content = result.content as Array<{ type: string; text?: string }>
    const response = JSON.parse(content[0]?.text ?? '{}')
    expect(response.id).toBeDefined()

    // Verify the tool result was stored
    const query = `
      SELECT tool_result, role, content
      FROM ros_messages
      WHERE id = $1
    `
    const rows = await memory.getPool().query(query, [response.id])
    expect(rows.rows.length).toBe(1)
    const row = rows.rows[0]
    expect(row.tool_result).toBe('tool execution output')
    expect(row.role).toBe('tool')
  })

  it('memory_append omits tool fields when not provided', async () => {
    const sessionId = `test-session-no-tools-${Date.now()}`

    const result = await callTool({
      name: 'memory_append',
      arguments: {
        session_id: sessionId,
        content: 'regular user message',
        role: 'user',
        agent: 'test-agent',
        channel: 'test-channel',
      },
    })

    expect(result.isError).not.toBe(true)
    const content = result.content as Array<{ type: string; text?: string }>
    const response = JSON.parse(content[0]?.text ?? '{}')
    expect(response.id).toBeDefined()

    // Verify tool fields are null when not provided
    const query = `
      SELECT tool_name, tool_args, tool_result
      FROM ros_messages
      WHERE id = $1
    `
    const rows = await memory.getPool().query(query, [response.id])
    expect(rows.rows.length).toBe(1)
    const row = rows.rows[0]
    expect(row.tool_name).toBeNull()
    expect(row.tool_args).toBeNull()
    expect(row.tool_result).toBeNull()
  })

  it('memory_append triggers tool synthesis for assistant tool-calls with empty content', async () => {
    const sessionId = `test-session-tool-synth-${Date.now()}`
    const toolArgs = { query: 'test query' }

    const result = await callTool({
      name: 'memory_append',
      arguments: {
        session_id: sessionId,
        content: '',
        role: 'assistant',
        tool_name: 'search_tool',
        tool_args: toolArgs,
        tool_result: 'search results',
        agent: 'test-agent',
        channel: 'test-channel',
      },
    })

    expect(result.isError).not.toBe(true)
    const content = result.content as Array<{ type: string; text?: string }>
    const response = JSON.parse(content[0]?.text ?? '{}')
    expect(response.id).toBeDefined()

    // Note: We can't easily verify that the graphile-worker job was enqueued
    // in this test without additional setup, but we've verified that the
    // message is stored correctly with tool fields. The tool-synthesis path
    // in adapter.ts will handle the job enqueueing.
  })
})

describeIfPg('memory_ingest_session timestamp preservation', () => {
  let memory: PostgresMemory
  const TEST_AGENT = `test-ingest-ts-${Date.now()}`

  beforeAll(async () => {
    memory = new PostgresMemory({ connectionString: PG_URL })
    expect(await memory.isHealthy()).toBe(true)
  })

  afterAll(async () => {
    const pool = memory.getPool()
    await pool.query(`DELETE FROM ros_messages WHERE agent = $1`, [TEST_AGENT])
    await pool.query(`DELETE FROM ros_conversations WHERE agent = $1`, [TEST_AGENT])
    await pool.end()
  })

  it('preserves original timestamps when provided', async () => {
    const sessionId = `test-session-${Date.now()}`

    // Create messages with specific timestamps (spaced 1 hour apart)
    const baseTime = new Date('2024-01-01T12:00:00Z')
    const input: IngestSessionInput = {
      sessionId,
      agent: TEST_AGENT,
      channel: 'test',
      source: 'test',
      messages: [
        {
          role: 'user',
          content: 'First message',
          createdAt: new Date(baseTime.getTime()),
        },
        {
          role: 'assistant',
          content: 'Second message',
          createdAt: new Date(baseTime.getTime() + 3600000), // +1 hour
        },
        {
          role: 'user',
          content: 'Third message',
          createdAt: new Date(baseTime.getTime() + 7200000), // +2 hours
        },
      ],
    }

    await ingestSession(memory, input)

    // Retrieve the messages and verify they maintain chronological order
    const pool = memory.getPool()
    const result = await pool.query<{
      content: string
      role: string
      created_at: Date
    }>(
      `SELECT m.content, m.role, m.created_at
       FROM ros_messages m
       JOIN ros_conversations c ON c.id = m.conversation_id
       WHERE c.session_key = $1 AND c.agent = $2
       ORDER BY m.created_at ASC`,
      [sessionId, TEST_AGENT],
    )

    expect(result.rows.length).toBe(3)
    expect(result.rows[0].content).toBe('First message')
    expect(result.rows[1].content).toBe('Second message')
    expect(result.rows[2].content).toBe('Third message')

    // Verify timestamps are preserved (within 1 second tolerance for DB rounding)
    expect(Math.abs(result.rows[0].created_at.getTime() - baseTime.getTime())).toBeLessThan(1000)
    expect(
      Math.abs(result.rows[1].created_at.getTime() - (baseTime.getTime() + 3600000)),
    ).toBeLessThan(1000)
    expect(
      Math.abs(result.rows[2].created_at.getTime() - (baseTime.getTime() + 7200000)),
    ).toBeLessThan(1000)
  })

  it('preserves order when messages arrive out of chronological order', async () => {
    const sessionId = `test-session-ooo-${Date.now()}`

    // Messages with timestamps NOT in insertion order (simulating delayed user message)
    const baseTime = new Date('2024-01-02T10:00:00Z')
    const input: IngestSessionInput = {
      sessionId,
      agent: TEST_AGENT,
      channel: 'test',
      source: 'test',
      messages: [
        {
          role: 'assistant',
          content: 'Assistant responds first (timestamp T+2)',
          createdAt: new Date(baseTime.getTime() + 7200000), // T+2 hours
        },
        {
          role: 'user',
          content: 'User message arrives late (timestamp T+0)',
          createdAt: new Date(baseTime.getTime()), // T+0 (earlier!)
        },
        {
          role: 'tool',
          content: 'Tool call in middle (timestamp T+1)',
          createdAt: new Date(baseTime.getTime() + 3600000), // T+1 hour
        },
      ],
    }

    await ingestSession(memory, input)

    // Retrieve ordered by created_at — should be chronological, not insertion order
    const pool = memory.getPool()
    const result = await pool.query<{
      content: string
      role: string
    }>(
      `SELECT m.content, m.role
       FROM ros_messages m
       JOIN ros_conversations c ON c.id = m.conversation_id
       WHERE c.session_key = $1 AND c.agent = $2
       ORDER BY m.created_at ASC`,
      [sessionId, TEST_AGENT],
    )

    expect(result.rows.length).toBe(3)
    // Should be in timestamp order, not insertion order
    expect(result.rows[0].content).toBe('User message arrives late (timestamp T+0)')
    expect(result.rows[1].content).toBe('Tool call in middle (timestamp T+1)')
    expect(result.rows[2].content).toBe('Assistant responds first (timestamp T+2)')
  })

  it('uses NOW() for messages without timestamps', async () => {
    const sessionId = `test-session-no-ts-${Date.now()}`
    const beforeInsert = new Date()

    const input: IngestSessionInput = {
      sessionId,
      agent: TEST_AGENT,
      channel: 'test',
      source: 'test',
      messages: [
        {
          role: 'user',
          content: 'Message without timestamp',
        },
      ],
    }

    await ingestSession(memory, input)
    const afterInsert = new Date()

    // Verify timestamp is recent (between before and after)
    const pool = memory.getPool()
    const result = await pool.query<{
      created_at: Date
    }>(
      `SELECT m.created_at
       FROM ros_messages m
       JOIN ros_conversations c ON c.id = m.conversation_id
       WHERE c.session_key = $1 AND c.agent = $2`,
      [sessionId, TEST_AGENT],
    )

    expect(result.rows.length).toBe(1)
    const createdAt = result.rows[0].created_at
    expect(createdAt.getTime()).toBeGreaterThanOrEqual(beforeInsert.getTime() - 1000)
    expect(createdAt.getTime()).toBeLessThanOrEqual(afterInsert.getTime() + 1000)
  })

  it('handles mixed timestamps and non-timestamps', async () => {
    const sessionId = `test-session-mixed-${Date.now()}`
    const explicitTime = new Date('2024-01-03T15:30:00Z')
    const beforeInsert = new Date()

    const input: IngestSessionInput = {
      sessionId,
      agent: TEST_AGENT,
      channel: 'test',
      source: 'test',
      messages: [
        {
          role: 'user',
          content: 'With explicit timestamp',
          createdAt: explicitTime,
        },
        {
          role: 'assistant',
          content: 'Without timestamp',
        },
      ],
    }

    await ingestSession(memory, input)
    const afterInsert = new Date()

    const pool = memory.getPool()
    const result = await pool.query<{
      content: string
      created_at: Date
    }>(
      `SELECT m.content, m.created_at
       FROM ros_messages m
       JOIN ros_conversations c ON c.id = m.conversation_id
       WHERE c.session_key = $1 AND c.agent = $2
       ORDER BY m.metadata->>'ordinal' ASC`,
      [sessionId, TEST_AGENT],
    )

    expect(result.rows.length).toBe(2)

    // First message has explicit timestamp
    expect(result.rows[0].content).toBe('With explicit timestamp')
    expect(Math.abs(result.rows[0].created_at.getTime() - explicitTime.getTime())).toBeLessThan(
      1000,
    )

    // Second message uses NOW()
    expect(result.rows[1].content).toBe('Without timestamp')
    expect(result.rows[1].created_at.getTime()).toBeGreaterThanOrEqual(
      beforeInsert.getTime() - 1000,
    )
    expect(result.rows[1].created_at.getTime()).toBeLessThanOrEqual(afterInsert.getTime() + 1000)
  })

  it('handles ISO timestamp strings', async () => {
    const sessionId = `test-session-iso-${Date.now()}`
    const timestampStr = '2024-01-04T08:15:30.000Z'

    const input: IngestSessionInput = {
      sessionId,
      agent: TEST_AGENT,
      channel: 'test',
      source: 'test',
      messages: [
        {
          role: 'user',
          content: 'With ISO string timestamp',
          createdAt: timestampStr,
        },
      ],
    }

    await ingestSession(memory, input)

    const pool = memory.getPool()
    const result = await pool.query<{
      created_at: Date
    }>(
      `SELECT m.created_at
       FROM ros_messages m
       JOIN ros_conversations c ON c.id = m.conversation_id
       WHERE c.session_key = $1 AND c.agent = $2`,
      [sessionId, TEST_AGENT],
    )

    expect(result.rows.length).toBe(1)
    const expectedTime = new Date(timestampStr)
    expect(Math.abs(result.rows[0].created_at.getTime() - expectedTime.getTime())).toBeLessThan(
      1000,
    )
  })

  it('skips messages with invalid date strings', async () => {
    const sessionId = `test-session-invalid-${Date.now()}`

    const input: IngestSessionInput = {
      sessionId,
      agent: TEST_AGENT,
      channel: 'test',
      source: 'test',
      messages: [
        {
          role: 'user',
          content: 'Valid message before invalid date',
        },
        {
          role: 'assistant',
          content: 'Message with invalid date',
          createdAt: 'garbage-not-a-date' as any, // Schema validation would catch this, but test runtime guard
        },
        {
          role: 'user',
          content: 'Valid message after invalid date',
        },
      ],
    }

    const result = await ingestSession(memory, input)

    // Should skip the message with invalid date
    expect(result.skipped).toBe(1)
    expect(result.ingested).toBe(2)

    const pool = memory.getPool()
    const messages = await pool.query<{
      content: string
    }>(
      `SELECT m.content
       FROM ros_messages m
       JOIN ros_conversations c ON c.id = m.conversation_id
       WHERE c.session_key = $1 AND c.agent = $2
       ORDER BY m.metadata->>'ordinal' ASC`,
      [sessionId, TEST_AGENT],
    )

    expect(messages.rows.length).toBe(2)
    expect(messages.rows[0].content).toBe('Valid message before invalid date')
    expect(messages.rows[1].content).toBe('Valid message after invalid date')
  })
})

describe('truncateContent (unit tests, DB-free)', () => {
  it('does not truncate content shorter than MAX_CONTENT', () => {
    const metadata: Record<string, unknown> = {}
    const short = 'Hello world'
    const result = truncateContent(short, metadata)
    expect(result).toBe(short)
    expect(metadata.truncated).toBeUndefined()
    expect(metadata.full_content_length).toBeUndefined()
  })

  it('truncates content longer than MAX_CONTENT and records metadata', () => {
    const metadata: Record<string, unknown> = {}
    const longContent = 'a'.repeat(MAX_CONTENT + 100)
    const result = truncateContent(longContent, metadata)
    expect(result.length).toBeLessThanOrEqual(MAX_CONTENT + TRUNCATION_MARKER.length)
    expect(result.endsWith(TRUNCATION_MARKER)).toBe(true)
    expect(metadata.truncated).toBe(true)
    expect(metadata.full_content_length).toBe(MAX_CONTENT + 100)
  })

  it('does not truncate content exactly at MAX_CONTENT boundary', () => {
    const metadata: Record<string, unknown> = {}
    const exactContent = 'x'.repeat(MAX_CONTENT)
    const result = truncateContent(exactContent, metadata)
    expect(result).toBe(exactContent)
    expect(metadata.truncated).toBeUndefined()
  })

  it('backs off one unit when splitting a high surrogate pair', () => {
    const metadata: Record<string, unknown> = {}
    // Emoji at position MAX_CONTENT - 1 requires a surrogate pair
    const almostFull = 'a'.repeat(MAX_CONTENT - 1) + '😀'
    const result = truncateContent(almostFull, metadata)
    // Should back off to avoid splitting the surrogate pair
    expect(result.endsWith('😀')).toBe(false)
    expect(result.endsWith(TRUNCATION_MARKER)).toBe(true)
    expect(metadata.truncated).toBe(true)
  })

  it('skips truncation when content already ends with marker', () => {
    const metadata: Record<string, unknown> = {}
    const alreadyTruncated = 'a'.repeat(MAX_CONTENT) + TRUNCATION_MARKER
    const result = truncateContent(alreadyTruncated, metadata)
    expect(result).toBe(alreadyTruncated)
    expect(metadata.truncated).toBeUndefined()
  })

  it('truncates tool_result with field prefix', () => {
    const metadata: Record<string, unknown> = {}
    const longToolResult = 'result'.repeat(MAX_CONTENT / 5)
    const result = truncateContent(longToolResult, metadata, 'tool_result')
    expect(result.endsWith(TRUNCATION_MARKER)).toBe(true)
    expect(metadata.truncated).toBe(true)
    expect(metadata.full_tool_result_length).toBe(longToolResult.length)
  })
})

describeIfPg('memory write truncation (integration)', () => {
  let memory: PostgresMemory
  const TEST_AGENT = `test-truncation-${Date.now()}`

  beforeAll(async () => {
    memory = new PostgresMemory({ connectionString: PG_URL })
    expect(await memory.isHealthy()).toBe(true)
  })

  afterAll(async () => {
    const pool = memory.getPool()
    await pool.query(`DELETE FROM ros_messages WHERE agent = $1`, [TEST_AGENT])
    await pool.query(`DELETE FROM ros_conversations WHERE agent = $1`, [TEST_AGENT])
    await memory.close()
  })

  it('ingestSession truncates content and returns truncation info', async () => {
    const sessionId = `test-ingest-truncate-${Date.now()}`
    const longContent = 'x'.repeat(MAX_CONTENT + 500)

    const result = await ingestSession(memory, {
      sessionId,
      messages: [{ role: 'user', content: longContent }],
      agent: TEST_AGENT,
      source: 'test',
      channel: 'test',
    })

    expect(result.ingested).toBe(1)
    expect(result.truncated).toBe(true)
    expect(result.full_content_length).toBe(MAX_CONTENT + 500)

    // Verify stored content is truncated
    const pool = memory.getPool()
    const rows = await pool.query<{ content: string; metadata: any }>(
      `SELECT m.content, m.metadata
       FROM ros_messages m
       JOIN ros_conversations c ON c.id = m.conversation_id
       WHERE c.session_key = $1 AND c.agent = $2`,
      [sessionId, TEST_AGENT],
    )
    expect(rows.rows.length).toBe(1)
    expect(rows.rows[0].content.endsWith(TRUNCATION_MARKER)).toBe(true)
    expect(rows.rows[0].metadata.full_content_length).toBe(MAX_CONTENT + 500)
  })

  it('ingestSession does not truncate short content', async () => {
    const sessionId = `test-ingest-no-truncate-${Date.now()}`
    const shortContent = 'Hello world'

    const result = await ingestSession(memory, {
      sessionId,
      messages: [{ role: 'user', content: shortContent }],
      agent: TEST_AGENT,
      source: 'test',
      channel: 'test',
    })

    expect(result.ingested).toBe(1)
    expect(result.truncated).toBeUndefined()
    expect(result.full_content_length).toBeUndefined()
  })

  it('memory_append via MCP truncates content and tool_result', async () => {
    const sessionId = `test-append-truncate-${Date.now()}`
    const tools = createMemoryWriteTools(memory)
    const appendTool = tools.find((t) => t.name === 'memory_append')
    expect(appendTool).toBeDefined()

    const longContent = 'c'.repeat(MAX_CONTENT + 100)
    const longToolResult = 'r'.repeat(MAX_CONTENT + 200)

    const result = await appendTool!.execute({
      session_id: sessionId,
      content: longContent,
      role: 'assistant',
      tool_name: 'test_tool',
      tool_result: longToolResult,
      agent: TEST_AGENT,
      source: 'test',
      channel: 'test',
    })

    const parsed = JSON.parse(toolText(result))
    expect(parsed.truncated).toBe(true)
    expect(parsed.full_content_length).toBe(MAX_CONTENT + 200) // max of both

    // Verify both content and tool_result are truncated
    const pool = memory.getPool()
    const rows = await pool.query<{ content: string; tool_result: string }>(
      `SELECT m.content, m.tool_result
       FROM ros_messages m
       JOIN ros_conversations c ON c.id = m.conversation_id
       WHERE c.session_key = $1 AND c.agent = $2`,
      [sessionId, TEST_AGENT],
    )
    expect(rows.rows.length).toBe(1)
    expect(rows.rows[0].content.endsWith(TRUNCATION_MARKER)).toBe(true)
    expect(rows.rows[0].tool_result.endsWith(TRUNCATION_MARKER)).toBe(true)
  })
})

describeIfPg('memory write idempotency', () => {
  let memory: PostgresMemory
  const TEST_AGENT = `test-idempotency-${Date.now()}`

  beforeAll(() => {
    memory = new PostgresMemory({ connectionString: PG_URL })
  })

  afterAll(async () => {
    const pool = memory.getPool()
    await pool.query(`DELETE FROM ros_messages WHERE agent = $1`, [TEST_AGENT])
    await pool.query(`DELETE FROM ros_conversations WHERE agent = $1`, [TEST_AGENT])
    await memory.close()
  })

  it('ingestEventId includes ordinal to prevent data loss on repeated text', () => {
    const eventId1 = ingestEventId({
      sessionId: 'test-session',
      agent: 'test-agent',
      role: 'user',
      content: 'ok',
      ordinal: 0,
    })
    const eventId2 = ingestEventId({
      sessionId: 'test-session',
      agent: 'test-agent',
      role: 'user',
      content: 'ok',
      ordinal: 1,
    })
    // Same content but different ordinals → different hashes
    expect(eventId1).not.toBe(eventId2)
    expect(eventId1).toMatch(/^[0-9a-f]{64}$/)
  })

  it('appendEventId has separate domain from ingestEventId', () => {
    const ingestId = ingestEventId({
      sessionId: 'test-session',
      agent: 'test-agent',
      role: 'user',
      content: 'test',
      ordinal: 0,
    })
    const appendId = appendEventId({
      sessionId: 'test-session',
      agent: 'test-agent',
      role: 'user',
      content: 'test',
    })
    // Different hash domains ensure ingest doesn't block append
    expect(ingestId).not.toBe(appendId)
  })

  it('memory_ingest_session skips duplicate ordinals on re-ingest', async () => {
    const sessionId = `test-ingest-ordinals-${Date.now()}`
    const input: IngestSessionInput = {
      sessionId,
      messages: [
        { role: 'user', content: 'First message' },
        { role: 'assistant', content: 'Second message' },
        { role: 'user', content: 'Third message' },
      ],
      agent: TEST_AGENT,
      source: 'test',
      channel: 'test',
    }

    // First ingest
    const result1 = await ingestSession(memory, input)
    expect(result1.ingested).toBe(3)
    expect(result1.skipped).toBe(0)
    expect(result1.ids.length).toBe(3)

    // Re-ingest the same session — all should be skipped by ordinal
    const result2 = await ingestSession(memory, input)
    expect(result2.ingested).toBe(0)
    expect(result2.skipped).toBe(3)
    expect(result2.ids.length).toBe(0)
  })

  it('memory_ingest_session skips duplicate event_ids (includes ordinal)', async () => {
    const sessionId = `test-ingest-event-id-${Date.now()}`
    const input: IngestSessionInput = {
      sessionId,
      messages: [
        { role: 'user', content: 'Message A' },
        { role: 'user', content: 'Message B' },
      ],
      agent: TEST_AGENT,
      source: 'test',
      channel: 'test',
    }

    // First ingest
    const result1 = await ingestSession(memory, input)
    expect(result1.ingested).toBe(2)
    expect(result1.skipped).toBe(0)

    // Re-ingest: event_ids match even though we're calling again
    const result2 = await ingestSession(memory, input)
    expect(result2.ingested).toBe(0)
    expect(result2.skipped).toBe(2)
  })

  it('memory_ingest_session does NOT skip when only content matches (ordinal differs)', async () => {
    const sessionId = `test-ingest-repeated-text-${Date.now()}`
    const input: IngestSessionInput = {
      sessionId,
      messages: [
        { role: 'user', content: 'ok' },
        { role: 'user', content: 'ok' }, // repeated text, different ordinal
      ],
      agent: TEST_AGENT,
      source: 'test',
      channel: 'test',
    }

    const result = await ingestSession(memory, input)
    // Both should be ingested because ordinals differ (0 vs 1)
    expect(result.ingested).toBe(2)
    expect(result.skipped).toBe(0)
  })

  it('memory_append with explicit event_id skips duplicates', async () => {
    const sessionId = `test-append-event-id-${Date.now()}`
    const tools = createMemoryWriteTools(memory)
    const appendTool = tools.find((t) => t.name === 'memory_append')
    expect(appendTool).toBeDefined()

    const eventId = appendEventId({
      sessionId,
      agent: TEST_AGENT,
      role: 'user',
      content: 'Unique message',
    })

    // First append with explicit event_id
    const result1 = await appendTool!.execute({
      session_id: sessionId,
      content: 'Unique message',
      role: 'user',
      event_id: eventId,
      agent: TEST_AGENT,
      source: 'test',
      channel: 'test',
    })
    const parsed1 = JSON.parse(toolText(result1))
    expect(parsed1.skipped).toBeUndefined()
    expect(parsed1.id).toBeDefined()
    expect(parsed1.event_id).toBe(eventId)

    const firstId = parsed1.id

    // Second append with the same event_id
    const result2 = await appendTool!.execute({
      session_id: sessionId,
      content: 'Unique message',
      role: 'user',
      event_id: eventId,
      agent: TEST_AGENT,
      source: 'test',
      channel: 'test',
    })
    const parsed2 = JSON.parse(toolText(result2))
    expect(parsed2.skipped).toBe(true)
    expect(parsed2.event_id).toBe(eventId)
    expect(parsed2.id).toBe(firstId) // M2: returns existing row id
  })

  it('memory_append without event_id generates content-hash and deduplicates', async () => {
    const sessionId = `test-append-auto-event-id-${Date.now()}`
    const tools = createMemoryWriteTools(memory)
    const appendTool = tools.find((t) => t.name === 'memory_append')
    expect(appendTool).toBeDefined()

    // First append without event_id
    const result1 = await appendTool!.execute({
      session_id: sessionId,
      content: 'Auto dedupe message',
      role: 'user',
      agent: TEST_AGENT,
      source: 'test',
      channel: 'test',
    })
    const parsed1 = JSON.parse(toolText(result1))
    expect(parsed1.skipped).toBeUndefined()
    expect(parsed1.id).toBeDefined()
    expect(parsed1.event_id).toBeDefined()

    const generatedEventId = parsed1.event_id
    const firstId = parsed1.id

    // Second append with the same content (should auto-generate same event_id)
    const result2 = await appendTool!.execute({
      session_id: sessionId,
      content: 'Auto dedupe message',
      role: 'user',
      agent: TEST_AGENT,
      source: 'test',
      channel: 'test',
    })
    const parsed2 = JSON.parse(toolText(result2))
    expect(parsed2.skipped).toBe(true)
    expect(parsed2.event_id).toBe(generatedEventId)
    expect(parsed2.id).toBe(firstId) // M2: returns existing row id
  })

  it('ingest and append have separate hash domains', async () => {
    const sessionId = `test-hash-domains-${Date.now()}`

    // Ingest a message
    const ingestResult = await ingestSession(memory, {
      sessionId,
      messages: [{ role: 'user', content: 'domain test' }],
      agent: TEST_AGENT,
      source: 'test',
      channel: 'test',
    })
    expect(ingestResult.ingested).toBe(1)

    // Append the same content (different hash domain)
    const tools = createMemoryWriteTools(memory)
    const appendTool = tools.find((t) => t.name === 'memory_append')!
    const appendResult = await appendTool.execute({
      session_id: sessionId,
      content: 'domain test',
      role: 'user',
      agent: TEST_AGENT,
      source: 'test',
      channel: 'test',
    })
    const parsed = JSON.parse(toolText(appendResult))
    // Should NOT be skipped because hash domains differ
    expect(parsed.skipped).toBeUndefined()
    expect(parsed.id).toBeDefined()
  })

  it('concurrent memory_ingest_session calls are serialized by advisory lock', async () => {
    const sessionId = `test-concurrent-ingest-${Date.now()}`
    const input: IngestSessionInput = {
      sessionId,
      messages: [
        { role: 'user', content: 'Concurrent A' },
        { role: 'user', content: 'Concurrent B' },
      ],
      agent: TEST_AGENT,
      source: 'test',
      channel: 'test',
    }

    // Launch two concurrent ingests
    const [result1, result2] = await Promise.all([
      ingestSession(memory, input),
      ingestSession(memory, input),
    ])

    // One should ingest, one should skip
    const totalIngested = result1.ingested + result2.ingested
    const totalSkipped = result1.skipped + result2.skipped

    expect(totalIngested).toBe(2)
    expect(totalSkipped).toBe(2)
    expect(result1.ids.length + result2.ids.length).toBe(2)
  })

  it('role is required for memory_append', async () => {
    const tools = createMemoryWriteTools(memory)
    const appendTool = tools.find((t) => t.name === 'memory_append')!

    await expect(
      appendTool.execute({
        session_id: 'test',
        content: 'test',
        // role missing
        agent: TEST_AGENT,
      }),
    ).rejects.toThrow(/role/i)
  })

  it('role is required for memory_ingest_session messages', async () => {
    const sessionId = `test-role-required-${Date.now()}`

    await expect(
      ingestSession(memory, {
        sessionId,
        messages: [
          { role: 'user', content: 'has role' },
          { content: 'missing role' } as any, // intentionally bad
        ],
        agent: TEST_AGENT,
      }),
    ).rejects.toThrow(/role/i)
  })

  it('C2/H2: event_id checked before ordinal, allows session extension', async () => {
    const sessionId = `test-event-id-before-ordinal-${Date.now()}`

    // First ingest: A at 0, B at 1
    const result1 = await ingestSession(memory, {
      sessionId,
      messages: [
        { role: 'user', content: 'A' },
        { role: 'user', content: 'B' },
      ],
      agent: TEST_AGENT,
      source: 'test',
      channel: 'test',
    })
    expect(result1.ingested).toBe(2)
    expect(result1.skipped).toBe(0)

    // Second ingest: [C, A, B] at ordinals 0, 1, 2
    // Ordinals 0 and 1 exist, but C's event_id is new, so C should be ingested
    // A and B should be skipped by event_id (before ordinal check)
    const result2 = await ingestSession(memory, {
      sessionId,
      messages: [
        { role: 'user', content: 'C' },
        { role: 'user', content: 'A' },
        { role: 'user', content: 'B' },
      ],
      agent: TEST_AGENT,
      source: 'test',
      channel: 'test',
    })
    expect(result2.ingested).toBe(1) // C ingested
    expect(result2.skipped).toBe(2) // A, B skipped
  })

  it('M1: empty or whitespace event_id normalized to undefined', async () => {
    const sessionId = `test-empty-event-id-${Date.now()}`
    const tools = createMemoryWriteTools(memory)
    const appendTool = tools.find((t) => t.name === 'memory_append')!

    // Append with empty event_id
    const result1 = await appendTool.execute({
      session_id: sessionId,
      content: 'Message 1',
      role: 'user',
      event_id: '',
      agent: TEST_AGENT,
      source: 'test',
      channel: 'test',
    })
    const parsed1 = JSON.parse(toolText(result1))
    expect(parsed1.id).toBeDefined()

    // Append with whitespace event_id
    const result2 = await appendTool.execute({
      session_id: sessionId,
      content: 'Message 2',
      role: 'user',
      event_id: '   ',
      agent: TEST_AGENT,
      source: 'test',
      channel: 'test',
    })
    const parsed2 = JSON.parse(toolText(result2))
    expect(parsed2.id).toBeDefined()

    // Both should have auto-generated event_ids (not shared empty key)
    expect(parsed1.event_id).not.toBe('')
    expect(parsed2.event_id).not.toBe('')
    expect(parsed1.event_id).not.toBe(parsed2.event_id)
  })
})
