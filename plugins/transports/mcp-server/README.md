# @rivetos/mcp-server

RivetOS MCP server — exposes RivetOS tools (memory, skills, runtime,
utility) to MCP-aware clients (claude-cli, Claude Desktop, Cursor, etc.)
over the [Model Context Protocol](https://modelcontextprotocol.io/).

## Status

**Phase 1.A — Slice 1.B'.1.** StreamableHTTP server with `/health/live`, the
`echo` smoke-test tool, the full memory data-plane (`memory_search`,
`memory_browse`, `memory_stats`), web tools (`internet_search`, `web_fetch`),
skill tools (`skill_list`, `skill_manage`), bearer-token auth on TCP +
optional unix-socket binding, the per-session `session_attach`
handshake tool, and the **utility surface** — `shell`, `file_read`/`write`/
`edit`, `search_glob`/`grep` (opt-in via env). Runtime-context tools
(`delegate_task`, `subagent_*`, `ask_user`, `todo`, `compact_context`) and
the claude-cli bridge follow in subsequent slices per
[`/rivet-shared/plans/mcp-architecture-overhaul.md`](../../).

## Quick start

```bash
# from the repo root
nx run mcp-server:build
node plugins/transports/mcp-server/dist/cli.js
# server now listening on http://127.0.0.1:5700/mcp

# liveness probe
curl http://127.0.0.1:5700/health/live
# → {"status":"ok","name":"rivetos-mcp-server","version":"0.4.0-beta.5"}
```

Environment:

| Var                          | Default       | Notes                                                                   |
|------------------------------|---------------|-------------------------------------------------------------------------|
| `MCP_HOST`                   | `127.0.0.1`   | Bind host (ignored when `RIVETOS_MCP_SOCKET` is set)                    |
| `MCP_PORT`                   | `5700`        | Bind port (ignored when `RIVETOS_MCP_SOCKET` is set)                    |
| `RIVETOS_MCP_SOCKET`         | _(unset)_     | Bind to a unix socket at this path INSTEAD of TCP. Created mode 0600 — filesystem perms ARE the auth boundary, bearer token is skipped. |
| `RIVETOS_MCP_TOKEN`          | _(unset)_     | Bearer token. Required for TCP binds in any non-dev setup. Compared in constant time against `Authorization: Bearer <token>`. |
| `RIVETOS_MCP_REQUIRE_BEARER` | `0`           | Set to `1` to require bearer even on a unix socket (defense-in-depth).  |
| `RIVETOS_PG_URL`             | _(unset)_     | Postgres connection string. Enables all three `memory_*` tools.         |
| `RIVETOS_EMBED_URL`          | _(unset)_     | Embedding endpoint for hybrid (FTS + semantic) ranking.                 |
| `RIVETOS_EMBED_MODEL`        | `nemotron`    | Embedding model name.                                                   |
| `GOOGLE_CSE_API_KEY`         | _(unset)_     | Optional Google Custom Search key for `internet_search`.                |
| `GOOGLE_CSE_ID`              | _(unset)_     | Required alongside `GOOGLE_CSE_API_KEY`. DuckDuckGo is used otherwise.  |
| `RIVETOS_USER_AGENT`         | _(default)_   | Override for `web_fetch`.                                               |
| `RIVETOS_SKILL_DIRS`         | `~/.rivetos/skills` | Colon-separated dirs to scan for skills. Both workspace + system dirs are writable from MCP. |
| `RIVETOS_MCP_ENABLE_SHELL`   | `0`           | Set to `1` to enable `shell`. **Write surface** — runs arbitrary shell as the server process. |
| `RIVETOS_MCP_ENABLE_FILE`    | `0`           | Set to `1` to enable `file_read`, `file_write`, `file_edit`. **Write surface.**       |
| `RIVETOS_MCP_ENABLE_SEARCH`  | `0`           | Set to `1` to enable `search_glob`, `search_grep` (read-only — gated for symmetry, safe to enable). |

When `RIVETOS_PG_URL` is unset, the memory tools are disabled but the server
still serves `echo` and the web tools — useful for smoke-testing the
wire without a database.

## Tool catalog

| Tool                       | When                  | What it does |
|----------------------------|-----------------------|--------------|
| `echo`             | Always                | Echoes input back, prefixed with `echo:`. Smoke test for the wire. |
| `session_attach`   | Always (per-session)  | Handshake — records `{agent, runtimePid, clientName}` and returns canonical `{sessionId, serverVersion, capabilities}`. Optional but recommended as the first call. |
| `memory_search`    | `RIVETOS_PG_URL` set  | Search RivetOS persistent memory (conversations + summaries). Hybrid FTS + semantic + temporal scoring with auto-expansion. |
| `memory_browse`    | `RIVETOS_PG_URL` set  | Browse messages chronologically by conversation, agent, or time window. |
| `memory_stats`     | `RIVETOS_PG_URL` set  | Memory system health: counts, embedding queue, unsummarized backlog, freshness. |
| `internet_search`  | Always                | Web search — Google CSE when configured, DuckDuckGo fallback otherwise. |
| `web_fetch`        | Always                | Fetch and extract readable content from a URL (HTML → markdown). |
| `skill_list`       | Always                | List discovered skills with names, descriptions, version, file count. |
| `skill_manage`     | Always                | Create / edit / patch / delete / retire / read / write_file skills. Workspace and system dirs both writable. |
| `shell`            | `RIVETOS_MCP_ENABLE_SHELL=1` | Execute a shell command. Maintains a session cwd across calls (`cd` persists). |
| `file_read`        | `RIVETOS_MCP_ENABLE_FILE=1`  | Read file contents with optional line range and line numbers. Binary files refused. |
| `file_write`       | `RIVETOS_MCP_ENABLE_FILE=1`  | Write content to a file. Creates parent dirs. Optional `.bak` backup. |
| `file_edit`        | `RIVETOS_MCP_ENABLE_FILE=1`  | Replace an exact string in a file. Fails if not unique. |
| `search_glob`      | `RIVETOS_MCP_ENABLE_SEARCH=1` | Find files matching a glob (excludes `node_modules`, `.git`, build dirs). |
| `search_grep`      | `RIVETOS_MCP_ENABLE_SEARCH=1` | Search file contents by regex/literal. Returns `file:line:match`. |

## Auth model

- **TCP** (default): bearer token via `RIVETOS_MCP_TOKEN`. `Authorization: Bearer <token>` required for `/mcp`; constant-time compare. `/health/live` always open. If the token is unset, the server logs a warning at startup — fine for localhost dev, never for any other deployment.
- **Unix socket** (`RIVETOS_MCP_SOCKET=/path`): the socket file is created mode `0600` and owned by the spawning process. Anyone who can `connect()` already passed the OS auth check, so the bearer is skipped. Set `RIVETOS_MCP_REQUIRE_BEARER=1` for defense-in-depth.

This is the simplified Phase 1.A.7' auth — it matches the "MCP server just for claude-cli for now" scope (claude-cli is a child process on the same host). mTLS / per-agent client certs are a later concern if the server ever needs to be network-accessible.

## Programmatic use

```ts
import {
  createMcpServer,
  defaultEchoTool,
  createMemoryTools,
  createWebTools,
} from '@rivetos/mcp-server'

const memory = createMemoryTools({ pgUrl: process.env.RIVETOS_PG_URL! })
const web = createWebTools()

const server = createMcpServer({
  host: '127.0.0.1',
  port: 5700,
  tools: [defaultEchoTool(), ...memory.tools, ...web.tools],
})

await server.start()
// …
await server.stop()
await memory.close() // drain pg pool
await web.close()    // no-op, included for symmetry
```

## Adapting your own RivetOS tools

```ts
import { adaptRivetTool } from '@rivetos/mcp-server'
import { z } from 'zod'

const adapted = adaptRivetTool(myRivetTool, {
  query: z.string(),
  limit: z.number().optional(),
}, {
  name: 'my_tool',
})
```

`adaptRivetTool` flattens `string | ContentPart[]` results to a single
text payload for the current wire shape. A future slice widens the wire to
mirror MCP's native content array.

## Testing

```bash
nx test mcp-server
```

The test suite spins the server on an ephemeral port and round-trips
`initialize → tools/list → tools/call` over real HTTP using the MCP SDK
client. `memory.test.ts` is auto-skipped when `RIVETOS_PG_URL` is unset.
`web.test.ts` runs `internet_search` against the real network — set
`RIVETOS_TEST_SKIP_NETWORK=1` to skip that one in offline environments.

## Roadmap

- **1.B'** In-process runtime/utility tools (`delegate_task`, `subagent_*`,
  `ask_user`, `todo`, `compact_context`, `shell`, `file_*`, `search_*`)
- **1.C** Claude-CLI bridge — synthesize `--mcp-config`, mint per-spawn token,
  native-vs-MCP allow-list

See the architecture plan for the full picture.
