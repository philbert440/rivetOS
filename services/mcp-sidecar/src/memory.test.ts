/**
 * Integration test for the full memory data-plane over MCP — `memory_search`,
 * `memory_browse`, `memory_stats`, `memory_get_full`.
 *
 * Requires a live Postgres with the RivetOS schema. Skips automatically when
 * `RIVETOS_PG_URL` is not set so local dev / CI without a DB doesn't see
 * spurious failures.
 *
 * Asserts the wire surface, not the underlying SQL — i.e. that a real MCP
 * client can call each tool and receive a non-error text response. Search
 * relevance, browse pagination, stats accuracy, and JSONL re-read fidelity
 * are covered by unit tests in `@rivetos/memory-postgres`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { defaultEchoTool } from '@rivetos/mcp'
import {
  connectV2,
  createV2McpServer,
  type V2McpConnection,
  type V2McpServer,
} from '@rivetos/mcp-v2'
import { createMemoryTools, type MemoryToolsHandle } from './memory.js'

const PG_URL = process.env.RIVETOS_PG_URL ?? ''
const describeIfPg = PG_URL ? describe : describe.skip

describeIfPg('memory data-plane (Phase 1.A slice 3)', () => {
  let server: V2McpServer
  let client: V2McpConnection
  let memoryHandle: MemoryToolsHandle

  // Envelope-preserving shim over connectV2's callToolRaw — these tests
  // assert on content/isError rather than callTool's unwrapped string.
  function callTool(params: { name: string; arguments: Record<string, unknown> }) {
    return client.callToolRaw(params.name, params.arguments)
  }

  beforeAll(async () => {
    memoryHandle = createMemoryTools({ pgUrl: PG_URL })

    server = createV2McpServer({
      host: '127.0.0.1',
      port: 0,
      tools: [defaultEchoTool(), ...memoryHandle.tools],
    })
    await server.start()

    client = await connectV2({
      name: 'memory-tools-test',
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
    await memoryHandle.close().catch(() => {
      /* swallow */
    })
  })

  it('lists memory tools alongside echo (write tools disabled by default)', async () => {
    const names = (await client.listTools()).map((t) => t.name)
    expect(names).toContain('memory_search')
    expect(names).toContain('memory_browse')
    expect(names).toContain('memory_stats')
    expect(names).toContain('memory_get_full')
    expect(names).not.toContain('memory_append')
    expect(names).not.toContain('memory_ingest_session')
    expect(names).toContain('echo')
  })

  it('memory_search returns a text response for a real query', async () => {
    const result = await callTool({
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
    const result = await callTool({
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
    const result = await callTool({
      name: 'memory_stats',
      arguments: {},
    })

    expect(result.isError).not.toBe(true)
    const content = result.content as Array<{ type: string; text?: string }>
    expect(content.length).toBeGreaterThan(0)
    expect(content[0]?.type).toBe('text')
    expect(content[0]?.text).toContain('Memory System Health')
  })

  it('memory_get_full accepts an id and returns a text response', async () => {
    // Wire-surface only: unknown id is a soft tool text reply (not MCP error).
    // Full JSONL re-read coverage lives in @rivetos/memory-postgres get-full tests.
    const result = await callTool({
      name: 'memory_get_full',
      arguments: { id: '00000000-0000-0000-0000-000000000000' },
    })

    expect(result.isError).not.toBe(true)
    const content = result.content as Array<{ type: string; text?: string }>
    expect(content.length).toBeGreaterThan(0)
    expect(content[0]?.type).toBe('text')
    expect(typeof content[0]?.text).toBe('string')
    expect(content[0]?.text).toMatch(
      /No message with id|memory_get_full failed|row was not truncated|Full payload/,
    )
  })
})

describeIfPg('memory write tools (Phase 1.A slice 3 — gated)', () => {
  let server: V2McpServer
  let client: V2McpConnection
  let memoryHandle: MemoryToolsHandle

  function callTool(params: { name: string; arguments: Record<string, unknown> }) {
    return client.callToolRaw(params.name, params.arguments)
  }

  beforeAll(async () => {
    memoryHandle = createMemoryTools({ pgUrl: PG_URL, enableWrite: true })

    server = createV2McpServer({
      host: '127.0.0.1',
      port: 0,
      tools: [defaultEchoTool(), ...memoryHandle.tools],
    })
    await server.start()

    client = await connectV2({
      name: 'memory-write-tools-test',
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
    await memoryHandle.close().catch(() => {
      /* swallow */
    })
  })

  it('lists memory_append and memory_ingest_session when write is enabled', async () => {
    const names = (await client.listTools()).map((t) => t.name)
    expect(names).toContain('memory_search')
    expect(names).toContain('memory_browse')
    expect(names).toContain('memory_stats')
    expect(names).toContain('memory_get_full')
    expect(names).toContain('memory_append')
    expect(names).toContain('memory_ingest_session')
    expect(names).toContain('echo')
  })

  it('memory_append writes a message and returns its id', async () => {
    const sessionId = `test-session-${Date.now()}`
    const result = await callTool({
      name: 'memory_append',
      arguments: {
        session_id: sessionId,
        content: 'Test message from memory_append',
        role: 'assistant',
        source: 'test',
        agent: 'test-agent',
        channel: 'test-channel',
      },
    })

    expect(result.isError).not.toBe(true)
    const content = result.content as Array<{ type: string; text?: string }>
    expect(content.length).toBeGreaterThan(0)
    expect(content[0]?.type).toBe('text')
    const parsed = JSON.parse(content[0]?.text ?? '{}')
    expect(parsed.id).toBeDefined()
    expect(parsed.session_id).toBe(sessionId)
    expect(parsed.source).toBe('test')
    expect(parsed.agent).toBe('test-agent')
    expect(parsed.channel).toBe('test-channel')
  })

  it('memory_ingest_session writes multiple messages and returns result', async () => {
    const sessionId = `test-ingest-${Date.now()}`
    const result = await callTool({
      name: 'memory_ingest_session',
      arguments: {
        session_id: sessionId,
        messages: [
          { role: 'user', content: 'First message' },
          { role: 'assistant', content: 'Second message' },
          { role: 'user', content: 'Third message' },
        ],
        source: 'test',
        agent: 'test-agent',
        channel: 'test-channel',
      },
    })

    expect(result.isError).not.toBe(true)
    const content = result.content as Array<{ type: string; text?: string }>
    expect(content.length).toBeGreaterThan(0)
    expect(content[0]?.type).toBe('text')
    const parsed = JSON.parse(content[0]?.text ?? '{}')
    expect(parsed.session_id).toBe(sessionId)
    expect(parsed.ingested).toBe(3)
    expect(parsed.skipped).toBe(0)
    expect(parsed.ids).toHaveLength(3)
    expect(parsed.source).toBe('test')
    expect(parsed.agent).toBe('test-agent')
    expect(parsed.channel).toBe('test-channel')
  })
})

describeIfPg('ingestSession function (Phase 1.A slice 3)', () => {
  let memory: { close: () => Promise<void> }

  beforeAll(async () => {
    const { PostgresMemory } = await import('@rivetos/memory-postgres')
    memory = new PostgresMemory({
      connectionString: PG_URL,
      embedEndpoint: process.env.RIVETOS_EMBED_URL,
      embedModel: process.env.RIVETOS_EMBED_MODEL,
    })
  })

  afterAll(async () => {
    await memory.close().catch(() => {
      /* swallow */
    })
  })

  it('ingests new messages and skips duplicates', async () => {
    const { ingestSession } = await import('./memory-write.js')
    const { PostgresMemory } = await import('@rivetos/memory-postgres')
    const testMemory = new PostgresMemory({
      connectionString: PG_URL,
      embedEndpoint: process.env.RIVETOS_EMBED_URL,
      embedModel: process.env.RIVETOS_EMBED_MODEL,
    })

    const sessionId = `test-ingest-fn-${Date.now()}`
    const messages = [
      { role: 'user' as const, content: 'Message 0' },
      { role: 'assistant' as const, content: 'Message 1' },
      { role: 'user' as const, content: 'Message 2' },
    ]

    const firstRun = await ingestSession(testMemory, {
      sessionId,
      messages,
      source: 'test',
      agent: 'test-agent-fn',
      channel: 'test-channel',
    })

    expect(firstRun.session_id).toBe(sessionId)
    expect(firstRun.ingested).toBe(3)
    expect(firstRun.skipped).toBe(0)
    expect(firstRun.ids).toHaveLength(3)
    expect(firstRun.source).toBe('test')
    expect(firstRun.agent).toBe('test-agent-fn')
    expect(firstRun.channel).toBe('test-channel')

    const secondRun = await ingestSession(testMemory, {
      sessionId,
      messages: [...messages, { role: 'assistant' as const, content: 'Message 3' }],
      source: 'test',
      agent: 'test-agent-fn',
      channel: 'test-channel',
    })

    expect(secondRun.ingested).toBe(1)
    expect(secondRun.skipped).toBe(3)
    expect(secondRun.ids).toHaveLength(1)

    await testMemory.close()
  })

  it('uses default tags from environment variables', async () => {
    const { ingestSession } = await import('./memory-write.js')
    const { PostgresMemory } = await import('@rivetos/memory-postgres')
    const testMemory = new PostgresMemory({
      connectionString: PG_URL,
      embedEndpoint: process.env.RIVETOS_EMBED_URL,
      embedModel: process.env.RIVETOS_EMBED_MODEL,
    })

    const oldSource = process.env.RIVETOS_MEMORY_SOURCE
    const oldAgent = process.env.RIVETOS_MEMORY_AGENT
    const oldChannel = process.env.RIVETOS_MEMORY_CHANNEL

    process.env.RIVETOS_MEMORY_SOURCE = 'env-test-source'
    process.env.RIVETOS_MEMORY_AGENT = 'env-test-agent'
    process.env.RIVETOS_MEMORY_CHANNEL = 'env-test-channel'

    try {
      const sessionId = `test-env-defaults-${Date.now()}`
      const result = await ingestSession(testMemory, {
        sessionId,
        messages: [{ role: 'user' as const, content: 'Test message' }],
      })

      expect(result.source).toBe('env-test-source')
      expect(result.agent).toBe('env-test-agent')
      expect(result.channel).toBe('env-test-channel')
    } finally {
      if (oldSource !== undefined) process.env.RIVETOS_MEMORY_SOURCE = oldSource
      else delete process.env.RIVETOS_MEMORY_SOURCE
      if (oldAgent !== undefined) process.env.RIVETOS_MEMORY_AGENT = oldAgent
      else delete process.env.RIVETOS_MEMORY_AGENT
      if (oldChannel !== undefined) process.env.RIVETOS_MEMORY_CHANNEL = oldChannel
      else delete process.env.RIVETOS_MEMORY_CHANNEL
    }

    await testMemory.close()
  })
})
