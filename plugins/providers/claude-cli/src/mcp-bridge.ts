/**
 * mcp-bridge — embedded MCP server for claude-cli spawns.
 *
 * Each `chatStream()` call:
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
 * Protocol: **MCP 2026-07-28 final (v2, stateless)** via `@rivetos/mcp-v2`.
 * (The sessionful v1 fallback was removed with packages/mcp-v1; the
 * RIVETOS_DISABLE_MCP_BRIDGE kill switch in the provider remains.)
 *
 * Why ephemeral TCP and not unix socket: claude-cli's MCP transport schema
 * supports `stdio | http | sse`. No unix-socket transport exists in the
 * config schema, so localhost loopback + bearer is the realistic option.
 *
 * Why per-spawn: child-process lifecycle is bound to the spawn. No shared
 * server, no auth-rotation problem, no orphan sockets.
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

import { adaptRivetToolDynamic, type ToolRegistration } from '@rivetos/mcp'
import { createV2McpServer, type V2McpServer } from '@rivetos/mcp-v2'
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
  /** Tear down: stop server, unlink config tempfile. */
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
 */
export async function embedMcpServerForTurn(config: BridgeConfig): Promise<EmbeddedMcpHandle> {
  const log = config.log ?? noopLog
  const agentId = config.agentId ?? 'claude-cli'
  const serverNameForClient = config.serverNameForClient ?? 'rivetos'

  const registrations: ToolRegistration[] = []
  const skipped: string[] = []
  for (const tool of config.tools) {
    try {
      registrations.push(adaptRivetToolDynamic(tool))
    } catch (err: unknown) {
      skipped.push(tool.name)
      log.warn('mcp.bridge.tool.skip', {
        toolName: tool.name,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const token = randomBytes(32).toString('hex')

  const server: V2McpServer = createV2McpServer({
    host: '127.0.0.1',
    port: 0,
    authToken: token,
    tools: registrations,
    serverName: serverNameForClient,
    serverDescription: 'RivetOS embedded tools for Claude Code (MCP 2026-07-28)',
  })
  await server.start()
  if (!server.port) {
    await server.close().catch(() => undefined)
    throw new Error('mcp-bridge: embedded v2 server did not bind a TCP port')
  }
  const url = `http://127.0.0.1:${String(server.port)}/mcp`
  const stop = (): Promise<void> => server.close()

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
      await stop()
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
