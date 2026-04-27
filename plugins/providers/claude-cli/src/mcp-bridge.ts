/**
 * mcp-bridge — embedded MCP server for claude-cli spawns.
 *
 * Phase 1.C deliverable. Each `chatStream()` call:
 *   1. Stands up a per-spawn MCP server bound to `127.0.0.1:0` (ephemeral
 *      port, OS-assigned) protected by a 32-byte random bearer token.
 *   2. Wraps every executable RivetOS tool in `ChatOptions.executableTools`
 *      via `adaptRivetToolDynamic` so the tool's live `execute` closure
 *      runs in the agent process — DelegationEngine, channel handle, the
 *      conversation buffer are all naturally available, no separate adapter.
 *   3. Writes a tempfile `.mcp-config.json` pointing claude-cli at the
 *      embedded server, with the bearer token in the `headers` block.
 *   4. Returns a `{ configPath, close }` handle. The provider passes
 *      `--mcp-config <configPath>` to claude and calls `close()` from a
 *      `finally` covering success, error, timeout, and abort paths.
 *
 * Why ephemeral TCP and not unix socket: claude-cli's MCP transport schema
 * supports `stdio | http | sse`. No unix-socket transport exists in the
 * config schema, so localhost loopback + bearer is the realistic option.
 * `127.0.0.1` is the security boundary; bearer is defense-in-depth on a
 * process boundary.
 *
 * Why per-spawn: child-process lifecycle is bound to the spawn. No shared
 * server, no auth-rotation problem, no orphan sockets. Bring it up, use
 * it, tear it down. ~20ms of overhead per turn.
 *
 * Tool surface: every executable tool from the host AgentLoop is exposed,
 * including `delegate_task` (which closes over the host's DelegationEngine
 * — that's the whole point of running in-process). Claude Code's native
 * tools (Bash, Read, Edit, Grep, Glob, WebFetch, Task, TodoWrite, Write)
 * stay native; we don't shadow what works.
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

import {
  adaptRivetToolDynamic,
  createMcpServer,
  type RivetMcpServer,
  type ToolRegistration,
} from '@rivetos/mcp-server'
import type { Tool } from '@rivetos/types'
import type { BridgeLogger } from './log.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BridgeConfig {
  /** Live executable tools to expose. Comes from `ChatOptions.executableTools`. */
  tools: Tool[]
  /** Logical agent id — labels the temp socket / config so multi-agent
   *  hosts can correlate spawns to agents in logs. Default `claude-cli`. */
  agentId?: string
  /** Logger (new BridgeLogger shape with level methods). Falls back to no-op. */
  log?: BridgeLogger
  /** MCP server name as advertised to the client. Default `rivetos`. */
  serverNameForClient?: string
}

export interface EmbeddedMcpHandle {
  /** Absolute path of the synthesized `.mcp-config.json`. Pass to claude
   *  via `--mcp-config`. */
  configPath: string
  /** Resolved address of the embedded server (informational; bridge owns it). */
  url: string
  /** Bearer token (informational; never log this). */
  token: string
  /** Tear down: stop server, unlink config tempfile, drop session map. */
  close: () => Promise<void>
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Bring up an embedded MCP server for one claude-cli spawn.
 *
 * Caller is responsible for invoking `close()` from a `finally` block
 * covering every exit path of the spawn (success, error, timeout, abort).
 * Failure to close leaks an HTTP server on an ephemeral port plus a
 * tempfile on disk; both die when the agent process exits but should not
 * be left dangling within a long-running agent.
 */
export async function embedMcpServerForTurn(config: BridgeConfig): Promise<EmbeddedMcpHandle> {
  const log = config.log ?? noopLog
  const agentId = config.agentId ?? 'claude-cli'
  const serverNameForClient = config.serverNameForClient ?? 'rivetos'

  // Wrap every executable tool. `adaptRivetToolDynamic` derives the zod
  // schema from `tool.parameters`, so we don't need a hand-mapped schema
  // for delegate_task / subagent_* / etc. — they ride for free.
  const registrations: ToolRegistration[] = []
  const skipped: string[] = []
  for (const tool of config.tools) {
    try {
      registrations.push(adaptRivetToolDynamic(tool))
    } catch (err: unknown) {
      // A schema translation failure on one tool shouldn't take down the
      // whole bridge — skip it, log it, keep going. The remaining tools
      // are still callable; the LLM just won't see this one.
      skipped.push(tool.name)
      log.warn('mcp.bridge.tool.skip', {
        toolName: tool.name,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const token = randomBytes(32).toString('hex')

  const server: RivetMcpServer = createMcpServer({
    host: '127.0.0.1',
    port: 0,
    authToken: token,
    tools: registrations,
    log: (msg, meta) => {
      // Keep the server's own logging quiet in the bridge use case;
      // the agent process already has a logger. Forward at debug.
      log.debug(`mcp.bridge.server.${msg}`, meta)
    },
  })

  await server.start()

  const addr = server.address
  const port = addr.port
  const host = addr.host ?? '127.0.0.1'
  if (port === undefined) {
    // Server failed to bind a real port — should never happen with `port: 0`
    // unless the bind itself failed.
    await server.stop().catch(() => undefined)
    throw new Error('mcp-bridge: embedded server did not bind a TCP port')
  }
  const url = `http://${host}:${String(port)}/mcp`

  // Write the .mcp-config.json the CLI consumes via `--mcp-config`.
  // Format: `{ "mcpServers": { "<name>": { "type": "http", "url", "headers" } } }`.
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `rivetos-mcp-${agentId}-`))
  const configPath = path.join(tmpDir, 'mcp-config.json')
  const mcpConfig = {
    mcpServers: {
      [serverNameForClient]: {
        type: 'http',
        url,
        headers: { Authorization: `Bearer ${token}` },
      },
    },
  }
  await fs.writeFile(configPath, JSON.stringify(mcpConfig, null, 2), { mode: 0o600 })

  log.info('mcp.bridge.up', {
    agentId,
    url,
    configPath,
    toolsExposed: registrations.length,
    toolsSkipped: skipped.length,
  })

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    try {
      await server.stop()
    } catch (err: unknown) {
      log.warn('mcp.bridge.server.stop.error', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
    try {
      await fs.rm(tmpDir, { recursive: true, force: true })
    } catch (err: unknown) {
      log.warn('mcp.bridge.tmpdir.cleanup.error', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
    log.info('mcp.bridge.down', { agentId })
  }

  return { configPath, url, token, close }
}

const noopLog: BridgeLogger = {
  error() {},
  warn() {},
  info() {},
  debug() {},
}
