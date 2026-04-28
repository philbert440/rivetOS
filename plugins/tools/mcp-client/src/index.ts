/**
 * @rivetos/tool-mcp-client
 *
 * MCP Client Plugin — connects to MCP servers and exposes their tools
 * as native RivetOS tools. Supports stdio and StreamableHTTP transports.
 *
 * Each configured MCP server is connected at boot. Its tools are discovered
 * via `listTools()` and wrapped in the RivetOS Tool interface. Tool calls
 * are proxied to the MCP server via `callTool()`.
 *
 * Config example (in config.yaml):
 *
 *   mcp:
 *     servers:
 *       filesystem:
 *         transport: stdio
 *         command: npx
 *         args: ["-y", "@modelcontextprotocol/server-filesystem", "/home/user"]
 *       google-workspace:
 *         transport: streamable-http
 *         url: http://192.168.1.108:3000/mcp
 *       nemotron:
 *         transport: stdio
 *         command: python3
 *         args: ["-m", "nemotron_mcp_server"]
 *         env:
 *           NEMOTRON_MODEL: nemotron-8b
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { Tool, ToolResult } from '@rivetos/types'
import type { ContentPart } from '@rivetos/types'

// ---------------------------------------------------------------------------
// Config Types
// ---------------------------------------------------------------------------

export interface MCPServerConfig {
  /** Transport type */
  transport: 'stdio' | 'streamable-http' | 'sse'
  /** For stdio: command to run */
  command?: string
  /** For stdio: command arguments */
  args?: string[]
  /** For stdio: environment variables */
  env?: Record<string, string>
  /** For stdio: working directory */
  cwd?: string
  /** For HTTP/SSE: server URL */
  url?: string
  /** Optional prefix for tool names to avoid collisions (e.g. "gws_" → "gws_send_email") */
  toolPrefix?: string
  /** Connection timeout in ms (default: 30000) */
  connectTimeout?: number
  /** Whether to reconnect on disconnect (default: true) */
  autoReconnect?: boolean
}

export interface MCPClientConfig {
  servers: Record<string, MCPServerConfig>
}

// ---------------------------------------------------------------------------
// MCP result content types (from MCP SDK)
// ---------------------------------------------------------------------------

interface MCPTextContent {
  type: 'text'
  text: string
}

interface MCPImageContent {
  type: 'image'
  data: string
  mimeType: string
}

interface MCPResourceContent {
  type: 'resource'
  resource: {
    uri: string
    text?: string
    blob?: string
    mimeType?: string
  }
}

type MCPContentBlock = MCPTextContent | MCPImageContent | MCPResourceContent | { type: string }

interface MCPCallToolResult {
  content?: MCPContentBlock[]
  isError?: boolean
}

// ---------------------------------------------------------------------------
// MCP Connection — wraps a single MCP server connection
// ---------------------------------------------------------------------------

interface MCPConnection {
  id: string
  config: MCPServerConfig
  client: Client
  transport: Transport
  connected: boolean
  tools: MCPDiscoveredTool[]
}

interface MCPDiscoveredTool {
  /** Original name from MCP server */
  mcpName: string
  /** RivetOS tool name (with optional prefix) */
  rivetName: string
  /** Tool description */
  description: string
  /** JSON Schema for parameters */
  inputSchema: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// MCP Client Plugin
// ---------------------------------------------------------------------------

export class MCPClientPlugin {
  private connections: Map<string, MCPConnection> = new Map()
  private config: MCPClientConfig

  constructor(config: MCPClientConfig) {
    this.config = config
  }

  /**
   * Connect to all configured MCP servers and discover their tools.
   * Returns an array of RivetOS Tool wrappers.
   */
  async connect(): Promise<Tool[]> {
    const allTools: Tool[] = []

    for (const [serverId, serverConfig] of Object.entries(this.config.servers)) {
      try {
        const conn = await this.connectServer(serverId, serverConfig)
        this.connections.set(serverId, conn)

        const tools = this.wrapTools(conn)
        allTools.push(...tools)

        console.log(
          `[MCP] Connected to "${serverId}" — ${conn.tools.length} tool(s): ${conn.tools.map((t) => t.rivetName).join(', ')}`,
        )
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[MCP] Failed to connect to "${serverId}": ${message}`)
      }
    }

    return allTools
  }

  /**
   * Disconnect all MCP servers.
   */
  async disconnect(): Promise<void> {
    for (const [id, conn] of this.connections) {
      try {
        await conn.transport.close()
        conn.connected = false
        console.log(`[MCP] Disconnected from "${id}"`)
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[MCP] Error disconnecting "${id}": ${message}`)
      }
    }
    this.connections.clear()
  }

  /**
   * Get a list of all connected server IDs and their tool counts.
   */
  getStatus(): Array<{ serverId: string; connected: boolean; toolCount: number }> {
    return Array.from(this.connections.entries()).map(([id, conn]) => ({
      serverId: id,
      connected: conn.connected,
      toolCount: conn.tools.length,
    }))
  }

  // -----------------------------------------------------------------------
  // Internal: Connect to a single MCP server
  // -----------------------------------------------------------------------

  private async connectServer(id: string, config: MCPServerConfig): Promise<MCPConnection> {
    const client = new Client({ name: 'rivet-os', version: '0.2.0' }, { capabilities: {} })

    let transport: Transport

    switch (config.transport) {
      case 'stdio': {
        if (!config.command) {
          throw new Error(`MCP server "${id}": stdio transport requires "command"`)
        }
        transport = new StdioClientTransport({
          command: config.command,
          args: config.args ?? [],
          env: { ...process.env, ...(config.env ?? {}) } as Record<string, string>,
          cwd: config.cwd,
          stderr: 'pipe',
        })
        break
      }
      case 'streamable-http': {
        if (!config.url) {
          throw new Error(`MCP server "${id}": streamable-http transport requires "url"`)
        }
        // Dynamic import to avoid bundling HTTP transport when only using stdio
        const { StreamableHTTPClientTransport } =
          await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
        transport = new StreamableHTTPClientTransport(new URL(config.url))
        break
      }
      case 'sse': {
        if (!config.url) {
          throw new Error(`MCP server "${id}": sse transport requires "url"`)
        }
        // SSEClientTransport is deprecated but some servers still require it
        // eslint-disable-next-line @typescript-eslint/no-deprecated -- SSE still needed for legacy servers
        const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js')
        transport = new SSEClientTransport(new URL(config.url))
        break
      }
      default:
        throw new Error(`MCP server "${id}": unknown transport "${config.transport as string}"`)
    }

    // Connect with timeout
    const timeout = config.connectTimeout ?? 30_000
    const connectPromise = client.connect(transport)
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Connection to "${id}" timed out after ${timeout}ms`)),
        timeout,
      ),
    )
    await Promise.race([connectPromise, timeoutPromise])

    // Discover tools
    const toolsResponse = await client.listTools()
    const prefix = config.toolPrefix ?? ''

    const tools: MCPDiscoveredTool[] = toolsResponse.tools.map((t) => ({
      mcpName: t.name,
      rivetName: prefix ? `${prefix}${t.name}` : t.name,
      description: t.description ?? `MCP tool from ${id}`,
      inputSchema: t.inputSchema,
    }))

    // Handle disconnection
    transport.onclose = () => {
      console.warn(`[MCP] Connection to "${id}" closed`)
      const conn = this.connections.get(id)
      if (conn) conn.connected = false

      // Auto-reconnect
      if (config.autoReconnect !== false) {
        console.log(`[MCP] Scheduling reconnect for "${id}" in 5s...`)
        setTimeout(() => {
          void this.reconnect(id)
        }, 5_000)
      }
    }

    transport.onerror = (err: Error) => {
      console.error(`[MCP] Transport error for "${id}": ${err.message}`)
    }

    return { id, config, client, transport, connected: true, tools }
  }

  // -----------------------------------------------------------------------
  // Internal: Reconnect a disconnected server
  // -----------------------------------------------------------------------

  private async reconnect(id: string): Promise<void> {
    const existing = this.connections.get(id)
    if (!existing || existing.connected) return

    try {
      console.log(`[MCP] Reconnecting to "${id}"...`)
      const conn = await this.connectServer(id, existing.config)
      this.connections.set(id, conn)
      console.log(`[MCP] Reconnected to "${id}" — ${conn.tools.length} tool(s)`)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[MCP] Reconnect to "${id}" failed: ${message}`)
      // Retry again in 30s
      setTimeout(() => {
        void this.reconnect(id)
      }, 30_000)
    }
  }

  // -----------------------------------------------------------------------
  // Internal: Wrap MCP tools as RivetOS Tool instances
  // -----------------------------------------------------------------------

  private wrapTools(conn: MCPConnection): Tool[] {
    return conn.tools.map((mcpTool) => ({
      name: mcpTool.rivetName,
      description: mcpTool.description,
      parameters: mcpTool.inputSchema,

      execute: async (
        args: Record<string, unknown>,
        _signal?: AbortSignal,
      ): Promise<ToolResult> => {
        if (!conn.connected) {
          return `Error: MCP server "${conn.id}" is disconnected`
        }

        try {
          const result = (await conn.client.callTool({
            name: mcpTool.mcpName,
            arguments: args,
          })) as MCPCallToolResult

          // Convert MCP result content to RivetOS ToolResult
          return this.convertResult(result)
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err)
          return `Error calling MCP tool "${mcpTool.mcpName}" on "${conn.id}": ${message}`
        }
      },
    }))
  }

  // -----------------------------------------------------------------------
  // Internal: Convert MCP tool result to RivetOS ToolResult
  // -----------------------------------------------------------------------

  private convertResult(result: MCPCallToolResult): ToolResult {
    const content = result.content
    if (!Array.isArray(content) || content.length === 0) {
      return result.isError ? `Error: ${JSON.stringify(result)}` : 'No output'
    }

    // Check if there are any non-text content blocks
    const hasMultimodal = content.some((c) => c.type !== 'text')

    if (!hasMultimodal) {
      // All text — join into a single string
      const text = content
        .filter((c): c is MCPTextContent => c.type === 'text')
        .map((c) => c.text)
        .join('\n')

      return result.isError ? `Error: ${text}` : text
    }

    // Multimodal — convert to ContentPart[]
    const parts: ContentPart[] = []

    for (const block of content) {
      switch (block.type) {
        case 'text':
          parts.push({ type: 'text', text: (block as MCPTextContent).text })
          break
        case 'image':
          parts.push({
            type: 'image',
            data: (block as MCPImageContent).data,
            mimeType: (block as MCPImageContent).mimeType,
          })
          break
        case 'resource': {
          // Resource content — extract text or blob
          const resource = (block as MCPResourceContent).resource
          if (resource.text) {
            parts.push({ type: 'text', text: resource.text })
          } else if (resource.blob) {
            const mime = resource.mimeType ?? 'application/octet-stream'
            if (mime.startsWith('image/')) {
              parts.push({
                type: 'image',
                data: resource.blob,
                mimeType: mime,
              })
            } else {
              parts.push({ type: 'text', text: `[binary resource: ${resource.uri}]` })
            }
          }
          break
        }
        default:
          parts.push({ type: 'text', text: `[unsupported MCP content type: ${block.type}]` })
      }
    }

    return parts
  }
}

// ---------------------------------------------------------------------------
// Convenience: create the plugin from a config object
// ---------------------------------------------------------------------------

export function createMCPClientPlugin(config: MCPClientConfig): MCPClientPlugin {
  return new MCPClientPlugin(config)
}

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

import type { ToolPlugin, PluginConfig, PluginManifest } from '@rivetos/types'

export function createPlugin(config?: MCPClientConfig): ToolPlugin {
  const mcpPlugin = new MCPClientPlugin(config ?? { servers: {} })
  let tools: Tool[] = []

  return {
    name: '@rivetos/tool-mcp-client',
    version: '0.1.0',
    description: 'MCP client — connects to MCP servers and registers their tools',
    async init(_config: PluginConfig) {
      tools = await mcpPlugin.connect()
    },
    getTools() {
      return tools
    },
    async shutdown() {
      await mcpPlugin.disconnect()
    },
  }
}

// ---------------------------------------------------------------------------
// Plugin manifest
// ---------------------------------------------------------------------------

interface RivetosConfigShape {
  mcp?: { servers?: Record<string, MCPServerConfig> }
}

export const manifest: PluginManifest = {
  type: 'tool',
  name: 'mcp-client',
  async register(ctx) {
    const servers = (ctx.config as RivetosConfigShape).mcp?.servers
    if (!servers || Object.keys(servers).length === 0) return

    const mcpPlugin = new MCPClientPlugin({ servers })
    const tools = await mcpPlugin.connect()
    for (const tool of tools) ctx.registerTool(tool)
    ctx.registerShutdown(() => mcpPlugin.disconnect())
  },
}
