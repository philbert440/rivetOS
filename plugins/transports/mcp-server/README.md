# @rivetos/mcp-server

RivetOS MCP server — exposes RivetOS tools (memory, skills, runtime,
utility) to MCP-aware clients (claude-cli, Claude Desktop, Cursor, etc.)
over the [Model Context Protocol](https://modelcontextprotocol.io/).

## Status

**Phase 1.A — Slice 2.** StreamableHTTP server with `/health/live`, the
`rivetos.echo` smoke-test tool, and the first real data-plane tool —
`rivetos.memory_search`. mTLS, `session.attach`, and the rest of the
data-plane (memory_browse, memory_stats, skill_*, web_*) follow in
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
# → {"status":"ok","name":"rivetos-mcp-server","version":"0.4.0-beta.4"}
```

Environment:

| Var                   | Default       | Notes                                                           |
|-----------------------|---------------|-----------------------------------------------------------------|
| `MCP_HOST`            | `127.0.0.1`   | Bind host                                                       |
| `MCP_PORT`            | `5700`        | Bind port                                                       |
| `RIVETOS_PG_URL`      | _(unset)_     | Postgres connection string. Enables `rivetos.memory_search`.    |
| `RIVETOS_EMBED_URL`   | _(unset)_     | Embedding endpoint for hybrid (FTS + semantic) ranking.         |
| `RIVETOS_EMBED_MODEL` | `nemotron`    | Embedding model name.                                           |

When `RIVETOS_PG_URL` is unset, the server starts in **echo-only mode** —
useful for smoke-testing the wire without a database.

## Tool catalog

| Tool                       | When | What it does |
|----------------------------|------|--------------|
| `rivetos.echo`             | Always | Echoes input back, prefixed with `echo:`. Smoke test for the wire. Will be retired in slice 3. |
| `rivetos.memory_search`    | `RIVETOS_PG_URL` set | Search RivetOS persistent memory (conversations + summaries). Hybrid FTS + semantic + temporal scoring with auto-expansion. |

## Programmatic use

```ts
import {
  createMcpServer,
  defaultEchoTool,
  createMemorySearchTool,
} from '@rivetos/mcp-server'

const memory = createMemorySearchTool({ pgUrl: process.env.RIVETOS_PG_URL! })

const server = createMcpServer({
  host: '127.0.0.1',
  port: 5700,
  tools: [defaultEchoTool(), memory.tool],
})

await server.start()
// …
await server.stop()
await memory.close() // drain pg pool
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
text payload for slice-2 wire compatibility. Slice 3 widens the wire shape
to mirror MCP's native content array.

## Testing

```bash
nx test mcp-server
```

The test suite spins the server on an ephemeral port and round-trips
`initialize → tools/list → tools/call` over real HTTP using the MCP
SDK client. The `memory-search.test.ts` suite is auto-skipped when
`RIVETOS_PG_URL` is unset.

## Roadmap

- **1.A.3** Wire remaining data-plane tools: `memory_browse`,
  `memory_stats`, `skill_list`, `skill_manage`, `web_fetch`,
  `internet_search`
- **1.A.4** `infra/docker/mcp-stack/docker-compose.yml`
- **1.A.5** mTLS via `rivet-ca`, `rivetos/session.attach` handshake
- **1.B** Runtime-RPC + runtime/utility-plane proxies (`:5701`)
- **1.C** Claude-CLI bridge

See the architecture plan for the full picture.
