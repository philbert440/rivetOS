/**
 * @rivetos/mcp-server — the in-process MCP transport plugin (v2 stateless,
 * 2026-07-28 RC).
 *
 * Post-unification this package is the transport MANIFEST plus core
 * re-exports. The SDK-agnostic core lives in @rivetos/mcp; the v2 mount
 * (HTTP + era-negotiating stdio) in @rivetos/mcp-v2; the standalone
 * sidecar in @rivetos/mcp-sidecar.
 * dist/cli.js remains a compat shim for installed rivet-memory-mcp.sh
 * launchers.
 */

export {
  adaptRivetTool,
  adaptRivetToolDynamic,
  jsonSchemaToZodShape,
  toolResultToString,
} from '@rivetos/mcp'
export type { AdaptRivetToolOptions, ToolRegistration } from '@rivetos/mcp'

export { manifest } from './manifest.js'
