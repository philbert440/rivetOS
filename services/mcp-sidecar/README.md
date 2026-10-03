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

## Den or Postgres

`RIVETOS_MCP_TRANSPORT=den|pg` selects the backend for memory, wiki, and
delegate tools. The default is `den` when `RIVET_DEN_URL` is set and
`RIVETOS_USER_ID` is empty: every one of those tools is an HTTPS call to the
node's own den and this process opens no Postgres pool. Otherwise `pg` is
used when `RIVETOS_PG_URL` is set. A non-empty `RIVETOS_USER_ID` stays on `pg`
even if transport is forced to `den`, because a loopback den call is the
owner pool. The launcher resolves `RIVET_DEN_URL` from `den.port` (default
5174) and exports the CA as `NODE_EXTRA_CA_CERTS`. Tool names and input
schemas are the same on both transports. `delegate_task` is still stdio-only.

## `RIVETOS_PG_URL`

On transport `pg`, this also registers the read-only memory tools (`memory_search`,
`memory_browse`, `memory_stats`, `memory_get_full`, `memory_tags`) and the wiki tools
(`wiki_search`, `wiki_read`). `WIKI_DIR` is the wiki repo root used by
`wiki_read` (default `$RIVETOS_SHARED_DIR/wiki`, and `RIVETOS_SHARED_DIR`
defaults to `/rivet-shared`). Memory write tools stay off until
`RIVETOS_MCP_ENABLE_MEMORY_WRITE=1`; the same flag lets `memory_tags` decide
suggestions, add tags and edit the vocabulary (on either transport it answers
only its read actions otherwise). On transport `den` the same flag registers
sidecar proxies for `memory_append` / `memory_ingest_session`. The den must
independently have those write tools mounted; otherwise it returns 404.

## Environment

| Variable | Default | Notes |
| --- | --- | --- |
| `RIVETOS_MCP_STDIO` | unset | `1` — MCP over stdin/stdout. Also enabled by `--stdio`. Ignores host/port/socket; no auth (the parent owns the pipe). |
| `MCP_HOST` | `127.0.0.1` | TCP bind host (ignored when stdio or `RIVETOS_MCP_SOCKET` is set). |
| `MCP_PORT` | `5700` | TCP bind port. |
| `RIVETOS_MCP_SOCKET` | unset | Unix socket path instead of TCP. Created mode `0600`; filesystem perms are the auth boundary. |
| `RIVETOS_MCP_TOKEN` | unset | Bearer token. Compared in constant time against `Authorization: Bearer <token>`. Unset + TCP bind = unauthenticated. |
| `RIVETOS_MCP_REQUIRE_BEARER` | unset | `1` — demand bearer even on the unix socket. |
| `RIVETOS_MCP_TRANSPORT` | `den` when `RIVET_DEN_URL` is set and `RIVETOS_USER_ID` is empty, else `pg` when `RIVETOS_PG_URL` is set | `den` or `pg`. `den` calls the local den over HTTPS and opens no Postgres pool. A non-empty `RIVETOS_USER_ID` keeps `pg`. |
| `RIVET_DEN_URL` | unset | Den origin, for example `https://127.0.0.1:5174`. The memory launcher fills this from `den.port` when unset. |
| `RIVET_DEN_CA` | unset | CA PEM. The launcher exports it as `NODE_EXTRA_CA_CERTS` before `node` starts. A missing file disables den transport. |
| `RIVETOS_PG_URL` | unset | Postgres URL for transport `pg`. Enables read-only `memory_*` tools and `wiki_search` / `wiki_read`. |
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
| `RIVETOS_MCP_ENABLE_MEMORY_WRITE` | unset | `1` — enable `memory_append` and `memory_ingest_session` (write surface, off by default). Requires den or `RIVETOS_PG_URL`. |

## License

Apache-2.0
