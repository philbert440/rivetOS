/**
 * @rivetos/mcp-server — the in-process MCP transport plugin.
 *
 * Post-unification (PR 1) this package is the transport MANIFEST plus
 * compatibility re-exports: the SDK-agnostic core lives in @rivetos/mcp,
 * the SDK-1.29 server mount in @rivetos/mcp-v1, and the standalone sidecar
 * (curated memory/web/skills/file/shell/search tool suites + cli) in
 * @rivetos/mcp-sidecar. dist/cli.js remains a compat shim for installed
 * rivet-memory-mcp.sh launchers.
 */

export {
  createMcpServer,
  createStdioMcpServer,
  defaultEchoTool,
  RIVETOS_MCP_SERVER_NAME,
  RIVETOS_MCP_SERVER_VERSION,
  createSessionAttachTool,
  sessionAttachInputSchema,
} from '@rivetos/mcp-v1'
export type {
  RivetMcpServer,
  RivetMcpServerOptions,
  RivetMcpStdioServer,
  RivetMcpStdioServerOptions,
  ToolRegistration,
  SessionState,
  SessionAttachResult,
  CreateSessionAttachToolOptions,
} from '@rivetos/mcp-v1'

export {
  adaptRivetTool,
  adaptRivetToolDynamic,
  jsonSchemaToZodShape,
  toolResultToString,
} from '@rivetos/mcp'
export type { AdaptRivetToolOptions } from '@rivetos/mcp'

export { manifest } from './manifest.js'
