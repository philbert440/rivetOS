/**
 * Emit the registration artifacts T3 / its harnesses can consume.
 * Paths stay placeholders until setup rewrites them to this checkout.
 */

import { t3HttpMcpServer, t3PluginEntry } from './t3-surface.mjs'

export const PLUGIN_NAME = 'rivetos-memory'
export const DEFAULT_MCP_PORT = 5700

/**
 * @param {{ pluginRoot: string, host?: string, port?: number }} opts
 */
export function buildRegistration(opts) {
  const host = opts.host ?? '127.0.0.1'
  const port = opts.port ?? DEFAULT_MCP_PORT
  const origin = `http://${host}:${String(port)}`
  const mcpUrl = `${origin}/mcp`
  const stdioLauncher = `${opts.pluginRoot}/bin/rivet-memory-mcp.sh`
  const httpLauncher = `${opts.pluginRoot}/bin/rivet-memory-mcp-http.sh`

  return {
    plugin: t3PluginEntry({
      name: PLUGIN_NAME,
      title: 'RivetOS Memory',
      description:
        'RivetOS persistent memory for T3 Code threads. Tools come from the existing mcp-sidecar.',
      url: origin,
      mcpUrl,
    }),
    claudeStdio: {
      mcpServers: {
        rivetos: {
          command: 'bash',
          args: [stdioLauncher],
        },
      },
    },
    t3Http: {
      mcpServers: {
        rivetos: t3HttpMcpServer(mcpUrl),
      },
    },
    opencode: {
      mcp: {
        rivetos: {
          type: 'local',
          command: ['bash', stdioLauncher],
          enabled: true,
        },
      },
    },
    launchers: { stdio: stdioLauncher, http: httpLauncher },
    mcpUrl,
  }
}
