/**
 * In-process MCP transport plugin.
 *
 * When `transports.mcp` is configured, the boot loader instantiates this
 * manifest, which waits for runtime registration to finish (via
 * `onRegistrationComplete`), wraps every runtime tool through
 * `adaptRivetToolDynamic`, and starts an MCP `createMcpServer` exposing
 * them. Standalone sidecar mode (via `cli.ts`) is unaffected — it remains
 * the supported way to run a curated MCP surface as a separate process.
 *
 * Config (config.yaml):
 *
 *   transports:
 *     mcp:
 *       # one of: socket | tcp (default: tcp if no `socket` set)
 *       socket: /run/rivetos/mcp.sock
 *       require_bearer_on_socket: false
 *       # — or —
 *       host: 127.0.0.1
 *       port: 5700
 *       auth_token: ${RIVETOS_MCP_TOKEN}
 */

import type { PluginManifest } from '@rivetos/types'
import { createMcpServer, type ToolRegistration } from './server.js'
import { adaptRivetToolDynamic } from './tools/adapt.js'

export const manifest: PluginManifest = {
  type: 'transport',
  name: 'mcp',
  register(ctx) {
    const cfg = ctx.pluginConfig ?? {}

    const host = (cfg.host as string | undefined) ?? '127.0.0.1'
    const port = Number(cfg.port ?? 5700)
    const socketPath = cfg.socket as string | undefined
    const authToken = (cfg.auth_token as string | undefined) ?? undefined
    const requireBearerOnSocket = Boolean(cfg.require_bearer_on_socket)

    ctx.onRegistrationComplete(async (snapshot) => {
      const tools: ToolRegistration[] = snapshot.tools.map((t) => adaptRivetToolDynamic(t))

      const server = createMcpServer({
        host,
        port,
        socketPath,
        authToken,
        requireBearerOnSocket,
        tools,
        log: (msg, meta) => {
          ctx.logger.debug(`${msg}${meta ? ' ' + JSON.stringify(meta) : ''}`)
        },
      })

      try {
        await server.start()
        if (socketPath) {
          ctx.logger.info(
            `MCP transport bound to unix socket ${socketPath} ` +
              `(${tools.length} tool(s) exposed` +
              (authToken && requireBearerOnSocket ? ', bearer required' : ', fs perms only') +
              ')',
          )
        } else {
          ctx.logger.info(
            `MCP transport bound to ${host}:${String(port)} ` +
              `(${tools.length} tool(s) exposed` +
              (authToken ? ', bearer required' : ', UNAUTHENTICATED — dev only') +
              ')',
          )
        }
        ctx.registerShutdown(() => server.stop())
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        ctx.logger.error(`MCP transport failed to start: ${message}`)
      }
    })
  },
}
