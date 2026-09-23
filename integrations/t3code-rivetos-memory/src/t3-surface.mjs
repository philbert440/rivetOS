/**
 * T3 Code extension surface as verified against pingdotgg/t3code (main) and
 * t3.codes docs on 2026-09-22. Update this file when T3 ships a real plugin API.
 *
 * Verified:
 * - T3 is a harness control surface (Claude, Codex, Cursor, Grok Build,
 *   OpenCode, Antigravity). It does not run an in-process third-party plugin
 *   host on current main (no @t3tools/plugin-api package, no plugin-architecture
 *   doc, t3.json has icon/scripts only).
 * - T3 injects its own HTTP MCP server as mcpServers.t3-code
 *   { type: "http", url: "http://127.0.0.1:<port>/mcp", headers: { Authorization } }
 *   for preview/device tools. That is the only T3-owned tool surface.
 * - Claude sessions also pass settingSources: ["user","project","local"], so
 *   Claude's own mcpServers (stdio or http) load beside t3-code.
 * - RFC #6419 proposed an Add-plugin tile that stores a page URL plus optional
 *   mcpUrl (HTTP only, no headers) and merges it into agent mcpServers. That
 *   field is not in packages/contracts/src/settings.ts on current main.
 * - RFC #5020 (Pi-style lifecycle hooks / context injection) is a feature
 *   request. Composer docs have no hook that auto-injects third-party context.
 *
 * Closest working extension point today: register RivetOS MCP on the harness
 * T3 launches. Memories enter the thread only when the agent calls a tool —
 * there is no T3 context-injection hook to stub.
 *
 * Automatic write path is host-side: bin/t3code-memory-capture.sh polls
 * ~/.t3/userdata/state.sqlite (not a T3 plugin hook).
 */

export const T3_PLUGIN_NAME_PATTERN = /^[a-z0-9-]+$/

export const T3_SURFACE = Object.freeze({
  firstClassPluginApi: false,
  contextInjectionHooks: false,
  t3JsonMcpField: false,
  builtInMcp: Object.freeze({
    serverName: 't3-code',
    type: 'http',
    path: '/mcp',
    toolPrefix: 'mcp__t3-code__',
    headers: 'Authorization Bearer (T3-issued, preview scope only)',
  }),
  closestWorking: 'harness-native-mcp',
  proposedNotShipped: 'http-mcp-url',
  claudeSettingSources: Object.freeze(['user', 'project', 'local']),
  pluginNamePattern: T3_PLUGIN_NAME_PATTERN.source,
  sources: Object.freeze([
    'https://github.com/pingdotgg/t3code',
    'https://github.com/pingdotgg/t3code/blob/main/docs/README.md',
    'https://github.com/pingdotgg/t3code/blob/main/packages/contracts/src/t3ProjectFile.ts',
    'https://github.com/pingdotgg/t3code/blob/main/packages/contracts/src/settings.ts',
    'https://github.com/pingdotgg/t3code/issues/6419',
    'https://github.com/pingdotgg/t3code/issues/5020',
    'https://github.com/pingdotgg/t3code/issues/1582',
  ]),
})

/**
 * Shape T3 already uses for its own MCP injection, minus headers (RFC #6419
 * said plugin MCP URLs carry no headers so T3 never stores plugin secrets).
 *
 * @param {string} url
 */
export function t3HttpMcpServer(url) {
  return { type: 'http', url }
}

/**
 * RFC #6419 plugin entry. Not loaded by current T3; shipped so the prototype
 * matches the closest documented registration shape.
 *
 * @param {{ name: string, url: string, mcpUrl: string, title?: string, description?: string }} entry
 */
export function t3PluginEntry(entry) {
  if (!T3_PLUGIN_NAME_PATTERN.test(entry.name)) {
    throw new Error(`T3 plugin name must match [a-z0-9-]: ${entry.name}`)
  }
  return {
    name: entry.name,
    title: entry.title ?? entry.name,
    description: entry.description ?? '',
    url: entry.url,
    mcpUrl: entry.mcpUrl,
  }
}
