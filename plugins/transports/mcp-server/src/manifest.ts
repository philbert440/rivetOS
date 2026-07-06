/**
 * In-process MCP transport plugin — serves the 2026-07-28 RC (v2, stateless).
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
import { createV2McpServer } from '@rivetos/mcp-v2'
import { adaptRivetToolDynamic, type ToolRegistration } from '@rivetos/mcp'

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

      // v2 cutover (MCP unification PR 2): stateless 2026-07-28 RC server.
      // Config surface unchanged. Note: on a unix socket the fs perms are
      // the boundary; require_bearer_on_socket keeps its meaning by simply
      // passing the token through (v2 auth check is token-or-nothing).
      const server = createV2McpServer({
        host,
        port,
        socketPath,
        authToken: socketPath && !requireBearerOnSocket ? undefined : authToken,
        tools,
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
        ctx.registerShutdown(() => server.close())
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        ctx.logger.error(`MCP transport failed to start: ${message}`)
      }
    })
  },
}
