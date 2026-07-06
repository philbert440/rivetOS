/**
 * @rivetos/mcp-v2 client mount — the minimal facade the mcp-client tool
 * plugin consumes: connect (streamable HTTP or stdio), list tools, call a
 * tool, close. Wraps the v2 SDK so the plugin never touches
 * @modelcontextprotocol/* directly (RC-final drift stays contained here).
 */

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

export interface V2ClientConnectOptions {
  name?: string
  /** streamable HTTP endpoint URL — mutually exclusive with command. */
  url?: string
  /** Bearer token for HTTP connections. */
  authToken?: string
  /** stdio: command + args to spawn. */
  command?: string
  args?: string[]
  env?: Record<string, string>
}

export interface V2ToolInfo {
  name: string
  description?: string
  /** JSON Schema for the tool's input (as advertised by the server). */
  inputSchema?: Record<string, unknown>
}

export interface V2RawToolResult {
  content: Array<Record<string, unknown>>
  isError?: boolean
}

export interface V2McpConnection {
  listTools(): Promise<V2ToolInfo[]>
  callTool(name: string, args: Record<string, unknown>): Promise<string>
  /** Untranslated content array — multimodal consumers (mcp-client). */
  callToolRaw(name: string, args: Record<string, unknown>): Promise<V2RawToolResult>
  close(): Promise<void>
}

export async function connectV2(options: V2ClientConnectOptions): Promise<V2McpConnection> {
  const client = new Client({ name: options.name ?? 'rivetos-mcp-client', version: '2.0.0' })

  let terminate: (() => Promise<void>) | undefined
  if (options.url) {
    const transport = new StreamableHTTPClientTransport(new URL(options.url), {
      requestInit: options.authToken
        ? { headers: { authorization: `Bearer ${options.authToken}` } }
        : undefined,
    })
    await client.connect(transport)
    terminate = () => transport.terminateSession().catch(() => undefined)
  } else if (options.command) {
    const transport = new StdioClientTransport({
      command: options.command,
      args: options.args ?? [],
      env: options.env,
    })
    await client.connect(transport)
  } else {
    throw new Error('connectV2 needs url (streamable HTTP) or command (stdio)')
  }

  return {
    async listTools(): Promise<V2ToolInfo[]> {
      const { tools } = await client.listTools()
      return tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }))
    },
    async callToolRaw(name, args): Promise<V2RawToolResult> {
      const result = await client.callTool({ name, arguments: args })
      return {
        content: result.content ?? [],
        isError: result.isError === true,
      }
    },
    async callTool(name, args): Promise<string> {
      const result = await client.callTool({ name, arguments: args })
      const content = (result.content ?? []) as Array<{ type: string; text?: string }>
      const text = content
        .filter((c) => c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text as string)
        .join('\n')
      if (result.isError) throw new Error(text || `tool ${name} failed`)
      return text
    },
    async close(): Promise<void> {
      await terminate?.()
      await client.close()
    },
  }
}
