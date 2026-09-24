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
      Preset name or id wins over a runtime agent id. Postgres direct
      (no gateway). RIVETOS_MCP_ENABLE_DELEGATE=0 disables both.
      delegate_task is registered only in stdio mode (--stdio or
      RIVETOS_MCP_STDIO=1). HTTP and unix-socket mode do not register it:
      delegate_task needs a per-harness stdio sidecar for the chain guard.
      list_agents still registers there.
      RIVETOS_TASK_ID is the parent ros_tasks id for the chain guard. A
      non-UUID value does not disable the tools; depth fail-closes.
      The call blocks until the task finishes (default 20 minutes, max 30).
      Set the client tool-call timeout above that wait or the client aborts
      and the row is killed: Codex tool_timeout_sec (default 60 is too low)
      and Claude Code's MCP timeout.
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
  RIVETOS_MESH_DIR
      Directory containing mesh.json. Checked before RIVETOS_SHARED_DIR.
      Boot writes mesh.json to mesh.storage_dir or the shared dir; set
      RIVETOS_MESH_DIR when that directory is not the shared dir.
  RIVETOS_NODE_NAME
      This node on delegate rows. Must equal mesh.node_name when
      mesh.node_name is set. Fallback: HOSTNAME, then local (boot's rule,
      not the OS hostname).
  RIVETOS_AGENT_ID
      requestedBy on delegate rows. Default mcp-sidecar.
`

export function wantsHelp(argv: string[]): boolean {
  return argv.includes('--help') || argv.includes('-h')
}
