/**
 * @rivetos/mcp-server
 *
 * RivetOS MCP server — exposes RivetOS tools (memory, skills, runtime,
 * utility) over the Model Context Protocol.
 *
 * Phase 1.A — Slice 2: bare StreamableHTTP server with `/health/live`,
 * an `rivetos.echo` smoke-test tool, and the first real data-plane tool
 * (`rivetos.memory_search`). mTLS, session.attach handshake, and the rest
 * of the data-plane catalog (memory_browse, memory_stats, skill_*, web_*)
 * follow in subsequent slices.
 *
 * See: /rivet-shared/plans/mcp-architecture-overhaul.md §Phase 1
 */

export { createMcpServer, defaultEchoTool } from './server.js'
export type { RivetMcpServer, RivetMcpServerOptions, ToolRegistration } from './server.js'

export { adaptRivetTool, toolResultToString } from './tools/adapt.js'
export type { AdaptRivetToolOptions } from './tools/adapt.js'

export { createMemorySearchTool, memorySearchInputSchema } from './tools/memory-search.js'
export type { MemorySearchToolOptions, MemorySearchToolHandle } from './tools/memory-search.js'
