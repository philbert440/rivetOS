# @rivetos/mcp-server

RivetOS MCP server — exposes RivetOS tools (memory, skills, runtime,
utility) to MCP-aware clients (claude-cli, Claude Desktop, Cursor, etc.)
over the [Model Context Protocol](https://modelcontextprotocol.io/).

## Status

**Phase 1.A — Slice 3.** StreamableHTTP server with `/health/live`, the
`rivetos.echo` smoke-test tool, the full memory data-plane (`memory_search`,
`memory_browse`, `memory_stats`), and web tools (`internet_search`,
`web_fetch`). mTLS, `session.attach`, skill tools, and the runtime-plane
follow in subsequent slices per
[`/rivet-shared/plans/mcp-architecture-overhaul.md`](../../).

## Quick start

```bash
# from the repo root
nx run mcp-server:build
node plugins/transports/mcp-server/dist/cli.js
# server now listening on http://127.0.0.1:5700/mcp

# liveness probe
curl http://127.0.0.1:5700/health/live
# → {"status":"ok","name":"rivetos-mcp-server","version":"0.4.0-beta.4"}
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

- **1.A.4** `infra/docker/mcp-stack/docker-compose.yml`
- **1.A.5** Skill tools (`skill_list`, `skill_manage`)
- **1.A.6** mTLS via `rivet-ca`, `rivetos/session.attach` handshake
- **1.B** Runtime-RPC + runtime/utility-plane proxies (`:5701`)
- **1.C** Claude-CLI bridge

See the architecture plan for the full picture.
