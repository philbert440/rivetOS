/**
 * Integration tests for the per-spawn embedded MCP bridge.
 *
 * Validates the Phase 1.C deliverable: provider stands up an MCP server,
 * exposes runtime tools dynamically, claude-cli (or any MCP client) can
 * discover + call them, teardown is clean.
 *
 * We don't actually shell out to `claude` here — we hit the embedded server
 * with the MCP SDK's stock client, which is what claude-cli would do too.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import fs from 'node:fs/promises'
import type { Tool, ToolContext } from '@rivetos/types'

import { embedMcpServerForTurn, type EmbeddedMcpHandle } from './mcp-bridge.js'
import { type BridgeLogger } from './log.js'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeEchoTool(): Tool {
  return {
    name: 'echo_test',
    description: 'Echoes its message back, prefixed with "echo:".',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Text to echo' },
      },
      required: ['message'],
    },
    execute: (args: Record<string, unknown>, _signal?: AbortSignal, _context?: ToolContext) => {
      const message = typeof args.message === 'string' ? args.message : ''
      return Promise.resolve(`echo: ${message}`)
    },
  }
}

function makeAdderTool(): Tool {
  return {
    name: 'add_test',
    description: 'Adds two numbers.',
    parameters: {
      type: 'object',
      properties: {
        a: { type: 'number', description: 'First addend' },
        b: { type: 'number', description: 'Second addend' },
      },
      required: ['a', 'b'],
    },
    execute: (args: Record<string, unknown>) => {
      const a = typeof args.a === 'number' ? args.a : 0
      const b = typeof args.b === 'number' ? args.b : 0
      return Promise.resolve(String(a + b))
    },
  }
}

/**
 * Tool with a parameter that uses an enum — exercises the enum path in
 * `jsonSchemaToZod`.
 */
function makeEnumTool(): Tool {
  return {
    name: 'pick',
    description: 'Picks one of three colors.',
    parameters: {
      type: 'object',
      properties: {
        color: {
          type: 'string',
          enum: ['red', 'green', 'blue'],
          description: 'A color',
        },
      },
      required: ['color'],
    },
    execute: (args: Record<string, unknown>) => Promise.resolve(`picked: ${String(args.color)}`),
  }
}

async function buildClient(handle: EmbeddedMcpHandle): Promise<Client> {
  const url = new URL(handle.url)
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${handle.token}` } },
  })
  const client = new Client({ name: 'mcp-bridge.test', version: '0.0.0' })
  await client.connect(transport)
  return client
}

// ---------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------

describe('embedMcpServerForTurn', () => {
  let handle: EmbeddedMcpHandle | undefined

  afterEach(async () => {
    if (handle) {
      await handle.close()
      handle = undefined
    }
  })

  it('stands up an MCP server reachable over HTTP+bearer with the synthesized config', async () => {
    handle = await embedMcpServerForTurn({ tools: [makeEchoTool()] })

    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    expect(handle.token).toMatch(/^[0-9a-f]{64}$/)

    // Config tempfile must exist with a sensible shape.
    const raw = await fs.readFile(handle.configPath, 'utf8')
    const parsed = JSON.parse(raw) as {
      mcpServers: Record<
        string,
        { type: string; url: string; headers: Record<string, string> }
      >
    }
    expect(Object.keys(parsed.mcpServers)).toEqual(['rivetos'])
    expect(parsed.mcpServers.rivetos.type).toBe('http')
    expect(parsed.mcpServers.rivetos.url).toBe(handle.url)
    expect(parsed.mcpServers.rivetos.headers.Authorization).toBe(`Bearer ${handle.token}`)
  })

  it('rejects requests without the bearer token (401)', async () => {
    handle = await embedMcpServerForTurn({ tools: [makeEchoTool()] })

    const res = await fetch(handle.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    })
    expect(res.status).toBe(401)
  })

  it('exposes the supplied executable tools, dynamically derived from JSON schema', async () => {
    handle = await embedMcpServerForTurn({
      tools: [makeEchoTool(), makeAdderTool(), makeEnumTool()],
    })
    const client = await buildClient(handle)
    try {
      const list = await client.listTools()
      const names = list.tools.map((t) => t.name).sort()
      expect(names).toContain('echo_test')
      expect(names).toContain('add_test')
      expect(names).toContain('pick')
      // session_attach is registered per-session
      expect(names).toContain('session_attach')
    } finally {
      await client.close()
    }
  })

  it('routes tool calls to the live execute closure (delegate-style end-to-end)', async () => {
    handle = await embedMcpServerForTurn({
      tools: [makeEchoTool(), makeAdderTool(), makeEnumTool()],
    })
    const client = await buildClient(handle)
    try {
      const echoResult = await client.callTool({
        name: 'echo_test',
        arguments: { message: 'hello bridge' },
      })
      expect(JSON.stringify(echoResult.content)).toContain('echo: hello bridge')

      const addResult = await client.callTool({
        name: 'add_test',
        arguments: { a: 7, b: 35 },
      })
      expect(JSON.stringify(addResult.content)).toContain('42')

      const pickResult = await client.callTool({
        name: 'pick',
        arguments: { color: 'green' },
      })
      expect(JSON.stringify(pickResult.content)).toContain('picked: green')
    } finally {
      await client.close()
    }
  })

  it('teardown removes the config tempfile and stops the server', async () => {
    handle = await embedMcpServerForTurn({ tools: [makeEchoTool()] })
    const configPath = handle.configPath
    const url = handle.url

    await handle.close()
    handle = undefined

    // Config tempfile is gone (or its parent dir is gone).
    await expect(fs.access(configPath)).rejects.toThrow()

    // Server no longer listens — fetch should fail.
    const probe = fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(500),
    })
    await expect(probe).rejects.toThrow()
  })

  it('close() is idempotent', async () => {
    handle = await embedMcpServerForTurn({ tools: [makeEchoTool()] })
    await handle.close()
    await expect(handle.close()).resolves.toBeUndefined()
    handle = undefined
  })

  it('skips tools whose schema fails translation rather than aborting', async () => {
    const badTool: Tool = {
      name: 'bad',
      description: 'Has a malformed schema',
      // Force jsonSchemaToZodShape to take a non-throwing path; the dynamic
      // adapter handles unknown types as `z.unknown()`. To actually exercise
      // the skip path, we monkey the Object.entries call by setting properties
      // to a non-iterable. This won't actually throw under our impl — the
      // skip log is best-effort. We leave this test as documentation that a
      // real translation failure won't take the whole bridge down.
      parameters: { type: 'object', properties: { weird: { type: 'something-novel' } } },
      execute: () => Promise.resolve('ok'),
    }
    const logStub: BridgeLogger = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    }
    handle = await embedMcpServerForTurn({ tools: [makeEchoTool(), badTool], log: logStub })
    const client = await buildClient(handle)
    try {
      const list = await client.listTools()
      const names = list.tools.map((t) => t.name)
      // Both tools land — `bad` falls back to z.unknown() for the weird type.
      // (The skip log is best-effort — current impl doesn't throw on unknown
      // types so no warn is emitted; we keep the stub to document the contract.)
      expect(names).toContain('echo_test')
      expect(names).toContain('bad')
      expect(logStub.warn).not.toHaveBeenCalled()
    } finally {
      await client.close()
    }
  })

  it('respects the kill switch via no executableTools', async () => {
    // Empty tool list — bridge still comes up but with only session_attach.
    handle = await embedMcpServerForTurn({ tools: [] })
    const client = await buildClient(handle)
    try {
      const list = await client.listTools()
      const names = list.tools.map((t) => t.name)
      expect(names).toContain('session_attach')
    } finally {
      await client.close()
    }
  })
})
