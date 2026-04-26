/**
 * Integration test for `rivetos.memory_search` over MCP.
 *
 * Requires a live Postgres with the RivetOS schema. Skips automatically
 * when `RIVETOS_PG_URL` is not set so local dev / CI without a DB doesn't
 * see spurious failures.
 *
 * The test asserts the wire surface, not the search relevance — i.e. that
 * a real MCP client can call `rivetos.memory_search` and receive a text
 * response without an error envelope. Search relevance is covered by
 * unit tests in `@rivetos/memory-postgres` itself.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import { createMcpServer, defaultEchoTool, type RivetMcpServer } from '../server.js'
import { createMemorySearchTool, type MemorySearchToolHandle } from './memory-search.js'

const PG_URL = process.env.RIVETOS_PG_URL ?? ''
const describeIfPg = PG_URL ? describe : describe.skip

describeIfPg('rivetos.memory_search (Phase 1.A slice 2)', () => {
  let server: RivetMcpServer
  let client: Client
  let memoryHandle: MemorySearchToolHandle

  beforeAll(async () => {
    memoryHandle = createMemorySearchTool({ pgUrl: PG_URL })

    server = createMcpServer({
      host: '127.0.0.1',
      port: 0,
      tools: [defaultEchoTool(), memoryHandle.tool],
      log: () => {
        // Quiet during tests.
      },
    })
    await server.start()

    const url = new URL(
      `http://${server.address.host}:${String(server.address.port)}/mcp`,
    )
    client = new Client({ name: 'memory-search-test', version: '0.0.0' })
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

  it('lists rivetos.memory_search alongside echo', async () => {
    const tools = await client.listTools()
    const names = tools.tools.map((t) => t.name)
    expect(names).toContain('rivetos.memory_search')
    expect(names).toContain('rivetos.echo')
  })

  it('returns a text response for a real query', async () => {
    const result = await client.callTool({
      name: 'rivetos.memory_search',
      arguments: { query: 'rivetos', limit: 3 },
    })

    expect(result.isError).not.toBe(true)
    const content = result.content as Array<{ type: string; text?: string }>
    expect(content.length).toBeGreaterThan(0)
    expect(content[0]?.type).toBe('text')
    expect(typeof content[0]?.text).toBe('string')
  })
})
