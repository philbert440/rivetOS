/**
 * @rivetos/mcp-server
 *
 * RivetOS MCP server — exposes RivetOS tools (memory, skills, runtime,
 * utility) over the Model Context Protocol.
 *
 * Phase 1.A — Slice 1: bare StreamableHTTP server with `/health/live`
 * and an `rivetos.echo` smoke-test tool. mTLS, session.attach handshake,
 * and real tools (memory_search, etc.) follow in subsequent slices.
 *
 * See: /rivet-shared/plans/mcp-architecture-overhaul.md §Phase 1
 */

export { createMcpServer } from './server.js'
export type { RivetMcpServer, RivetMcpServerOptions, ToolRegistration } from './server.js'
