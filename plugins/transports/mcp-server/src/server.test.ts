/**
 * Integration test — round-trips initialize → tools/list → tools/call
 * against a real RivetMcpServer over HTTP on an ephemeral port.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { z } from 'zod'

import { createMcpServer, type RivetMcpServer, type ToolRegistration } from './server.js'

interface Harness {
  server: RivetMcpServer
  client: Client
  url: URL
}

async function setup(tools?: ToolRegistration[]): Promise<Harness> {
  const server = createMcpServer({
    host: '127.0.0.1',
    port: 0, // OS-assigned ephemeral port
    tools,
    log: () => {
      // Quiet during tests.
    },
  })
  await server.start()

  const url = new URL(`http://${server.address.host}:${String(server.address.port)}/mcp`)
  const client = new Client({ name: 'rivetos-mcp-server-test', version: '0.0.0' })
  const transport = new StreamableHTTPClientTransport(url)
  await client.connect(transport)

  return { server, client, url }
}

async function teardown(h: Harness): Promise<void> {
  await h.client.close()
  await h.server.stop()
}

describe('RivetMcpServer (Phase 1.A slice 1)', () => {
  let h: Harness

  afterEach(async () => {
    if (h) await teardown(h)
  })

  it('responds to /health/live without auth', async () => {
    h = await setup()
    const healthUrl = new URL(`http://${h.server.address.host}:${String(h.server.address.port)}/health/live`)

    const res = await fetch(healthUrl)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string; name: string }
    expect(body.status).toBe('ok')
    expect(body.name).toBe('rivetos-mcp-server')
  })

  it('lists the default echo tool', async () => {
    h = await setup()
    const tools = await h.client.listTools()
    const names = tools.tools.map((t) => t.name)
    expect(names).toContain('echo')
  })

  it('round-trips a tool call via the echo tool', async () => {
    h = await setup()
    const result = await h.client.callTool({
      name: 'echo',
      arguments: { message: 'hello world' },
    })

    expect(result.isError).not.toBe(true)
    const content = result.content as Array<{ type: string; text?: string }>
    expect(content[0]?.type).toBe('text')
    expect(content[0]?.text).toBe('echo: hello world')
  })

  it('runs a custom tool registration end-to-end', async () => {
    const adder: ToolRegistration = {
      name: 'test_adder',
      description: 'Adds two numbers — used in the integration test only.',
      inputSchema: {
        a: z.number(),
        b: z.number(),
      },
      async execute(args) {
        const a = typeof args.a === 'number' ? args.a : 0
        const b = typeof args.b === 'number' ? args.b : 0
        return String(a + b)
      },
    }

    h = await setup([adder])

    const result = await h.client.callTool({
      name: 'test_adder',
      arguments: { a: 2, b: 3 },
    })

    expect(result.isError).not.toBe(true)
    const content = result.content as Array<{ type: string; text?: string }>
    expect(content[0]?.text).toBe('5')
  })
})
