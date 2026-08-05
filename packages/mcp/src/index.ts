/**
 * @rivetos/mcp — the unified MCP core (phase-0 MCP unification + 2026-07-28 final).
 *
 * SDK-agnostic: ToolRegistration + the RivetOS Tool adapters. Transport
 * mounts live in @rivetos/mcp-v1 (SDK 1.x — sessionful 2025-11-25, Claude Code
 * / bridge world) and @rivetos/mcp-v2 (SDK 2.0 — stateless 2026-07-28 final).
 */

export type {
  ToolRegistration,
  ToolAnnotations,
  ToolContentBlock,
  TextContentBlock,
  ImageContentBlock,
  StructuredToolResult,
  InputRequiredToolResult,
  ToolExecuteResult,
  ToolExecuteContext,
} from './registration.js'
export {
  isInputRequiredResult,
  isStructuredToolResult,
  normalizeToolResult,
} from './registration.js'
export {
  adaptRivetTool,
  adaptRivetToolDynamic,
  jsonSchemaToZodShape,
  toolResultToString,
  toolResultToStructured,
  type AdaptRivetToolOptions,
} from './adapt.js'
