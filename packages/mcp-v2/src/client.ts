/**
 * @rivetos/mcp-v2 client mount — the facade the mcp-client tool plugin
 * consumes: connect (streamable HTTP or stdio), list tools, call a tool,
 * discover, close. Wraps the v2 SDK so the plugin never touches
 * @modelcontextprotocol/* directly (final-spec drift stays contained here).
 *
 * Spec features:
 *   - server/discover for capability probing
 *   - listTools with client-side cache options (use / refresh)
 *   - callTool with optional MRTR inputResponses on retry
 */

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

export interface V2ClientConnectOptions {
  name?: string
  version?: string
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
  title?: string
  /** JSON Schema for the tool's input (as advertised by the server). */
  inputSchema?: Record<string, unknown>
  annotations?: {
    title?: string
    readOnlyHint?: boolean
    destructiveHint?: boolean
    idempotentHint?: boolean
    openWorldHint?: boolean
  }
}

export interface V2RawToolResult {
  content: Array<Record<string, unknown>>
  isError?: boolean
  structuredContent?: Record<string, unknown>
  /** Present when the server returned input_required (MRTR). */
  inputRequired?: boolean
  raw?: unknown
}

export interface V2DiscoverResult {
  protocolVersion?: string
  serverInfo?: { name?: string; version?: string; description?: string }
  capabilities?: Record<string, unknown>
  instructions?: string
  raw: unknown
}

export interface V2ListToolsOptions {
  /** 'use' (default) serves a still-fresh cache entry; 'refresh' always fetches. */
  cache?: 'use' | 'refresh'
}

export interface V2CallToolOptions {
  /**
   * MRTR retry payload: answers to a prior input_required response,
   * keyed by the request ids the server asked for.
   */
  inputResponses?: Record<string, unknown>
}

export interface V2McpConnection {
  listTools(options?: V2ListToolsOptions): Promise<V2ToolInfo[]>
  callTool(name: string, args: Record<string, unknown>, options?: V2CallToolOptions): Promise<string>
  /** Untranslated content array — multimodal consumers (mcp-client). */
  callToolRaw(
    name: string,
    args: Record<string, unknown>,
    options?: V2CallToolOptions,
  ): Promise<V2RawToolResult>
  /** Optional capability discovery (server/discover). */
  discover(): Promise<V2DiscoverResult>
  close(): Promise<void>
}

export async function connectV2(options: V2ClientConnectOptions): Promise<V2McpConnection> {
  // Pin to 2026-07-28. SDK Client defaults to versionNegotiation mode
  // 'legacy' (2025-11-25 byte-identical handshake); without an explicit pin
  // discover() / MRTR / cache hints never leave the 2025 era.
  const client = new Client(
    {
      name: options.name ?? 'rivetos-mcp-client',
      version: options.version ?? '2.0.0',
    },
    {
      versionNegotiation: { mode: { pin: '2026-07-28' } },
      // Advertise elicitation so servers may return MRTR input_required
      // (form-mode) results. Without this, the server rejects inputRequired.
      capabilities: {
        elicitation: { form: {} },
      },
      // Manual MRTR mode: surface input_required to the caller (callToolRaw)
      // instead of auto-dispatching elicitation handlers we don't register.
      inputRequired: { autoFulfill: false },
    },
  )

  let terminate: (() => Promise<void>) | undefined
  if (options.url) {
    const transport = new StreamableHTTPClientTransport(new URL(options.url), {
      requestInit: options.authToken
        ? { headers: { authorization: `Bearer ${options.authToken}` } }
        : undefined,
    })
    await client.connect(transport)
    terminate = async () => {
      // v2 is sessionless; terminateSession is a no-op-or-compat path.
      if (typeof transport.terminateSession === 'function') {
        await transport.terminateSession().catch(() => undefined)
      }
    }
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

  const connection: V2McpConnection = {
    async listTools(listOpts?: V2ListToolsOptions): Promise<V2ToolInfo[]> {
      // CacheableRequestOptions shape varies across minor SDK builds; pass
      // through as a loose bag so refresh still works when supported.
      const reqOpts =
        listOpts?.cache === 'refresh' ? ({ cache: 'refresh' } as never) : undefined
      const { tools } = await client.listTools(undefined, reqOpts)
      return tools.map((t) => ({
        name: t.name,
        description: t.description,
        title: (t as { title?: string }).title,
        inputSchema: t.inputSchema as Record<string, unknown> | undefined,
        annotations: (t as { annotations?: V2ToolInfo['annotations'] }).annotations,
      }))
    },
    async callToolRaw(name, args, callOpts): Promise<V2RawToolResult> {
      const params: Record<string, unknown> = { name, arguments: args }
      if (callOpts?.inputResponses) {
        params.inputResponses = callOpts.inputResponses
      }
      try {
        // allowInputRequired surfaces input_required instead of throwing when
        // ClientOptions.inputRequired.autoFulfill is false.
        const result = (await client.callTool(params as never, {
          allowInputRequired: true,
        } as never)) as {
          content?: Array<Record<string, unknown>>
          isError?: boolean
          structuredContent?: Record<string, unknown>
          resultType?: string
          inputRequests?: Record<string, unknown>
        }
        const isInputRequired =
          result.resultType === 'input_required' ||
          (result as { kind?: string }).kind === 'input_required' ||
          (result.inputRequests != null && typeof result.inputRequests === 'object')
        return {
          content: result.content ?? [],
          isError: result.isError === true,
          structuredContent: result.structuredContent,
          inputRequired: isInputRequired || undefined,
          raw: result,
        }
      } catch (err: unknown) {
        // Some SDK builds throw a typed error for input_required even with
        // allowInputRequired; detect and re-surface as a structured result.
        const msg = err instanceof Error ? err.message : String(err)
        if (/input_required|input required|InputRequired/i.test(msg)) {
          return {
            content: [{ type: 'text', text: msg }],
            inputRequired: true,
            raw: err,
          }
        }
        throw err
      }
    },
    async callTool(name, args, callOpts): Promise<string> {
      const result = await connection.callToolRaw(name, args, callOpts)
      if (result.inputRequired) {
        throw new Error(
          `tool ${name} requires additional input (MRTR input_required) — use callToolRaw and retry with inputResponses`,
        )
      }
      const content = result.content as Array<{ type: string; text?: string }>
      const text = content
        .filter((c) => c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text as string)
        .join('\n')
      if (result.isError) throw new Error(text || `tool ${name} failed`)
      return text
    },
    async discover(): Promise<V2DiscoverResult> {
      // discover() is on Client in the 2.0 final SDK.
      const discoverFn = (client as { discover?: () => Promise<unknown> }).discover
      if (typeof discoverFn !== 'function') {
        return { raw: null, capabilities: undefined }
      }
      const raw = await discoverFn.call(client)
      const r = raw as {
        protocolVersion?: string
        serverInfo?: V2DiscoverResult['serverInfo']
        capabilities?: Record<string, unknown>
        instructions?: string
      }
      return {
        protocolVersion: r.protocolVersion,
        serverInfo: r.serverInfo,
        capabilities: r.capabilities,
        instructions: r.instructions,
        raw,
      }
    },
    async close(): Promise<void> {
      await terminate?.()
      await client.close()
    },
  }
  return connection
}
