/**
 * The v2 round-trip harness — the RC-drift gate from the design consult:
 * v2 client ↔ v2 server, list + call + auth + error paths, in-process.
 * On RC final: bump all three @modelcontextprotocol packages together and
 * this suite decides the merge.
 */

import { describe, it, expect, afterEach } from 'vitest'
import * as z from 'zod'
import { adaptRivetTool } from '@rivetos/mcp'
import type { Tool } from '@rivetos/types'
import { createV2McpServer, type V2McpServer } from './server.js'
import { connectV2, type V2McpConnection } from './client.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn()
})

const echoTool: Tool = {
  name: 'echo',
  description: 'Echo the input back',
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  execute: async (args) => `echo: ${String((args as { text: string }).text)}`,
}

const failTool: Tool = {
  name: 'kaboom',
  description: 'Always fails',
  parameters: { type: 'object', properties: {} },
  execute: async () => {
    throw new Error('kaboom exploded')
  },
}

async function startPair(authToken?: string): Promise<{
  server: V2McpServer
  client: V2McpConnection
}> {
  const server = createV2McpServer({
    port: 0,
    authToken,
    tools: [
      adaptRivetTool(echoTool, { text: z.string() }),
      adaptRivetTool(failTool, {}),
    ],
  })
  await server.start()
  const client = await connectV2({
    url: `http://127.0.0.1:${server.port}/mcp`,
    authToken,
  })
  cleanups.push(async () => {
    await client.close()
    await server.close()
  })
  return { server, client }
}

describe('mcp v2 round-trip (RC-drift gate)', () => {
  it('lists tools with schemas', async () => {
    const { client } = await startPair()
    const tools = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(['echo', 'kaboom'])
    const echo = tools.find((t) => t.name === 'echo')
    expect(echo?.description).toBe('Echo the input back')
    expect(echo?.inputSchema).toMatchObject({ type: 'object' })
  })

  it('calls a tool end-to-end', async () => {
    const { client } = await startPair()
    expect(await client.callTool('echo', { text: 'ping' })).toBe('echo: ping')
  })

  it('tool failures surface as isError, not protocol crashes', async () => {
    const { client } = await startPair()
    await expect(client.callTool('kaboom', {})).rejects.toThrow(/kaboom exploded/)
    // server still healthy afterwards
    expect(await client.callTool('echo', { text: 'still up' })).toBe('echo: still up')
  })

  it('rejects wrong-length tokens (constant-time path)', async () => {
    const server = createV2McpServer({ port: 0, authToken: 'sekret', tools: [] })
    await server.start()
    cleanups.push(() => server.close())
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: 'POST',
      headers: { authorization: 'Bearer nope-way-longer-than-the-token' },
    })
    expect(res.status).toBe(401)
  })

  it('unix socket: stale socket replaced, mode 0600', async () => {
    const { mkdtempSync, statSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'mcp-v2-sock-'))
    const sock = join(dir, 'mcp.sock')
    writeFileSync(sock, '') // stale file at the socket path
    const server = createV2McpServer({ socketPath: sock, tools: [] })
    await server.start()
    cleanups.push(() => server.close())
    expect(statSync(sock).mode & 0o777).toBe(0o600)
  })

  it('bearer auth gates the MCP endpoint but not /health/live', async () => {
    const server = createV2McpServer({ port: 0, authToken: 'sekret', tools: [] })
    await server.start()
    cleanups.push(() => server.close())

    const health = await fetch(`http://127.0.0.1:${server.port}/health/live`)
    expect(health.status).toBe(200)

    await expect(connectV2({ url: `http://127.0.0.1:${server.port}/mcp` })).rejects.toThrow()
    const authed = await connectV2({
      url: `http://127.0.0.1:${server.port}/mcp`,
      authToken: 'sekret',
    })
    cleanups.push(() => authed.close())
    expect(await authed.listTools()).toEqual([])
  })
})
