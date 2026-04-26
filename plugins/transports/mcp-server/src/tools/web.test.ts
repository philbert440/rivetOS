/**
 * Integration test for the web data-plane over MCP — `internet_search`,
 * `web_fetch`.
 *
 * The `web_fetch` test always runs (no external deps — tests that the wire
 * surface returns a text envelope; a network failure produces a string result
 * rather than a thrown error, which is a valid MCP response).
 *
 * The `internet_search` test runs against the real network. Skipped when
 * the host has no outbound network or when explicitly disabled via
 * `RIVETOS_TEST_SKIP_NETWORK=1`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import { createMcpServer, defaultEchoTool, type RivetMcpServer } from '../server.js'
import { createWebTools, type WebToolsHandle } from './web.js'

const skipNetwork = process.env.RIVETOS_TEST_SKIP_NETWORK === '1'

describe('web data-plane (Phase 1.A slice 3)', () => {
  let server: RivetMcpServer
  let client: Client
  let webHandle: WebToolsHandle

  beforeAll(async () => {
    webHandle = createWebTools()
    server = createMcpServer({
      host: '127.0.0.1',
      port: 0,
      tools: [defaultEchoTool(), ...webHandle.tools],
      log: () => {
        // Quiet during tests.
      },
    })
    await server.start()

    const url = new URL(`http://${server.address.host}:${String(server.address.port)}/mcp`)
    client = new Client({ name: 'web-tools-test', version: '0.0.0' })
    await client.connect(new StreamableHTTPClientTransport(url))
  })

  afterAll(async () => {
    await client.close().catch(() => {
      /* swallow */
    })
    await server.stop().catch(() => {
      /* swallow */
    })
    await webHandle.close().catch(() => {
      /* swallow */
    })
  })

  it('lists both web tools alongside echo', async () => {
    const tools = await client.listTools()
    const names = tools.tools.map((t) => t.name)
    expect(names).toContain('rivetos.internet_search')
    expect(names).toContain('rivetos.web_fetch')
    expect(names).toContain('rivetos.echo')
  })

  it('web_fetch returns a text envelope for an invalid URL', async () => {
    const result = await client.callTool({
      name: 'rivetos.web_fetch',
      arguments: { url: 'http://127.0.0.1:1/nope', max_chars: 1000 },
    })

    // The Rivet implementation catches network errors and returns a
    // string ("Fetch error: ..."), so we expect a non-error envelope.
    expect(result.isError).not.toBe(true)
    const content = result.content as Array<{ type: string; text?: string }>
    expect(content[0]?.type).toBe('text')
    expect(typeof content[0]?.text).toBe('string')
  })

  ;(skipNetwork ? it.skip : it)(
    'internet_search returns a text envelope for a real query',
    async () => {
      const result = await client.callTool({
        name: 'rivetos.internet_search',
        arguments: { query: 'rivetos github', count: 3 },
      })

      expect(result.isError).not.toBe(true)
      const content = result.content as Array<{ type: string; text?: string }>
      expect(content[0]?.type).toBe('text')
      expect(typeof content[0]?.text).toBe('string')
      expect((content[0]?.text ?? '').length).toBeGreaterThan(0)
    },
    20_000,
  )
})
