/**
 * @rivetos/mcp-v1 — the sessionful MCP server mount on SDK 1.30 (protocol
 * 2025-11-25). Used by the memory sidecar stdio path and as a fallback for
 * clients that have not yet adopted the 2026-07-28 final. The primary
 * transport plugin and claude-cli bridge default to @rivetos/mcp-v2.
 * Exact-pinned SDK; never shares a package.json with v2.
 */

export {
  createMcpServer,
  createStdioMcpServer,
  defaultEchoTool,
  RIVETOS_MCP_SERVER_NAME,
  RIVETOS_MCP_SERVER_VERSION,
} from './server.js'
export type {
  RivetMcpServer,
  RivetMcpServerOptions,
  RivetMcpStdioServer,
  RivetMcpStdioServerOptions,
  ToolRegistration,
} from './server.js'
export { createSessionAttachTool, sessionAttachInputSchema } from './session-attach.js'
export type {
  SessionState,
  SessionAttachResult,
  CreateSessionAttachToolOptions,
} from './session-attach.js'
