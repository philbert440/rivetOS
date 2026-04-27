# @rivetos/mcp-server

RivetOS MCP server — exposes RivetOS tools (memory, skills, runtime,
utility) to MCP-aware clients (claude-cli, Claude Desktop, Cursor, etc.)
over the [Model Context Protocol](https://modelcontextprotocol.io/).

## Status

**Phase 1.A — Slice 6.** StreamableHTTP server with `/health/live`, the
`rivetos.echo` smoke-test tool, the full memory data-plane (`memory_search`,
`memory_browse`, `memory_stats`), web tools (`internet_search`, `web_fetch`),
and skill tools (`skill_list`, `skill_manage`). Auth (`session.attach` over
unix socket), runtime/utility tools, and the claude-cli bridge follow in
subsequent slices per
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

| Var                   | Default       | Notes                                                                   |
|-----------------------|---------------|-------------------------------------------------------------------------|
| `MCP_HOST`            | `127.0.0.1`   | Bind host                                                               |
| `MCP_PORT`            | `5700`        | Bind port                                                               |
| `RIVETOS_PG_URL`      | _(unset)_     | Postgres connection string. Enables all three `memory_*` tools.         |
| `RIVETOS_EMBED_URL`   | _(unset)_     | Embedding endpoint for hybrid (FTS + semantic) ranking.                 |
| `RIVETOS_EMBED_MODEL` | `nemotron`    | Embedding model name.                                                   |
| `GOOGLE_CSE_API_KEY`  | _(unset)_     | Optional Google Custom Search key for `internet_search`.                |
| `GOOGLE_CSE_ID`       | _(unset)_     | Required alongside `GOOGLE_CSE_API_KEY`. DuckDuckGo is used otherwise.  |
| `RIVETOS_USER_AGENT`  | _(default)_   | Override for `web_fetch`.                                               |
| `RIVETOS_SKILL_DIRS`  | `~/.rivetos/skills` | Colon-separated dirs to scan for skills. Both workspace + system dirs are writable from MCP. |

When `RIVETOS_PG_URL` is unset, the memory tools are disabled but the server
still serves `rivetos.echo` and the web tools — useful for smoke-testing the
wire without a database.

## Tool catalog

| Tool                       | When                  | What it does |
|----------------------------|-----------------------|--------------|
| `rivetos.echo`             | Always                | Echoes input back, prefixed with `echo:`. Smoke test for the wire. |
| `rivetos.memory_search`    | `RIVETOS_PG_URL` set  | Search RivetOS persistent memory (conversations + summaries). Hybrid FTS + semantic + temporal scoring with auto-expansion. |
| `rivetos.memory_browse`    | `RIVETOS_PG_URL` set  | Browse messages chronologically by conversation, agent, or time window. |
| `rivetos.memory_stats`     | `RIVETOS_PG_URL` set  | Memory system health: counts, embedding queue, unsummarized backlog, freshness. |
| `rivetos.internet_search`  | Always                | Web search — Google CSE when configured, DuckDuckGo fallback otherwise. |
| `rivetos.web_fetch`        | Always                | Fetch and extract readable content from a URL (HTML → markdown). |
| `rivetos.skill_list`       | Always                | List discovered skills with names, descriptions, version, file count. |
| `rivetos.skill_manage`     | Always                | Create / edit / patch / delete / retire / read / write_file skills. Workspace and system dirs both writable. |

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
  name: 'rivetos.my_tool',
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

- **1.A.7'** Bearer-token auth + `rivetos.session.attach` over unix socket
- **1.B'** In-process runtime/utility tools (`delegate_task`, `subagent_*`,
  `ask_user`, `todo`, `compact_context`, `shell`, `file_*`, `search_*`)
- **1.C** Claude-CLI bridge — synthesize `--mcp-config`, mint per-spawn token,
  native-vs-MCP allow-list

See the architecture plan for the full picture.
