/**
 * Integration tests for the per-spawn embedded MCP bridge.
 *
 * Default path is MCP 2026-07-28 final (v2, stateless). The v1 fallback is
 * still covered so we can roll back via RIVETOS_MCP_BRIDGE_PROTOCOL=v1
 * if a Claude Code build has not yet rolled out 2026-07-28 support.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
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

/** v2 client against an embedded handle. */
async function buildV2Client(handle: EmbeddedMcpHandle) {
  const { connectV2 } = await import('@rivetos/mcp-v2')
  return connectV2({
    name: 'mcp-bridge.test',
    url: handle.url,
    authToken: handle.token,
  })
}

/** v1 client (sessionful SDK) against an embedded handle. */
async function buildV1Client(handle: EmbeddedMcpHandle) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StreamableHTTPClientTransport } =
    await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
  const transport = new StreamableHTTPClientTransport(new URL(handle.url), {
    requestInit: { headers: { Authorization: `Bearer ${handle.token}` } },
  })
  const client = new Client({ name: 'mcp-bridge.test', version: '0.0.0' })
  await client.connect(transport)
  return client
}

// ---------------------------------------------------------------------------
// Specs — default v2
// ---------------------------------------------------------------------------

describe('embedMcpServerForTurn (v2 / 2026-07-28 default)', () => {
  let handle: EmbeddedMcpHandle | undefined

  afterEach(async () => {
    if (handle) {
      await handle.close()
      handle = undefined
    }
  })

  it('stands up a v2 MCP server with synthesized config', async () => {
    handle = await embedMcpServerForTurn({ tools: [makeEchoTool()] })
    expect(handle.protocol).toBe('v2')
    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    expect(handle.token).toMatch(/^[0-9a-f]{64}$/)

    const raw = await fs.readFile(handle.configPath, 'utf8')
    const parsed = JSON.parse(raw) as {
      mcpServers: Record<string, { type: string; url: string; headers: Record<string, string> }>
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
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    expect(res.status).toBe(401)
  })

  it('exposes executable tools without session_attach (stateless)', async () => {
    handle = await embedMcpServerForTurn({
      tools: [makeEchoTool(), makeAdderTool(), makeEnumTool()],
    })
    const client = await buildV2Client(handle)
    try {
      const tools = await client.listTools()
      const names = tools.map((t) => t.name).sort()
      expect(names).toContain('echo_test')
      expect(names).toContain('add_test')
      expect(names).toContain('pick')
      expect(names).not.toContain('session_attach')
    } finally {
      await client.close()
    }
  })

  it('routes tool calls to the live execute closure', async () => {
    handle = await embedMcpServerForTurn({
      tools: [makeEchoTool(), makeAdderTool(), makeEnumTool()],
    })
    const client = await buildV2Client(handle)
    try {
      expect(await client.callTool('echo_test', { message: 'hello bridge' })).toContain(
        'echo: hello bridge',
      )
      expect(await client.callTool('add_test', { a: 7, b: 35 })).toContain('42')
      expect(await client.callTool('pick', { color: 'green' })).toContain('picked: green')
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

    await expect(fs.access(configPath)).rejects.toThrow()

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
    const client = await buildV2Client(handle)
    try {
      const names = (await client.listTools()).map((t) => t.name)
      expect(names).toContain('echo_test')
      expect(names).toContain('bad')
      expect(logStub.warn).not.toHaveBeenCalled()
    } finally {
      await client.close()
    }
  })

  it('empty tool list comes up with zero tools (no session_attach on v2)', async () => {
    handle = await embedMcpServerForTurn({ tools: [] })
    const client = await buildV2Client(handle)
    try {
      expect(await client.listTools()).toEqual([])
    } finally {
      await client.close()
    }
  })
})

// ---------------------------------------------------------------------------
// Specs — v1 fallback
// ---------------------------------------------------------------------------

describe('embedMcpServerForTurn (v1 fallback)', () => {
  let handle: EmbeddedMcpHandle | undefined

  afterEach(async () => {
    if (handle) {
      await handle.close()
      handle = undefined
    }
  })

  it('exposes session_attach on the sessionful path', async () => {
    handle = await embedMcpServerForTurn({
      protocol: 'v1',
      tools: [makeEchoTool()],
    })
    expect(handle.protocol).toBe('v1')
    const client = await buildV1Client(handle)
    try {
      const list = await client.listTools()
      const names = list.tools.map((t) => t.name)
      expect(names).toContain('echo_test')
      expect(names).toContain('session_attach')
    } finally {
      await client.close()
    }
  })

  it('routes tool calls on v1', async () => {
    handle = await embedMcpServerForTurn({
      protocol: 'v1',
      tools: [makeEchoTool()],
    })
    const client = await buildV1Client(handle)
    try {
      const result = await client.callTool({
        name: 'echo_test',
        arguments: { message: 'v1 path' },
      })
      expect(JSON.stringify(result.content)).toContain('echo: v1 path')
    } finally {
      await client.close()
    }
  })
})
