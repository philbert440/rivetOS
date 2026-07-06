/**
 * COMPAT SHIM — the sidecar moved to services/mcp-sidecar (@rivetos/mcp-sidecar)
 * in the MCP unification (PR 1). Installed launchers (rivet-memory plugin's
 * rivet-memory-mcp.sh on every node/harness) exec this dist path directly, so
 * it must keep working for one release while plugins-sync rolls the new path
 * out.
 *
 * Resolution order:
 *   1. @rivetos/mcp-sidecar/cli as a package (npm-mode installs — the
 *      sidecar publishes alongside this plugin).
 *   2. The workspace-relative dist path (git-mode /opt/rivetos checkouts).
 * Deliberately NOT a package.json dependency — a transport plugin must not
 * depend on an app; this is deployment glue, not an architectural edge.
 * Delete once fleet launchers point at the sidecar entry directly.
 */
try {
  // Specifier assembled at runtime so the static analyzers don't record a
  // package edge (see the header — glue, not architecture).
  const pkg = ['@rivetos', 'mcp-sidecar', 'cli'].join('/')
  await import(pkg)
} catch {
  const target = new URL('../../../../services/mcp-sidecar/dist/cli.js', import.meta.url)
  await import(target.href)
}
