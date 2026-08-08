/**
 * Integration test for the full memory data-plane over MCP — `memory_search`,
 * `memory_browse`, `memory_stats`, `memory_get_full`.
 *
 * Requires a live Postgres with the RivetOS schema. Skips automatically when
 * `RIVETOS_PG_URL` is not set so local dev / CI without a DB doesn't see
 * spurious failures.
 *
 * Asserts the wire surface, not the underlying SQL — i.e. that a real MCP
 * client can call each tool and receive a non-error text response. Search
 * relevance, browse pagination, stats accuracy, and JSONL re-read fidelity
 * are covered by unit tests in `@rivetos/memory-postgres`.
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

const PG_URL = process.env.RIVETOS_PG_URL ?? ''
const describeIfPg = PG_URL ? describe : describe.skip

describeIfPg('memory data-plane (Phase 1.A slice 3)', () => {
  let server: V2McpServer
  let client: V2McpConnection
  let memoryHandle: MemoryToolsHandle

  // Envelope-preserving shim over connectV2's callToolRaw — these tests
  // assert on content/isError rather than callTool's unwrapped string.
  function callTool(params: { name: string; arguments: Record<string, unknown> }) {
    return client.callToolRaw(params.name, params.arguments)
  }

  beforeAll(async () => {
    memoryHandle = createMemoryTools({ pgUrl: PG_URL })

    server = createV2McpServer({
      host: '127.0.0.1',
      port: 0,
      tools: [defaultEchoTool(), ...memoryHandle.tools],
    })
    await server.start()

    client = await connectV2({
      name: 'memory-tools-test',
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
  })

  it('lists all four memory tools alongside echo', async () => {
    const names = (await client.listTools()).map((t) => t.name)
    expect(names).toContain('memory_search')
    expect(names).toContain('memory_browse')
    expect(names).toContain('memory_stats')
    expect(names).toContain('memory_get_full')
    expect(names).toContain('echo')
  })

  it('memory_search returns a text response for a real query', async () => {
    const result = await callTool({
      name: 'memory_search',
      arguments: { query: 'rivetos', limit: 3 },
    })

    expect(result.isError).not.toBe(true)
    const content = result.content as Array<{ type: string; text?: string }>
    expect(content.length).toBeGreaterThan(0)
    expect(content[0]?.type).toBe('text')
    expect(typeof content[0]?.text).toBe('string')
  })

  it('memory_browse returns a text response with chronological messages', async () => {
    const result = await callTool({
      name: 'memory_browse',
      arguments: { limit: 5, order: 'desc' },
    })

    expect(result.isError).not.toBe(true)
    const content = result.content as Array<{ type: string; text?: string }>
    expect(content.length).toBeGreaterThan(0)
    expect(content[0]?.type).toBe('text')
    expect(typeof content[0]?.text).toBe('string')
  })

  it('memory_stats returns a health report', async () => {
    const result = await callTool({
      name: 'memory_stats',
      arguments: {},
    })

    expect(result.isError).not.toBe(true)
    const content = result.content as Array<{ type: string; text?: string }>
    expect(content.length).toBeGreaterThan(0)
    expect(content[0]?.type).toBe('text')
    expect(content[0]?.text).toContain('Memory System Health')
  })

  it('memory_get_full accepts an id and returns a text response', async () => {
    // Wire-surface only: unknown id is a soft tool text reply (not MCP error).
    // Full JSONL re-read coverage lives in @rivetos/memory-postgres get-full tests.
    const result = await callTool({
      name: 'memory_get_full',
      arguments: { id: '00000000-0000-0000-0000-000000000000' },
    })

    expect(result.isError).not.toBe(true)
    const content = result.content as Array<{ type: string; text?: string }>
    expect(content.length).toBeGreaterThan(0)
    expect(content[0]?.type).toBe('text')
    expect(typeof content[0]?.text).toBe('string')
    expect(content[0]?.text).toMatch(
      /No message with id|memory_get_full failed|row was not truncated|Full payload/,
    )
  })
})
