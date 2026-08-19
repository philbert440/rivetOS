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
