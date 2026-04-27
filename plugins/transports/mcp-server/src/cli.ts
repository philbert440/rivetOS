#!/usr/bin/env node
/**
 * `rivetos-mcp-server` — standalone entrypoint.
 *
 * Phase 1.A — slice 7' adds bearer-token auth on TCP and an alternative
 * unix-socket binding (filesystem perms as auth boundary), plus the
 * `rivetos.session.attach` handshake tool. Other slices ship the data-plane
 * (memory, skills, web) and runtime-plane (delegate / subagent / shell / ...)
 * tools.
 *
 * Env:
 *   MCP_HOST                — default 127.0.0.1
 *   MCP_PORT                — default 5700
 *   RIVETOS_MCP_SOCKET      — bind to this unix socket path INSTEAD of TCP.
 *                             When set, MCP_HOST/PORT are ignored; the socket
 *                             is created mode 0600 and the bearer token is
 *                             skipped (filesystem perms ARE the auth
 *                             boundary). Set RIVETOS_MCP_REQUIRE_BEARER=1 to
 *                             demand bearer even on the socket.
 *   RIVETOS_MCP_TOKEN       — bearer token. Required for TCP binds in any
 *                             non-dev setup. Compared in constant time
 *                             against `Authorization: Bearer <token>`.
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
 *   RIVETOS_MCP_ENABLE_SHELL=1     — enables `rivetos.shell` (write surface,
 *                                    off by default). Maintains a session
 *                                    cwd across calls.
 *   RIVETOS_MCP_ENABLE_FILE=1      — enables `rivetos.file_read`,
 *                                    `rivetos.file_write`, `rivetos.file_edit`
 *                                    (write surface, off by default).
 *   RIVETOS_MCP_ENABLE_SEARCH=1    — enables `rivetos.search_glob`,
 *                                    `rivetos.search_grep` (read-only, off
 *                                    by default for symmetry; safe to enable).
 *
 * Runtime-plane tools (delegate_task, subagent_*, ask_user, todo,
 * compact_context) and the claude-cli MCP bridge land in later slices.
 */

import { createMcpServer, defaultEchoTool, type ToolRegistration } from './server.js'
import { createFileTools, type FileToolsHandle } from './tools/file.js'
import { createMemoryTools, type MemoryToolsHandle } from './tools/memory.js'
import { createSearchTools, type SearchToolsHandle } from './tools/search.js'
import { createShellTool, type ShellToolHandle } from './tools/shell.js'
import { createSkillTools, type SkillToolsHandle } from './tools/skills.js'
import { createWebTools, type WebToolsHandle } from './tools/web.js'

async function main(): Promise<void> {
  const host = process.env.MCP_HOST ?? '127.0.0.1'
  const port = Number.parseInt(process.env.MCP_PORT ?? '5700', 10)
  const socketPath = process.env.RIVETOS_MCP_SOCKET
  const authToken = process.env.RIVETOS_MCP_TOKEN
  const requireBearerOnSocket = process.env.RIVETOS_MCP_REQUIRE_BEARER === '1'

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

  // --- Utility tools (opt-in — write surfaces) -----------------------------
  // Enable shell + file_write/edit + search by setting the env vars below.
  // These are gated because they expose the MCP server process's filesystem
  // and shell to any authenticated client. Bearer token / unix-socket perms
  // are the access boundary — make sure those are configured before enabling.
  if (process.env.RIVETOS_MCP_ENABLE_SHELL === '1') {
    try {
      const handle: ShellToolHandle = createShellTool()
      tools.push(...handle.tools)
      cleanups.push(() => handle.close())
      console.log(
        `[rivetos-mcp-server] shell tool enabled (${handle.tools.map((t) => t.name).join(', ')}) [WRITE SURFACE]`,
      )
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[rivetos-mcp-server] failed to enable shell tool: ${message}`)
    }
  }

  if (process.env.RIVETOS_MCP_ENABLE_FILE === '1') {
    try {
      const handle: FileToolsHandle = createFileTools()
      tools.push(...handle.tools)
      cleanups.push(() => handle.close())
      console.log(
        `[rivetos-mcp-server] file tools enabled (${handle.tools.map((t) => t.name).join(', ')}) [WRITE SURFACE]`,
      )
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[rivetos-mcp-server] failed to enable file tools: ${message}`)
    }
  }

  if (process.env.RIVETOS_MCP_ENABLE_SEARCH === '1') {
    try {
      const handle: SearchToolsHandle = createSearchTools()
      tools.push(...handle.tools)
      cleanups.push(() => handle.close())
      console.log(
        `[rivetos-mcp-server] search tools enabled (${handle.tools.map((t) => t.name).join(', ')})`,
      )
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[rivetos-mcp-server] failed to enable search tools: ${message}`)
    }
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

  const server = createMcpServer({
    host,
    port,
    socketPath,
    authToken,
    requireBearerOnSocket,
    tools,
  })
  await server.start()

  if (socketPath) {
    console.log(
      `[rivetos-mcp-server] bound to unix socket ${socketPath} (mode 0600)` +
        (authToken && requireBearerOnSocket
          ? ' [bearer required]'
          : ' [bearer skipped — fs perms are the auth boundary]'),
    )
  } else {
    console.log(
      `[rivetos-mcp-server] bound to ${host}:${String(port)}` +
        (authToken
          ? ' [bearer required]'
          : ' [WARNING: no RIVETOS_MCP_TOKEN — bind is unauthenticated, localhost-only OK for dev]'),
    )
  }

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
