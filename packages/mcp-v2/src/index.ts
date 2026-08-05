/**
 * @rivetos/mcp-v2 — server + client mounts on the MCP 2026-07-28 final
 * SDKs (exact-pinned @modelcontextprotocol/{server,client,node}@2.0.0).
 * Stateless: no sessions, no initialize, no session_attach.
 * Never shares a package.json with @rivetos/mcp-v1.
 */

export {
  createV2McpServer,
  RIVETOS_MCP_V2_SERVER_NAME,
  RIVETOS_MCP_V2_SERVER_VERSION,
  DEFAULT_TOOLS_LIST_CACHE,
  type V2McpServer,
  type V2McpServerOptions,
} from './server.js'
export {
  connectV2,
  type V2ClientConnectOptions,
  type V2McpConnection,
  type V2ToolInfo,
  type V2RawToolResult,
  type V2DiscoverResult,
  type V2ListToolsOptions,
  type V2CallToolOptions,
} from './client.js'
export {
  withTaskSupport,
  getTaskSupport,
  TASKS_EXTENSION_ID,
  type TaskSupport,
  type TaskAwareOptions,
} from './tasks.js'
