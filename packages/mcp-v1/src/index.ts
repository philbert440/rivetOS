/**
 * @rivetos/mcp-v1 — the sessionful MCP server mount on SDK 1.29 (the world
 * Claude Code speaks today). The claude-cli bridge and the current transport
 * plugin run on this; the v2 (2026-07-28 RC) mount replaces it for our own
 * server/client pairs in PR 2, and for the bridge when Claude Code ships RC
 * support. Exact-pinned SDK; never shares a package.json with v2.
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
