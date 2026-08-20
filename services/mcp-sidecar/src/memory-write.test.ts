/**
 * Integration tests for memory write tools — `memory_append` and
 * `memory_ingest_session`.
 *
 * Requires a live Postgres with the RivetOS schema. Skips automatically when
 * `RIVETOS_PG_URL` is not set so local dev / CI without a DB doesn't see
 * spurious failures.
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
import { ingestSession, truncateContent, type IngestSessionInput } from './memory-write.js'

const PG_URL = process.env.RIVETOS_PG_URL ?? ''
const describeIfPg = PG_URL ? describe : describe.skip

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
    // in adapter.ts (lines 221-243) will handle the job enqueueing.
  })
})

describeIfPg('memory_ingest_session timestamp preservation', () => {
  let memory: PostgresMemory
  const TEST_AGENT = `test-ingest-${Date.now()}`

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
  const MAX_CONTENT = 16000
  const TRUNCATION_MARKER = '\n…[truncated]'

  it('does not truncate content shorter than MAX_CONTENT', () => {
    const shortContent = 'Short message'
    const metadata: Record<string, unknown> = {}

    const result = truncateContent(shortContent, metadata)

    expect(result).toBe(shortContent)
    expect(metadata.full_content_length).toBeUndefined()
    expect(metadata.truncated).toBeUndefined()
  })

  it('truncates content longer than MAX_CONTENT and records metadata', () => {
    const longContent = 'x'.repeat(20000)
    const metadata: Record<string, unknown> = {}

    const result = truncateContent(longContent, metadata)

    expect(result.endsWith(TRUNCATION_MARKER)).toBe(true)
    expect(result.length).toBeLessThanOrEqual(MAX_CONTENT + TRUNCATION_MARKER.length)
    expect(metadata.full_content_length).toBe(20000)
    expect(metadata.truncated).toBe(true)
  })

  it('does not truncate content exactly at MAX_CONTENT boundary', () => {
    const boundaryContent = 'x'.repeat(MAX_CONTENT)
    const metadata: Record<string, unknown> = {}

    const result = truncateContent(boundaryContent, metadata)

    expect(result).toBe(boundaryContent)
    expect(metadata.full_content_length).toBeUndefined()
    expect(metadata.truncated).toBeUndefined()
  })

  it('backs off one unit when splitting a high surrogate pair', () => {
    // Create content with emoji (surrogate pair) at the boundary
    const beforeEmoji = 'x'.repeat(15999)
    const emoji = '😀' // U+1F600, encoded as surrogate pair 0xD83D 0xDE00
    const afterEmoji = 'x'.repeat(100)
    const content = beforeEmoji + emoji + afterEmoji
    const metadata: Record<string, unknown> = {}

    const result = truncateContent(content, metadata)

    // Should back off to avoid splitting the emoji
    expect(result.length).toBe(15999 + TRUNCATION_MARKER.length)
    expect(result).toBe(beforeEmoji + TRUNCATION_MARKER)
    expect(result.includes(emoji)).toBe(false)
    expect(metadata.truncated).toBe(true)
  })

  it('skips truncation when content already ends with marker', () => {
    const alreadyTruncated = 'x'.repeat(10000) + TRUNCATION_MARKER
    const metadata: Record<string, unknown> = {}

    const result = truncateContent(alreadyTruncated, metadata)

    // Should return as-is
    expect(result).toBe(alreadyTruncated)
    // Should not overwrite metadata
    expect(metadata.full_content_length).toBeUndefined()
    expect(metadata.truncated).toBeUndefined()
  })

  it('truncates tool_result with field prefix', () => {
    const longToolResult = 'y'.repeat(18000)
    const metadata: Record<string, unknown> = {}

    const result = truncateContent(longToolResult, metadata, 'tool_result')

    expect(result.endsWith(TRUNCATION_MARKER)).toBe(true)
    expect(metadata.full_tool_result_length).toBe(18000)
    expect(metadata.truncated).toBe(true)
  })
})

describeIfPg('memory write truncation (integration)', () => {
  let memory: PostgresMemory
  const TEST_AGENT = `test-truncation-${Date.now()}`
  const MAX_CONTENT = 16000

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

  it('ingestSession truncates content and returns truncation info', async () => {
    const longContent = 'x'.repeat(20000)
    const sessionId = `test-trunc-${Date.now()}`

    const result = await ingestSession(memory, {
      sessionId,
      messages: [{ role: 'user', content: longContent }],
      source: 'test',
      agent: TEST_AGENT,
      channel: 'test-channel',
    })

    expect(result.ingested).toBe(1)
    expect(result.truncated).toBe(true)
    expect(result.full_content_length).toBe(20000)

    const messageId = result.ids[0]
    const row = await memory.getPool().query<{
      content: string
      metadata: Record<string, unknown>
    }>('SELECT content, metadata FROM ros_messages WHERE id = $1', [messageId])

    expect(row.rows.length).toBe(1)
    const { content, metadata } = row.rows[0]

    expect(content.endsWith('\n…[truncated]')).toBe(true)
    expect(content.length).toBeLessThanOrEqual(MAX_CONTENT + '\n…[truncated]'.length)
    expect(metadata.full_content_length).toBe(20000)
    expect(metadata.truncated).toBe(true)
  })

  it('ingestSession does not truncate short content', async () => {
    const shortContent = 'Short message'
    const sessionId = `test-short-${Date.now()}`

    const result = await ingestSession(memory, {
      sessionId,
      messages: [{ role: 'user', content: shortContent }],
      source: 'test',
      agent: TEST_AGENT,
      channel: 'test-channel',
    })

    expect(result.ingested).toBe(1)
    expect(result.truncated).toBeUndefined()
    expect(result.full_content_length).toBeUndefined()

    const messageId = result.ids[0]
    const row = await memory.getPool().query<{
      content: string
      metadata: Record<string, unknown>
    }>('SELECT content, metadata FROM ros_messages WHERE id = $1', [messageId])

    expect(row.rows.length).toBe(1)
    const { content, metadata } = row.rows[0]

    expect(content).toBe(shortContent)
    expect(metadata.full_content_length).toBeUndefined()
    expect(metadata.truncated).toBeUndefined()
  })

  it('memory_append via MCP truncates content and tool_result', async () => {
    const longContent = 'a'.repeat(17000)
    const longToolResult = 'b'.repeat(18000)
    const sessionId = `test-append-trunc-${Date.now()}`

    const memoryHandle = createMemoryTools({ pgUrl: PG_URL, enableWrite: true })
    const server = createV2McpServer({
      host: '127.0.0.1',
      port: 0,
      tools: memoryHandle.tools,
    })
    await server.start()

    const client = await connectV2({
      name: 'truncation-test',
      url: `http://127.0.0.1:${String(server.port)}/mcp`,
    })

    try {
      const result = await client.callToolRaw('memory_append', {
        session_id: sessionId,
        content: longContent,
        role: 'tool',
        tool_result: longToolResult,
        agent: TEST_AGENT,
        channel: 'test-channel',
      })

      expect(result.isError).not.toBe(true)
      const content = result.content as Array<{ type: string; text?: string }>
      const response = JSON.parse(content[0]?.text ?? '{}')

      expect(response.truncated).toBe(true)
      expect(response.full_content_length).toBeGreaterThan(MAX_CONTENT)

      // Verify both content and tool_result were truncated in DB
      const row = await memory.getPool().query<{
        content: string
        tool_result: string
        metadata: Record<string, unknown>
      }>('SELECT content, tool_result, metadata FROM ros_messages WHERE id = $1', [response.id])

      expect(row.rows.length).toBe(1)
      const { content: storedContent, tool_result, metadata } = row.rows[0]

      expect(storedContent.endsWith('\n…[truncated]')).toBe(true)
      expect(tool_result.endsWith('\n…[truncated]')).toBe(true)
      expect(metadata.full_content_length).toBe(17000)
      expect(metadata.full_tool_result_length).toBe(18000)
      expect(metadata.truncated).toBe(true)
    } finally {
      await client.close().catch(() => {})
      await server.close().catch(() => {})
      await memoryHandle.close().catch(() => {})
    }
  })
})

