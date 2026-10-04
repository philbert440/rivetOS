# `@rivetos/memory-sqlite`

SQLite implementation of the RivetOS `Memory` contract. Opt-in via:

```yaml
memory:
  sqlite:
    path: ~/.rivetos/memory.sqlite
```

WAL file store, append + session/task history, FTS5 + vector search.
Compaction, wiki, and multi-user routing are later phases.

Embeddings and hybrid search: set `embed_endpoint` + `embed_model` (or
`RIVETOS_EMBED_URL` / `RIVETOS_EMBED_MODEL`). An in-process job loop
(`ros_jobs`, `jobs.ts`) embeds messages in the background, vectors are stored
on the row as float32 BLOBs, and `search` fuses full-text, literal-match and
vector arms with the policy shared with Postgres (`@rivetos/memory-core`).
Vector search is an exact scan behind the `VectorIndex` interface — no native
extension. Without an endpoint search stays full-text and nothing is queued;
rows written meanwhile are embedded by a sweep once an endpoint is set.

Session tags: `memory.tags()` reads and writes `ros_tags` with the same
lifecycle as the Postgres backend (`add` is born accepted, `propose` writes
suggestions, `decide` accepts or rejects, a rejected tag is never
re-proposed, `forSessionKeys` resolves a session through its key aliases).
There is no HTTP or MCP surface for it here yet, no summary tags (SQLite has
no summaries), and the vocabulary table is not edited through it.

Uses Node's built-in `node:sqlite` (`DatabaseSync`). No native addons.
