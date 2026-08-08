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
import { defaultEchoTool } from '@rivetos/mcp'
import {
  connectV2,
  createV2McpServer,
  type V2McpConnection,
  type V2McpServer,
} from '@rivetos/mcp-v2'
import { createWebTools, type WebToolsHandle } from './web.js'

const skipNetwork = process.env.RIVETOS_TEST_SKIP_NETWORK === '1'

describe('web data-plane (Phase 1.A slice 3)', () => {
  let server: V2McpServer
  let client: V2McpConnection
  let webHandle: WebToolsHandle

  // Envelope-preserving shim over connectV2's callToolRaw — these tests
  // assert on content/isError rather than callTool's unwrapped string.
  function callTool(params: { name: string; arguments: Record<string, unknown> }) {
    return client.callToolRaw(params.name, params.arguments)
  }

  beforeAll(async () => {
    webHandle = createWebTools()
    server = createV2McpServer({
      host: '127.0.0.1',
      port: 0,
      tools: [defaultEchoTool(), ...webHandle.tools],
    })
    await server.start()

    client = await connectV2({
      name: 'web-tools-test',
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
    await webHandle.close().catch(() => {
      /* swallow */
    })
  })

  it('lists both web tools alongside echo', async () => {
    const names = (await client.listTools()).map((t) => t.name)
    expect(names).toContain('internet_search')
    expect(names).toContain('web_fetch')
    expect(names).toContain('echo')
  })

  it('web_fetch returns a text envelope for an invalid URL', async () => {
    const result = await callTool({
      name: 'web_fetch',
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
      const result = await callTool({
        name: 'internet_search',
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
