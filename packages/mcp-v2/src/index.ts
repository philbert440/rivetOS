/**
 * @rivetos/mcp-v2 — server + client mounts on the MCP 2026-07-28 RC beta
 * SDKs (exact-pinned; bumped together at RC final with the round-trip
 * harness as the gate). Stateless: no sessions, no initialize, no
 * session_attach. Never shares a package.json with @rivetos/mcp-v1.
 */

export {
  createV2McpServer,
  RIVETOS_MCP_V2_SERVER_NAME,
  RIVETOS_MCP_V2_SERVER_VERSION,
  type V2McpServer,
  type V2McpServerOptions,
} from './server.js'
export {
  connectV2,
  type V2ClientConnectOptions,
  type V2McpConnection,
  type V2ToolInfo,
  type V2RawToolResult,
} from './client.js'
