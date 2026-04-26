#!/usr/bin/env node
/**
 * `rivetos-mcp-server` — standalone entrypoint.
 *
 * Phase 1.A — Slice 2: starts the StreamableHTTP server with the default
 * echo smoke-test tool and (when configured) the `rivetos.memory_search`
 * data-plane tool.
 *
 * Env:
 *   MCP_HOST                — default 127.0.0.1
 *   MCP_PORT                — default 5700
 *   RIVETOS_PG_URL          — postgres connection string. If set, enables
 *                             `rivetos.memory_search` and (eventually) the
 *                             rest of the memory tool surface.
 *   RIVETOS_EMBED_URL       — optional embedding endpoint for hybrid search
 *   RIVETOS_EMBED_MODEL     — optional embedding model (default: nemotron)
 *
 * Real config (cert paths, full tool registrations, runtime-RPC) lands in
 * subsequent slices.
 */

import { createMcpServer, defaultEchoTool, type ToolRegistration } from './server.js'
import { createMemorySearchTool, type MemorySearchToolHandle } from './tools/memory-search.js'

async function main(): Promise<void> {
  const host = process.env.MCP_HOST ?? '127.0.0.1'
  const port = Number.parseInt(process.env.MCP_PORT ?? '5700', 10)

  const tools: ToolRegistration[] = [defaultEchoTool()]
  const cleanups: Array<() => Promise<void>> = []

  const pgUrl = process.env.RIVETOS_PG_URL
  if (pgUrl) {
    try {
      const handle: MemorySearchToolHandle = createMemorySearchTool({
        pgUrl,
        embedEndpoint: process.env.RIVETOS_EMBED_URL,
        embedModel: process.env.RIVETOS_EMBED_MODEL,
      })
      tools.push(handle.tool)
      cleanups.push(() => handle.close())
      console.log('[rivetos-mcp-server] memory_search tool enabled')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[rivetos-mcp-server] failed to enable memory_search: ${message}`)
    }
  } else {
    console.log(
      '[rivetos-mcp-server] RIVETOS_PG_URL not set — memory tools disabled (echo-only mode)',
    )
  }

  const server = createMcpServer({ host, port, tools })
  await server.start()

  const shutdown = (signal: string) => {
    console.log(`[rivetos-mcp-server] received ${signal}, shutting down`)
    Promise.allSettled(cleanups.map((fn) => fn()))
      .then(() => server.stop())
      .then(() => {
        process.exit(0)
      })
      .catch((err: unknown) => {
        console.error('[rivetos-mcp-server] shutdown error', err)
        process.exit(1)
      })
  }

  process.on('SIGINT', () => {
    shutdown('SIGINT')
  })
  process.on('SIGTERM', () => {
    shutdown('SIGTERM')
  })
}

main().catch((err: unknown) => {
  console.error('[rivetos-mcp-server] fatal', err)
  process.exit(1)
})
