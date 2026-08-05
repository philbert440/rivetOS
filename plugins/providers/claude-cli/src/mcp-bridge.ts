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
 * Protocol: defaults to **MCP 2026-07-28 final (v2, stateless)** via
 * `@rivetos/mcp-v2`. Set `RIVETOS_MCP_BRIDGE_PROTOCOL=v1` to fall back to
 * the sessionful 2025-11-25 mount if a Claude Code build has not yet
 * rolled out 2026-07-28 support.
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
import { createMcpServer, type RivetMcpServer } from '@rivetos/mcp-v1'
import { createV2McpServer, type V2McpServer } from '@rivetos/mcp-v2'
import type { Tool } from '@rivetos/types'
import type { BridgeLogger } from './log.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type BridgeProtocol = 'v1' | 'v2'

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
  /**
   * Protocol generation. Default: env RIVETOS_MCP_BRIDGE_PROTOCOL or `v2`.
   */
  protocol?: BridgeProtocol
}

export interface EmbeddedMcpHandle {
  /** Absolute path of the synthesized `.mcp-config.json`. Pass to claude
   *  via `--mcp-config`. */
  configPath: string
  /** Resolved address of the embedded server (informational; bridge owns it). */
  url: string
  /** Bearer token (informational; never log this). */
  token: string
  /** Active protocol generation. */
  protocol: BridgeProtocol
  /** Tear down: stop server, unlink config tempfile. */
  close: () => Promise<void>
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

function resolveProtocol(explicit?: BridgeProtocol): BridgeProtocol {
  if (explicit === 'v1' || explicit === 'v2') return explicit
  const env = process.env.RIVETOS_MCP_BRIDGE_PROTOCOL?.trim().toLowerCase()
  if (env === 'v1') return 'v1'
  return 'v2'
}

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
  const protocol = resolveProtocol(config.protocol)

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

  let url: string
  let stop: () => Promise<void>

  if (protocol === 'v2') {
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
    url = `http://127.0.0.1:${String(server.port)}/mcp`
    stop = () => server.close()
  } else {
    const server: RivetMcpServer = createMcpServer({
      host: '127.0.0.1',
      port: 0,
      authToken: token,
      tools: registrations,
      log: (msg, meta) => {
        log.debug(`mcp.bridge.server.${msg}`, meta)
      },
    })
    await server.start()
    const addr = server.address
    const port = addr.port
    const host = addr.host ?? '127.0.0.1'
    if (port === undefined) {
      await server.stop().catch(() => undefined)
      throw new Error('mcp-bridge: embedded v1 server did not bind a TCP port')
    }
    url = `http://${host}:${String(port)}/mcp`
    stop = () => server.stop()
  }

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
    protocol,
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
    log.info('mcp.bridge.down', { agentId, protocol })
  }

  return { configPath, url, token, protocol, close }
}

const noopLog: BridgeLogger = {
  error() {},
  warn() {},
  info() {},
  debug() {},
}
