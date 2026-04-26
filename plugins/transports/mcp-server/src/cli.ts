#!/usr/bin/env node
/**
 * `rivetos-mcp-server` — standalone entrypoint.
 *
 * Phase 1.A — Slice 1: starts the bare server with the default echo tool.
 * Reads `MCP_HOST` and `MCP_PORT` from env. Real config (cert paths,
 * tool registrations) lands in subsequent slices.
 */

import { createMcpServer } from './server.js'

async function main(): Promise<void> {
  const host = process.env.MCP_HOST ?? '127.0.0.1'
  const port = Number.parseInt(process.env.MCP_PORT ?? '5700', 10)

  const server = createMcpServer({ host, port })
  await server.start()

  const shutdown = (signal: string) => {
    console.log(`[rivetos-mcp-server] received ${signal}, shutting down`)
    server
      .stop()
      .then(() => process.exit(0))
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
