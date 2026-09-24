/** Usage text for `--help` / `-h`. Printed to stdout; process exits 0. */
export const USAGE = `Usage: rivetos-mcp-sidecar [options]

Standalone RivetOS MCP server.

Options:
  --stdio          Speak MCP over stdin/stdout (also RIVETOS_MCP_STDIO=1)
  --help, -h       Print this help and exit 0 (no server, no tools)

Transports:
  --stdio or RIVETOS_MCP_STDIO=1
      MCP over stdin/stdout. No auth (the parent owns the pipe).
  RIVETOS_MCP_SOCKET=<path>
      Bind a unix socket (mode 0600). Filesystem perms are the auth boundary
      unless RIVETOS_MCP_REQUIRE_BEARER=1.
  default (no --stdio / RIVETOS_MCP_STDIO / RIVETOS_MCP_SOCKET)
      Bind TCP 127.0.0.1:5700 (MCP_HOST / MCP_PORT). Unauthenticated unless
      RIVETOS_MCP_TOKEN is set.

Always-on tools:
  echo
  skill_list, skill_manage
      skill_manage can create, edit, and delete files under the skill
      directories (default ~/.rivetos/skills).
  internet_search, web_fetch
      Outbound network.

RIVETOS_PG_URL enables:
  memory_search, memory_browse, memory_stats, memory_get_full (read-only)
  wiki_search, wiki_read
  delegate_task, list_agents
      Preset name/id or a runtime agent id. Postgres direct (no gateway).
      RIVETOS_MCP_ENABLE_DELEGATE=0 disables both.
      RIVETOS_TASK_ID is read for the chain guard.
  WIKI_DIR selects the wiki repo root (see RIVETOS_SHARED_DIR).

Opt-in (off by default):
  RIVETOS_MCP_ENABLE_SHELL=1           shell
  RIVETOS_MCP_ENABLE_FILE=1            file_read, file_write, file_edit
  RIVETOS_MCP_ENABLE_SEARCH=1          search_glob, search_grep
  RIVETOS_MCP_ENABLE_MEMORY_WRITE=1    memory_append, memory_ingest_session

Other environment:
  RIVETOS_MCP_TOKEN, RIVETOS_MCP_REQUIRE_BEARER
  RIVETOS_EMBED_URL, RIVETOS_EMBED_MODEL
  GOOGLE_CSE_API_KEY (or GOOGLE_API_KEY) + GOOGLE_CSE_ID
  RIVETOS_USER_AGENT, RIVETOS_SKILL_DIRS, WIKI_DIR, RIVETOS_SHARED_DIR
  RIVETOS_NODE_NAME, RIVETOS_AGENT_ID
      Labels on delegate_task rows (default: hostname, mcp-sidecar).
`

export function wantsHelp(argv: string[]): boolean {
  return argv.includes('--help') || argv.includes('-h')
}
