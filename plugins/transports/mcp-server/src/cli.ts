#!/usr/bin/env node
/**
 * `rivetos-mcp-server` — standalone entrypoint.
 *
 * Phase 1.A — Slice 3: starts the StreamableHTTP server with the default
 * echo smoke-test tool, the full memory data-plane (when `RIVETOS_PG_URL`
 * is set), and web tools (always enabled).
 *
 * Env:
 *   MCP_HOST                — default 127.0.0.1
 *   MCP_PORT                — default 5700
 *   RIVETOS_PG_URL          — postgres connection string. If set, enables
 *                             `rivetos.memory_search`, `rivetos.memory_browse`,
 *                             and `rivetos.memory_stats`.
 *   RIVETOS_EMBED_URL       — optional embedding endpoint for hybrid search
 *   RIVETOS_EMBED_MODEL     — optional embedding model (default: nemotron)
 *   GOOGLE_CSE_API_KEY      — optional, enables Google search backend for
 *                             `rivetos.internet_search` (DuckDuckGo fallback
 *                             always available)
 *   GOOGLE_CSE_ID           — required alongside GOOGLE_CSE_API_KEY
 *   RIVETOS_USER_AGENT      — optional override for `rivetos.web_fetch`
 *   RIVETOS_SKILL_DIRS      — colon-separated dirs to scan for skills.
 *                             Default: ${HOME}/.rivetos/skills. Both workspace
 *                             and system dirs are writable from MCP.
 *
 * Real config (cert paths, full tool registrations, runtime-RPC) lands in
 * subsequent slices.
 */

import { createMcpServer, defaultEchoTool, type ToolRegistration } from './server.js'
import { createMemoryTools, type MemoryToolsHandle } from './tools/memory.js'
import { createSkillTools, type SkillToolsHandle } from './tools/skills.js'
import { createWebTools, type WebToolsHandle } from './tools/web.js'

async function main(): Promise<void> {
  const host = process.env.MCP_HOST ?? '127.0.0.1'
  const port = Number.parseInt(process.env.MCP_PORT ?? '5700', 10)

  const tools: ToolRegistration[] = [defaultEchoTool()]
  const cleanups: Array<() => Promise<void>> = []

  // --- Memory tools (require Postgres) -------------------------------------
  const pgUrl = process.env.RIVETOS_PG_URL
  if (pgUrl) {
    try {
      const handle: MemoryToolsHandle = createMemoryTools({
        pgUrl,
        embedEndpoint: process.env.RIVETOS_EMBED_URL,
        embedModel: process.env.RIVETOS_EMBED_MODEL,
      })
      tools.push(...handle.tools)
      cleanups.push(() => handle.close())
      console.log(
        `[rivetos-mcp-server] memory tools enabled (${String(handle.tools.length)}: ${handle.tools.map((t) => t.name).join(', ')})`,
      )
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[rivetos-mcp-server] failed to enable memory tools: ${message}`)
    }
  } else {
    console.log(
      '[rivetos-mcp-server] RIVETOS_PG_URL not set — memory tools disabled (echo + web only)',
    )
  }

  // --- Skill tools (always available) --------------------------------------
  try {
    const handle: SkillToolsHandle = await createSkillTools({
      embedEndpoint: process.env.RIVETOS_EMBED_URL,
    })
    tools.push(...handle.tools)
    cleanups.push(() => handle.close())
    const dirs = handle.manager.getSkillDirs()
    const count = handle.manager.list().length
    console.log(
      `[rivetos-mcp-server] skill tools enabled (${handle.tools.map((t) => t.name).join(', ')}) — ${String(count)} skills discovered from ${String(dirs.length)} dir(s): ${dirs.join(', ')}`,
    )
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[rivetos-mcp-server] failed to enable skill tools: ${message}`)
  }

  // --- Web tools (always available) ----------------------------------------
  try {
    const handle: WebToolsHandle = createWebTools()
    tools.push(...handle.tools)
    cleanups.push(() => handle.close())
    const hasGoogle = Boolean(
      (process.env.GOOGLE_CSE_API_KEY ?? process.env.GOOGLE_API_KEY) && process.env.GOOGLE_CSE_ID,
    )
    console.log(
      `[rivetos-mcp-server] web tools enabled (${handle.tools.map((t) => t.name).join(', ')})` +
        (hasGoogle
          ? ' [search backend: Google CSE → DuckDuckGo fallback]'
          : ' [search backend: DuckDuckGo only — set GOOGLE_CSE_API_KEY + GOOGLE_CSE_ID for Google]'),
    )
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[rivetos-mcp-server] failed to enable web tools: ${message}`)
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
