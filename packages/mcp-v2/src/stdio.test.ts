/**
 * stdio mount tests — createV2StdioMcpServer over an in-process stream pair
 * (StdioServerTransport accepts arbitrary Readable/Writable, so no child
 * process is needed).
 *
 * The era-negotiation contract under test:
 *   - legacy 'serve' (default): a 2025-era `initialize` opening is served by
 *     a legacy-era instance from the same factory — this is the Claude Code /
 *     Grok stdio path, so it is the compat-critical assertion.
 *   - legacy 'reject': the opening initialize is answered with an error and
 *     never reaches a tool.
 *
 * The modern (2026-07-28) semantics are gated by roundtrip.test.ts over
 * HTTP — the era decision, not v2 semantics, is what stdio adds.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { PassThrough } from 'node:stream'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { defaultEchoTool } from '@rivetos/mcp'
import { createV2StdioMcpServer, type V2StdioMcpServer } from './server.js'

interface JsonRpcMessage {
  jsonrpc: '2.0'
  id?: number
  method?: string
  params?: Record<string, unknown>
  result?: Record<string, unknown>
  error?: { code: number; message: string }
}

interface StdioHarness {
  server: V2StdioMcpServer
  /** The stream the server reads from (client → server). */
  input: PassThrough
  request(id: number, method: string, params?: Record<string, unknown>): Promise<JsonRpcMessage>
  notify(method: string, params?: Record<string, unknown>): void
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn()
})

async function startStdioServer(legacy?: 'serve' | 'reject'): Promise<StdioHarness> {
  const clientToServer = new PassThrough()
  const serverToClient = new PassThrough()
  const transport = new StdioServerTransport(clientToServer, serverToClient)

  const server = createV2StdioMcpServer({
    tools: [defaultEchoTool()],
    transport,
    ...(legacy ? { legacy } : {}),
  })
  await server.start()
  cleanups.push(() => server.stop())

  const pending = new Map<number, (msg: JsonRpcMessage) => void>()
  let buf = ''
  serverToClient.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8')
    let nl = buf.indexOf('\n')
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      nl = buf.indexOf('\n')
      if (!line) continue
      const msg = JSON.parse(line) as JsonRpcMessage
      if (msg.id !== undefined && pending.has(msg.id)) {
        const resolve = pending.get(msg.id)
        pending.delete(msg.id)
        resolve?.(msg)
      }
    }
  })
  return {
    server,
    input: clientToServer,
    request(id, method, params) {
      return new Promise<JsonRpcMessage>((resolve, reject) => {
        pending.set(id, resolve)
        clientToServer.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id)
            reject(new Error(`timeout waiting for ${method} response`))
          }
        }, 5000)
      })
    },
    notify(method, params) {
      clientToServer.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
    },
  }
}

/** 2025-era opening — what Claude Code sends when spawning a stdio server. */
async function openLegacySession(h: StdioHarness): Promise<JsonRpcMessage> {
  const init = await h.request(1, 'initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'stdio-test-client', version: '0.0.0' },
  })
  h.notify('notifications/initialized')
  return init
}

describe('createV2StdioMcpServer (era-negotiating stdio mount)', () => {
  it('serves a 2025-era client end-to-end (initialize → list → call)', async () => {
    const h = await startStdioServer()

    const init = await openLegacySession(h)
    expect(init.error).toBeUndefined()
    const initResult = init.result as {
      protocolVersion?: string
      serverInfo?: { name?: string }
    }
    expect(initResult.serverInfo?.name).toBe('rivetos-mcp-server')
    expect(typeof initResult.protocolVersion).toBe('string')

    const list = await h.request(2, 'tools/list', {})
    expect(list.error).toBeUndefined()
    const tools = (list.result as { tools: Array<{ name: string }> }).tools
    expect(tools.map((t) => t.name)).toContain('echo')

    const call = await h.request(3, 'tools/call', {
      name: 'echo',
      arguments: { message: 'over stdio' },
    })
    expect(call.error).toBeUndefined()
    const content = (call.result as { content: Array<{ type: string; text?: string }> }).content
    expect(content[0]?.type).toBe('text')
    expect(content[0]?.text).toBe('echo: over stdio')
  })

  it("legacy 'reject' refuses a 2025-era opening", async () => {
    const h = await startStdioServer('reject')
    const init = await h.request(1, 'initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'stdio-test-client', version: '0.0.0' },
    })
    expect(init.error).toBeDefined()
    expect(init.result).toBeUndefined()
  })

  it('stop() tears the transport down', async () => {
    const h = await startStdioServer()
    await openLegacySession(h)
    expect(h.input.listenerCount('data')).toBeGreaterThan(0)
    await h.server.stop()
    // The transport must stop consuming the input stream. (It deliberately
    // does NOT end the output stream — that would close process.stdout in
    // real usage — so listener detachment is the observable teardown.)
    expect(h.input.listenerCount('data')).toBe(0)
  })

  it('start() is idempotent', async () => {
    const h = await startStdioServer()
    await h.server.start() // second start must not stand up a second transport
    const init = await openLegacySession(h)
    expect(init.error).toBeUndefined()
  })
})
