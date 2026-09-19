# @rivetos/mcp-sidecar

Standalone RivetOS MCP server. Speaks the Model Context Protocol over stdio
(the transport MCP clients use to spawn a local server), TCP, or a unix socket.

```bash
npx -y @rivetos/mcp-sidecar --stdio
npx -y @rivetos/mcp-sidecar --help
```

Equivalent to `--stdio`: set `RIVETOS_MCP_STDIO=1`. Diagnostics go to stderr so
stdout stays clean for the protocol. Pass tokens via environment variables, not
command-line arguments.

## Default invocation (no transport flag)

With neither `--stdio` / `RIVETOS_MCP_STDIO` nor `RIVETOS_MCP_SOCKET`, the
process binds TCP `127.0.0.1:5700` (`MCP_HOST` / `MCP_PORT`). That bind is
**unauthenticated** unless `RIVETOS_MCP_TOKEN` is set. This is the default
transport; `--help` / `-h` prints usage and exits 0 without starting a server.

## Always-on tools

These are registered unconditionally:

| Tool | Notes |
| --- | --- |
| `echo` | Harmless round-trip. |
| `skill_list` | Lists discovered skills. |
| `skill_manage` | Can create, edit, and delete files under the skill directories. Default write target: `~/.rivetos/skills` (override with `RIVETOS_SKILL_DIRS`, colon-separated). |
| `internet_search` | Outbound network. DuckDuckGo by default; Google CSE if `GOOGLE_CSE_API_KEY` (or `GOOGLE_API_KEY`) and `GOOGLE_CSE_ID` are set. |
| `web_fetch` | Outbound network. |

Shell, filesystem, workspace-search, and memory-write tools are **off** unless
you enable them explicitly. `skill_manage` is the exception: it always writes,
but only under the configured skill directories.

## `RIVETOS_PG_URL`

When set, also registers the read-only memory tools (`memory_search`,
`memory_browse`, `memory_stats`, `memory_get_full`) and the wiki tools
(`wiki_search`, `wiki_read`). `WIKI_DIR` is the wiki repo root used by
`wiki_read` (default `$RIVETOS_SHARED_DIR/wiki`, and `RIVETOS_SHARED_DIR`
defaults to `/rivet-shared`). Memory write tools stay off until
`RIVETOS_MCP_ENABLE_MEMORY_WRITE=1`.

## Environment

| Variable | Default | Notes |
| --- | --- | --- |
| `RIVETOS_MCP_STDIO` | unset | `1` — MCP over stdin/stdout. Also enabled by `--stdio`. Ignores host/port/socket; no auth (the parent owns the pipe). |
| `MCP_HOST` | `127.0.0.1` | TCP bind host (ignored when stdio or `RIVETOS_MCP_SOCKET` is set). |
| `MCP_PORT` | `5700` | TCP bind port. |
| `RIVETOS_MCP_SOCKET` | unset | Unix socket path instead of TCP. Created mode `0600`; filesystem perms are the auth boundary. |
| `RIVETOS_MCP_TOKEN` | unset | Bearer token. Compared in constant time against `Authorization: Bearer <token>`. Unset + TCP bind = unauthenticated. |
| `RIVETOS_MCP_REQUIRE_BEARER` | unset | `1` — demand bearer even on the unix socket. |
| `RIVETOS_PG_URL` | unset | Postgres URL. Enables read-only `memory_*` tools and `wiki_search` / `wiki_read`. |
| `WIKI_DIR` | `$RIVETOS_SHARED_DIR/wiki` | Wiki repo root for `wiki_read`. Used only when `RIVETOS_PG_URL` is set. |
| `RIVETOS_SHARED_DIR` | `/rivet-shared` | Shared-storage root; `WIKI_DIR` defaults under this. |
| `RIVETOS_EMBED_URL` | unset | Optional embedding endpoint for hybrid search. |
| `RIVETOS_EMBED_MODEL` | unset | Required when memory is on and `RIVETOS_EMBED_URL` is set. |
| `GOOGLE_CSE_API_KEY` | unset | Optional Google search backend for `internet_search` (DuckDuckGo fallback always available). |
| `GOOGLE_API_KEY` | unset | Accepted alias for `GOOGLE_CSE_API_KEY`. |
| `GOOGLE_CSE_ID` | unset | Required alongside `GOOGLE_CSE_API_KEY` / `GOOGLE_API_KEY`. |
| `RIVETOS_USER_AGENT` | unset | Optional override for `web_fetch`. |
| `RIVETOS_SKILL_DIRS` | `~/.rivetos/skills` | Colon-separated dirs to scan for skills. `skill_manage` writes here. |
| `RIVETOS_MCP_ENABLE_SHELL` | unset | `1` — enable `shell` (write surface, off by default). |
| `RIVETOS_MCP_ENABLE_FILE` | unset | `1` — enable `file_read`, `file_write`, `file_edit` (write surface, off by default). |
| `RIVETOS_MCP_ENABLE_SEARCH` | unset | `1` — enable `search_glob`, `search_grep` (read-only, off by default). |
| `RIVETOS_MCP_ENABLE_MEMORY_WRITE` | unset | `1` — enable `memory_append` and `memory_ingest_session` (write surface, off by default). Requires `RIVETOS_PG_URL`. |

## License

Apache-2.0
