/**
 * @rivetos/mcp-server
 *
 * RivetOS MCP server — exposes RivetOS tools (memory, skills, runtime,
 * utility) over the Model Context Protocol.
 *
 * Phase 1.A — Slice 3: bare StreamableHTTP server with `/health/live`,
 * an `rivetos.echo` smoke-test tool, the full memory data-plane
 * (`memory_search`, `memory_browse`, `memory_stats`), and web tools
 * (`internet_search`, `web_fetch`). mTLS, session.attach handshake, and the
 * remaining data-plane tools (skill_*) follow in subsequent slices.
 *
 * See: /rivet-shared/plans/mcp-architecture-overhaul.md §Phase 1
 */

export { createMcpServer, defaultEchoTool } from './server.js'
export type { RivetMcpServer, RivetMcpServerOptions, ToolRegistration } from './server.js'

export { adaptRivetTool, toolResultToString } from './tools/adapt.js'
export type { AdaptRivetToolOptions } from './tools/adapt.js'

export {
  createMemoryTools,
  memorySearchInputSchema,
  memoryBrowseInputSchema,
  memoryStatsInputSchema,
} from './tools/memory.js'
export type { MemoryToolsOptions, MemoryToolsHandle } from './tools/memory.js'

// Backwards-compatibility shim — prefer `createMemoryTools`.
// eslint-disable-next-line @typescript-eslint/no-deprecated
export { createMemorySearchTool } from './tools/memory-search.js'
export type { MemorySearchToolOptions, MemorySearchToolHandle } from './tools/memory-search.js'

export { createWebTools, internetSearchInputSchema, webFetchInputSchema } from './tools/web.js'
export type { WebToolsOptions, WebToolsHandle } from './tools/web.js'

export { createSkillTools, skillListInputSchema, skillManageInputSchema } from './tools/skills.js'
export type { SkillToolsOptions, SkillToolsHandle } from './tools/skills.js'

export { createSessionAttachTool, sessionAttachInputSchema } from './tools/session-attach.js'
export type {
  SessionState,
  SessionAttachResult,
  CreateSessionAttachToolOptions,
} from './tools/session-attach.js'
