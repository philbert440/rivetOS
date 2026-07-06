/**
 * COMPAT SHIM — the sidecar moved to services/mcp-sidecar (@rivetos/mcp-sidecar)
 * in the MCP unification (PR 1). Installed launchers (rivet-memory plugin's
 * rivet-memory-mcp.sh on every node/harness) exec this dist path directly, so
 * it must keep working for one release while plugins-sync rolls the new path
 * out. Path-based dynamic import: deliberately NOT a package dependency —
 * a transport plugin must not depend on an app, and this shim is deployment
 * glue, not an architectural edge. Delete once fleet launchers point at
 * services/mcp-sidecar/dist/cli.js.
 */
const target = new URL('../../../../services/mcp-sidecar/dist/cli.js', import.meta.url)
await import(target.href)
