# MCP Stack — local docker-compose

Phase 1.A slice 5. A self-contained pair of containers — Postgres + the
RivetOS MCP server — for exercising the data-plane tool surface end-to-end
on a developer's laptop. No agent runtime, no providers, no channels — just
the wire surface claude-cli will eventually reach into.

## What's in the box

| Service | Image | Port | Purpose |
|---|---|---|---|
| `datahub` | `pgvector/pgvector:pg16` | `5433 → 5432` | Upstream Postgres 16 + pgvector + pg_trgm. The full `ros_*` schema is bootstrapped on first volume init by mounting `plugins/memory/postgres/src/schema/migrations/` into `/docker-entrypoint-initdb.d/`. |
| `mcp-server` | `rivetos-mcp-server:dev` | `5700` | StreamableHTTP MCP server (`@rivetos/mcp-server`) wired with `rivetos.echo`, `rivetos.memory_search`, `rivetos.memory_browse`, `rivetos.memory_stats`, `rivetos.internet_search`, `rivetos.web_fetch`. |

## Quick start

From the repo root:

```bash
docker compose -f infra/docker/mcp-stack/docker-compose.yml up --build
```

Liveness probe:

```bash
curl http://localhost:5700/health/live
# → {"status":"ok","name":"@rivetos/mcp-server","version":"0.4.0-beta.5"}
```

Talk to the MCP server with the official inspector:

```bash
npx @modelcontextprotocol/inspector http://localhost:5700/mcp
```

Or hit it from a Node script:

```js
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const client = new Client({ name: 'mcp-stack-smoke', version: '0.0.0' })
await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost:5700/mcp')))

console.log((await client.listTools()).tools.map((t) => t.name))

const stats = await client.callTool({ name: 'rivetos.memory_stats', arguments: {} })
console.log(stats.content[0].text)
```

The database starts empty (no messages, no summaries, no conversations) but
the schema is fully present — `memory_stats` will report 0 rows on the
ros_* tables, and `memory_search` / `memory_browse` will return "No results"
rather than crashing on a missing relation.

## Tear down

```bash
docker compose -f infra/docker/mcp-stack/docker-compose.yml down
```

To wipe the database volume too:

```bash
docker compose -f infra/docker/mcp-stack/docker-compose.yml down -v
```

## Optional configuration

| Env var | Default | Effect |
|---|---|---|
| `RIVETOS_EMBED_URL` | _(unset)_ | Hybrid (vector + FTS) memory search instead of FTS-only. |
| `RIVETOS_EMBED_MODEL` | `nemotron` | Embedding model name. |
| `GOOGLE_CSE_API_KEY` + `GOOGLE_CSE_ID` | _(unset)_ | Switches `rivetos.internet_search` from DuckDuckGo fallback to Google Custom Search. |
| `RIVETOS_USER_AGENT` | `RivetOS/<ver> (+https://github.com/philbert440/rivetOS)` | Override for `rivetos.web_fetch`. |

Set them under `services.mcp-server.environment` in `docker-compose.yml`.

## Connecting from Postgres clients

The datahub maps host port **5433** to container 5432 to avoid colliding
with a system Postgres on the developer's laptop:

```bash
psql 'postgres://rivetos:rivetos@localhost:5433/rivetos'
```

## Schema

The migrations under `plugins/memory/postgres/src/schema/migrations/` run
once on first volume init via Postgres' `/docker-entrypoint-initdb.d/`
hook, and create:

- Extensions: `vector`, `pg_trgm`
- Tables: `ros_conversations`, `ros_messages`, `ros_summaries`,
  `ros_summary_sources`, `ros_tool_synth_queue`, `ros_embedding_queue`,
  `ros_compaction_queue`
- Indexes: full-text + trigram on messages/summaries, btree for hot paths
- Trigger functions: `notify_embedding_queue`, `check_compaction_threshold`,
  `enqueue_idle_sessions`
- Triggers: embedding + compaction enqueue on insert

All `CREATE` statements are `IF NOT EXISTS`, so re-running the migrations
on an existing database is a no-op. For schema upgrades on an existing
volume, drop the volume (`down -v`) and re-up, or run the unified stack's
`rivetos --role migrate` runner.

## What's next

- **Slice 1.A.6** — `skill_list` / `skill_manage` data-plane tools.
- **Slice 1.A.7** — mTLS via `rivet-ca`, `rivetos/session.attach` handshake.
- **Slice 1.B** — runtime-RPC channel for proxied `delegate_task`,
  `subagent_*`, `shell`, `file_*`.
- **Slice 1.C** — `claude-cli` MCP bridge.
