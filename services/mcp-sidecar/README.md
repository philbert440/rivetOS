# @rivetos/mcp-sidecar

Standalone RivetOS MCP server. Speaks the Model Context Protocol over stdio
(the transport MCP clients use to spawn a local server), TCP, or a unix socket.

## Install / run

```bash
npx -y @rivetos/mcp-sidecar --stdio
```

Equivalent: set `RIVETOS_MCP_STDIO=1`. Diagnostics go to stderr so stdout stays
clean for the protocol.

Write, shell, and file tools are **off** unless you enable them explicitly.
Do not put secrets in argv or this README.

## Environment

| Variable | Default | Notes |
| --- | --- | --- |
| `RIVETOS_MCP_STDIO` | unset | `1` — MCP over stdin/stdout. Also enabled by `--stdio`. Ignores host/port/socket; no auth (the parent owns the pipe). |
| `MCP_HOST` | `127.0.0.1` | TCP bind host (ignored when stdio or `RIVETOS_MCP_SOCKET` is set). |
| `MCP_PORT` | `5700` | TCP bind port. |
| `RIVETOS_MCP_SOCKET` | unset | Unix socket path instead of TCP. Created mode `0600`; filesystem perms are the auth boundary. |
| `RIVETOS_MCP_TOKEN` | unset | Bearer token. Required for TCP in any non-dev setup. Compared in constant time against `Authorization: Bearer <token>`. |
| `RIVETOS_MCP_REQUIRE_BEARER` | unset | `1` — demand bearer even on the unix socket. |
| `RIVETOS_PG_URL` | unset | Postgres URL. Enables `memory_search`, `memory_browse`, `memory_stats`, `memory_get_full`. |
| `RIVETOS_EMBED_URL` | unset | Optional embedding endpoint for hybrid search. |
| `RIVETOS_EMBED_MODEL` | unset | Required when memory is on and `RIVETOS_EMBED_URL` is set. |
| `GOOGLE_CSE_API_KEY` | unset | Optional Google search backend for `internet_search` (DuckDuckGo fallback always available). |
| `GOOGLE_CSE_ID` | unset | Required alongside `GOOGLE_CSE_API_KEY`. |
| `RIVETOS_USER_AGENT` | unset | Optional override for `web_fetch`. |
| `RIVETOS_SKILL_DIRS` | `~/.rivetos/skills` | Colon-separated dirs to scan for skills. |
| `RIVETOS_MCP_ENABLE_SHELL` | unset | `1` — enable `shell` (write surface, off by default). |
| `RIVETOS_MCP_ENABLE_FILE` | unset | `1` — enable `file_read`, `file_write`, `file_edit` (write surface, off by default). |
| `RIVETOS_MCP_ENABLE_SEARCH` | unset | `1` — enable `search_glob`, `search_grep` (read-only, off by default). |
| `RIVETOS_MCP_ENABLE_MEMORY_WRITE` | unset | `1` — enable `memory_append` and `memory_ingest_session` (write surface, off by default). |

## License

Apache-2.0
