/**
 * @rivetos/mcp — the unified MCP core (phase-0 MCP unification, PR 1).
 *
 * SDK-agnostic: ToolRegistration + the RivetOS Tool adapters. Transport
 * mounts live in @rivetos/mcp-v1 (SDK 1.29 — sessionful, the Claude Code /
 * bridge world) and, from PR 2, the 2026-07-28 RC v2 mount.
 */

export type { ToolRegistration } from './registration.js'
export {
  adaptRivetTool,
  adaptRivetToolDynamic,
  jsonSchemaToZodShape,
  toolResultToString,
  type AdaptRivetToolOptions,
} from './adapt.js'
