/**
 * Integration test for the full memory data-plane over MCP — `memory_search`,
 * `memory_browse`, `memory_stats`.
 *
 * Requires a live Postgres with the RivetOS schema. Skips automatically when
 * `RIVETOS_PG_URL` is not set so local dev / CI without a DB doesn't see
 * spurious failures.
 *
 * Asserts the wire surface, not the underlying SQL — i.e. that a real MCP
 * client can call each tool and receive a non-error text response. Search
 * relevance, browse pagination, and stats accuracy are covered by unit tests
 * in `@rivetos/memory-postgres`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import { createMcpServer, defaultEchoTool, type RivetMcpServer } from '../server.js'
import { createMemoryTools, type MemoryToolsHandle } from './memory.js'

const PG_URL = process.env.RIVETOS_PG_URL ?? ''
const describeIfPg = PG_URL ? describe : describe.skip

describeIfPg('memory data-plane (Phase 1.A slice 3)', () => {
  let server: RivetMcpServer
  let client: Client
  let memoryHandle: MemoryToolsHandle

  beforeAll(async () => {
    memoryHandle = createMemoryTools({ pgUrl: PG_URL })

    server = createMcpServer({
      host: '127.0.0.1',
      port: 0,
      tools: [defaultEchoTool(), ...memoryHandle.tools],
      log: () => {
        // Quiet during tests.
      },
    })
    await server.start()

    const url = new URL(`http://${server.address.host}:${String(server.address.port)}/mcp`)
    client = new Client({ name: 'memory-tools-test', version: '0.0.0' })
    await client.connect(new StreamableHTTPClientTransport(url))
  })

  afterAll(async () => {
    await client.close().catch(() => {
      /* swallow */
    })
    await server.stop().catch(() => {
      /* swallow */
    })
    await memoryHandle.close().catch(() => {
      /* swallow */
    })
  })

  it('lists all three memory tools alongside echo', async () => {
    const tools = await client.listTools()
    const names = tools.tools.map((t) => t.name)
    expect(names).toContain('memory_search')
    expect(names).toContain('memory_browse')
    expect(names).toContain('memory_stats')
    expect(names).toContain('echo')
  })

  it('memory_search returns a text response for a real query', async () => {
    const result = await client.callTool({
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
    const result = await client.callTool({
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
    const result = await client.callTool({
      name: 'memory_stats',
      arguments: {},
    })

    expect(result.isError).not.toBe(true)
    const content = result.content as Array<{ type: string; text?: string }>
    expect(content.length).toBeGreaterThan(0)
    expect(content[0]?.type).toBe('text')
    expect(content[0]?.text).toContain('Memory System Health')
  })
})
