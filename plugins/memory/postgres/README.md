# @rivetos/memory-postgres

RivetOS Memory System — persistent transcript storage with hybrid-scored search, background compaction, and a summary DAG.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  @rivetos/types   →   Memory interface (pure contract)  │
├─────────────────────────────────────────────────────────┤
│  scoring.ts       →   Pure domain: relevance formulas   │
│                        No I/O, no dependencies          │
├─────────────────────────────────────────────────────────┤
│  adapter.ts       →   PostgresMemory (implements Memory)│
│  search.ts        →   SearchEngine (hybrid scoring)     │
│  expand.ts        →   Expander (summary DAG traversal)  │
│  tools.ts         →   Agent tools (memory_grep, etc.)   │
├─────────────────────────────────────────────────────────┤
│  embedder.ts      →   Background: Nemotron embeddings   │
│  compactor.ts     →   Background: Rivet Local summaries │
├─────────────────────────────────────────────────────────┤
│  migrate.ts       →   One-shot: LCM → ros_* migration   │
└─────────────────────────────────────────────────────────┘
```

### Layer Boundaries

- **scoring.ts** — Pure functions, zero imports beyond constants. Defines the relevance formula and exports SQL fragments for database-side evaluation. You can unit test this without a database.
- **adapter.ts** — The `PostgresMemory` class implements `Memory` from `@rivetos/types`. This is the composition root: it owns the pool and instantiates `SearchEngine` and `Expander` internally.
- **search.ts / expand.ts** — Data-access engines. They take a `pg.Pool` and execute queries. They use scoring constants from `scoring.ts` but never call LLMs or external services.
- **tools.ts** — Thin tool wrappers around `SearchEngine` and `Expander`. Each tool implements the `Tool` interface from `@rivetos/types`. The `memory_expand_query` tool calls an LLM endpoint.
- **embedder.ts / compactor.ts** — Background services on timers. They own their own pools (small, max 2 connections) and run independently of the message pipeline.

## Tables (ros_* prefix)

| Table | Purpose |
|-------|---------|
| `ros_conversations` | Sessions grouped by agent + channel + session_key |
| `ros_messages` | Immutable transcript — every message with tool data |
| `ros_summaries` | Compacted summaries forming a DAG (parent_id) |
| `ros_summary_sources` | Links summaries to their source messages |

## Scoring Formula

```
relevance = (fts_rank × 0.3) + (semantic × 0.3) + (temporal × 0.3) + (importance × 0.1)

temporal = e^(-0.05 × days_since_access) × (1 + 0.02 × access_count)
```

Access tracking: when a message or summary is returned in search results, its `access_count` is incremented and `last_accessed_at` updated. Frequently-accessed memories decay slower.

## Agent Tools

| Tool | Description |
|------|-------------|
| `memory_grep` | Search across messages and summaries (FTS, trigram, regex) |
| `memory_expand` | Drill into a summary → children + source messages |
| `memory_describe` | Metadata for a single summary node |
| `memory_expand_query` | Ask a question answered from expanded memory context via Rivet Local |

## Config (in config.yaml)

```yaml
memory:
  postgres:
    connection_string: postgresql://user:pass@host:5432/phil_memory
    embed_endpoint: http://10.4.20.12:9401       # Nemotron embedding service
    compactor_endpoint: http://10.4.20.12:8000/v1 # Rivet Local for summarization
    compactor_model: rivet-v0.1
```

## Migration from LCM

```bash
npx tsx plugins/memory/postgres/src/migrate.ts
```

Migrates conversations, messages (with tool data from message_parts), summaries (with parent relationships), and summary_sources. Preserves existing embeddings. Prints counts before and after.

## Writing Your Own Memory Backend

1. Implement the `Memory` interface from `@rivetos/types`
2. Create search and expand engines for your storage layer
3. Use `createMemoryTools()` to wrap them as agent tools
4. Register via `runtime.registerMemory()` and `runtime.registerTool()` in boot.ts

The `scoring.ts` module is reusable — its pure functions work regardless of storage backend.
