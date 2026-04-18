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
│  tools.ts         →   Agent tools (memory_search, etc.) │
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
- **tools.ts** — Thin tool wrappers around `SearchEngine` and `Expander`. Each tool implements the `Tool` interface from `@rivetos/types`.
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
| `memory_search` | Unified search across messages and summaries. Auto-expands top summary hits to children/source messages. Supports FTS, trigram, and regex modes. Agent/date filters, optional LLM synthesis. |
| `memory_browse` | Chronological message browsing. For reviewing sessions and catching up on activity. |
| `memory_stats` | System health diagnostics. Embedding queue depth, unsummarized message counts, compaction status, summary tree depth, embedding coverage. |

## Config (in config.yaml)

```yaml
memory:
  postgres:
    connection_string: ${RIVETOS_PG_URL}
    embed_endpoint: http://192.168.1.50:9401       # Nemotron embedding service
    compactor_endpoint: http://192.168.1.50:8000/v1 # Rivet Local for summarization
    compactor_model: rivet-v0.1
```

## Migration from LCM

```bash
npx tsx plugins/memory/postgres/src/migrate.ts
```

Migrates conversations, messages (with tool data from message_parts), summaries (with parent relationships), and summary_sources. Preserves existing embeddings. Prints counts before and after.

## Embedding Backfill (after CHARS_PER_CHUNK fix)

Nemotron-8B has a 2048-token context window. The previous `CHARS_PER_CHUNK = 20_000` was too large for worst-case content (code/JSON ~3.5 chars/token), causing silent `null` responses from the embedding service. It is now `3_500`.

After deploying the fix:

```bash
# From repo root
npm run --workspace=@rivetos/memory-postgres backfill-embeddings
# or with flag:
npm run --workspace=@rivetos/memory-postgres backfill-embeddings -- --dry-run
```

The script:
- Clears stuck entries from `ros_embedding_queue` (`attempts >= 3`)
- Resets `embed_failures` on rows with `embedding IS NULL`
- Re-enqueues missing embeddings (batched, idempotent, with delay)
- Handles `ros_summaries` gracefully if columns are present
- Prints final counts and monitoring queries

### Monitoring
```sql
SELECT count(*) FROM ros_embedding_queue;
SELECT count(*) FROM ros_messages WHERE embedding IS NULL;
SELECT count(*) FROM ros_summaries WHERE embedding IS NULL;
```

## Writing Your Own Memory Backend

1. Implement the `Memory` interface from `@rivetos/types`
2. Create search and expand engines for your storage layer
3. Register via boot registrars (`boot/src/registrars/memory.ts`)

The `scoring.ts` module is reusable — its pure functions work regardless of storage backend.
