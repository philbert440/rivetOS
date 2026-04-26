# @rivetos/mcp-server

RivetOS MCP server — exposes RivetOS tools (memory, skills, runtime,
utility) to MCP-aware clients (claude-cli, Claude Desktop, Cursor, etc.)
over the [Model Context Protocol](https://modelcontextprotocol.io/).

## Status

**Phase 1.A — Slice 1.** Bare StreamableHTTP server with `/health/live`
and a single `rivetos.echo` smoke-test tool. Real tools (`memory_search`,
`memory_browse`, `skill_*`, `web_fetch`, runtime-plane proxies) land in
subsequent slices per
[`/rivet-shared/plans/mcp-architecture-overhaul.md`](../../).

## Quick start

```bash
# from the repo root
nx run mcp-server:build
node packages/mcp-server/dist/cli.js
# server now listening on http://127.0.0.1:5700/mcp

# liveness probe
curl http://127.0.0.1:5700/health/live
# → {"status":"ok","name":"rivetos-mcp-server","version":"0.4.0-beta.2"}
```

Environment:

| Var        | Default       | Notes                          |
|------------|---------------|--------------------------------|
| `MCP_HOST` | `127.0.0.1`   | Bind host                      |
| `MCP_PORT` | `5700`        | Bind port                      |

## Programmatic use

```ts
import { createMcpServer } from '@rivetos/mcp-server'

const server = createMcpServer({ host: '127.0.0.1', port: 5700 })
await server.start()
// …
await server.stop()
```

## Testing

```bash
nx test mcp-server
```

The test suite spins the server on an ephemeral port and round-trips
`initialize → tools/list → tools/call` over real HTTP using the MCP
SDK client.

## Roadmap

- **1.A.2** mTLS via `rivet-ca`, `rivetos/session.attach` handshake
- **1.A.3** Wire data-plane tools: `memory_search`, `memory_browse`,
  `memory_stats`, `skill_list`, `skill_manage`, `web_fetch`,
  `internet_search`
- **1.A.4** `infra/docker/mcp-stack/docker-compose.yml`
- **1.B** Runtime-RPC + runtime/utility-plane proxies (`:5701`)
- **1.C** Claude-CLI bridge

See the architecture plan for the full picture.
