#!/usr/bin/env node
/**
 * `rivetos-mcp-server` — standalone entrypoint.
 *
 * Phase 1.A — slice 7' adds bearer-token auth on TCP and an alternative
 * unix-socket binding (filesystem perms as auth boundary), plus the
 * `session_attach` handshake tool. Other slices ship the data-plane
 * (memory, skills, web) and runtime-plane (delegate / subagent / shell / ...)
 * tools.
 *
 * Env:
 *   RIVETOS_MCP_STDIO=1     — speak MCP over stdin/stdout instead of binding a
 *                             socket. This is the transport Claude Code and
 *                             other MCP clients use to spawn a local server.
 *                             Also enabled by passing `--stdio` on argv. When
 *                             set, MCP_HOST/PORT and RIVETOS_MCP_SOCKET are
 *                             ignored, no auth applies (the parent owns the
 *                             pipe), and all diagnostics are routed to stderr
 *                             to keep stdout clean for the protocol.
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
 *                             `memory_search`, `memory_browse`,
 *                             and `memory_stats`.
 *   RIVETOS_EMBED_URL       — optional embedding endpoint for hybrid search
 *   RIVETOS_EMBED_MODEL     — optional embedding model (default: nemotron)
 *   GOOGLE_CSE_API_KEY      — optional, enables Google search backend for
 *                             `internet_search` (DuckDuckGo fallback
 *                             always available)
 *   GOOGLE_CSE_ID           — required alongside GOOGLE_CSE_API_KEY
 *   RIVETOS_USER_AGENT      — optional override for `web_fetch`
 *   RIVETOS_SKILL_DIRS      — colon-separated dirs to scan for skills.
 *                             Default: ${HOME}/.rivetos/skills. Both workspace
 *                             and system dirs are writable from MCP.
 *   RIVETOS_MCP_ENABLE_SHELL=1     — enables `shell` (write surface,
 *                                    off by default). Maintains a session
 *                                    cwd across calls.
 *   RIVETOS_MCP_ENABLE_FILE=1      — enables `file_read`,
 *                                    `file_write`, `file_edit`
 *                                    (write surface, off by default).
 *   RIVETOS_MCP_ENABLE_SEARCH=1    — enables `search_glob`,
 *                                    `search_grep` (read-only, off
 *                                    by default for symmetry; safe to enable).
 *
 * Runtime-plane tools (delegate_task, subagent_*, ask_user, todo,
 * compact_context) and the claude-cli MCP bridge land in later slices.
 */

import {
  createMcpServer,
  createStdioMcpServer,
  defaultEchoTool,
  type ToolRegistration,
} from './server.js'
import { createFileTools, type FileToolsHandle } from './tools/file.js'
import { createMemoryTools, type MemoryToolsHandle } from './tools/memory.js'
import { createSearchTools, type SearchToolsHandle } from './tools/search.js'
import { createShellTool, type ShellToolHandle } from './tools/shell.js'
import { createSkillTools, type SkillToolsHandle } from './tools/skills.js'
import { createWebTools, type WebToolsHandle } from './tools/web.js'

async function main(): Promise<void> {
  const stdioMode = process.env.RIVETOS_MCP_STDIO === '1' || process.argv.includes('--stdio')

  // In stdio mode stdout IS the JSON-RPC channel — a single stray line of
  // log output corrupts the protocol. Redirect `console.log` to stderr before
  // anything else runs so the tool-setup diagnostics below stay off stdout.
  // (The MCP SDK's StdioServerTransport writes to `process.stdout` directly,
  // not via `console`, so it is unaffected.)
  if (stdioMode) {
    console.log = (...args: unknown[]) => {
      console.error(...args)
    }
  }

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

  // `server` exposes a `stop()` either way — that is all the shutdown path
  // below needs.
  let server: { stop: () => Promise<void> }

  if (stdioMode) {
    const stdioServer = createStdioMcpServer({ tools })
    await stdioServer.start()
    server = stdioServer
    // Diagnostic only — `console.log` is already redirected to stderr above.
    console.log(
      `[rivetos-mcp-server] speaking MCP over stdio (session ${stdioServer.sessionId}) — ${String(tools.length)} tool(s)`,
    )
  } else {
    const httpServer = createMcpServer({
      host,
      port,
      socketPath,
      authToken,
      requireBearerOnSocket,
      tools,
    })
    await httpServer.start()
    server = httpServer

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
  }

  let shuttingDown = false
  const shutdown = (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
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

  // In stdio mode the client closing the pipe is the disconnect signal —
  // tear down and exit rather than lingering with no transport.
  if (stdioMode) {
    process.stdin.once('end', () => {
      shutdown('stdin-end')
    })
    process.stdin.once('close', () => {
      shutdown('stdin-close')
    })
  }
}

main().catch((err: unknown) => {
  console.error('[rivetos-mcp-server] fatal', err)
  process.exit(1)
})
