/**
 * Integration tests for the per-session `rivetos.session.attach` tool.
 *
 * Covers:
 *   - tool is auto-registered on every session
 *   - calling it returns the canonical `{sessionId, serverName, serverVersion,
 *     capabilities, attachedAt}` payload
 *   - the server's session map records the attach payload for observability
 *   - capabilities.tools includes both shared tools and `rivetos.session.attach`
 */

import { describe, it, expect, afterEach } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import { createMcpServer, defaultEchoTool, type RivetMcpServer } from '../server.js'

interface Harness {
  server: RivetMcpServer
  client: Client
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop()
    if (fn) await fn()
  }
})

async function setup(): Promise<Harness> {
  const server = createMcpServer({
    host: '127.0.0.1',
    port: 0,
    tools: [defaultEchoTool()],
    log: () => {
      /* quiet */
    },
  })
  await server.start()
  cleanups.push(() => server.stop())

  const url = new URL(`http://${server.address.host ?? '127.0.0.1'}:${String(server.address.port ?? 0)}/mcp`)
  const client = new Client({ name: 'session-attach-test', version: '0.0.0' })
  const transport = new StreamableHTTPClientTransport(url)
  await client.connect(transport)
  cleanups.push(() => client.close())

  return { server, client }
}

describe('rivetos.session.attach', () => {
  it('appears in the tool list of every session', async () => {
    const { client } = await setup()
    const list = await client.listTools()
    const names = list.tools.map((t) => t.name)
    expect(names).toContain('rivetos.session.attach')
    expect(names).toContain('rivetos.echo')
  })

  it('returns a canonical attach payload', async () => {
    const { client } = await setup()
    const result = await client.callTool({
      name: 'rivetos.session.attach',
      arguments: {
        agent: 'claude-cli',
        runtimePid: 4242,
        clientName: 'mcp-inspector/0.1.0',
      },
    })
    expect(result.isError).not.toBe(true)
    const content = result.content as Array<{ type: string; text?: string }>
    expect(content[0]?.type).toBe('text')
    const payload = JSON.parse(content[0]?.text ?? '{}') as {
      sessionId: string
      serverName: string
      serverVersion: string
      capabilities: { tools: string[] }
      attachedAt: number
    }
    expect(payload.serverName).toBe('rivetos-mcp-server')
    expect(payload.sessionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(payload.capabilities.tools).toContain('rivetos.echo')
    expect(payload.capabilities.tools).toContain('rivetos.session.attach')
    expect(payload.attachedAt).toBeGreaterThan(0)
  })

  it('records the attach state on the server', async () => {
    const { server, client } = await setup()
    await client.callTool({
      name: 'rivetos.session.attach',
      arguments: {
        agent: 'opus',
        runtimePid: 7777,
        clientName: 'rivetos-runtime/0.4.0-beta.5',
      },
    })

    // After the round-trip, the server should have one attached session.
    const states = [...server.sessions.values()]
    expect(states.length).toBe(1)
    const state = states[0]
    expect(state.agent).toBe('opus')
    expect(state.runtimePid).toBe(7777)
    expect(state.clientName).toBe('rivetos-runtime/0.4.0-beta.5')
    expect(typeof state.sessionId).toBe('string')
    expect(state.attachedAt).toBeGreaterThan(0)
  })

  it('runs without arguments (all fields optional)', async () => {
    const { client } = await setup()
    const result = await client.callTool({
      name: 'rivetos.session.attach',
      arguments: {},
    })
    expect(result.isError).not.toBe(true)
    const content = result.content as Array<{ type: string; text?: string }>
    const payload = JSON.parse(content[0]?.text ?? '{}') as { sessionId: string }
    expect(payload.sessionId).toMatch(/^[0-9a-f-]{36}$/)
  })
})
