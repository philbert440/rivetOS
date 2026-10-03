# `@rivetos/memory-sqlite`

SQLite implementation of the RivetOS `Memory` contract. Opt-in via:

```yaml
memory:
  sqlite:
    path: ~/.rivetos/memory.sqlite
```

Phase 1: WAL file store, append + session/task history, FTS5 search. Vectors,
compaction, wiki, and multi-user routing are later phases.

Session tags: `memory.tags()` reads and writes `ros_tags` with the same
lifecycle as the Postgres backend (`add` is born accepted, `propose` writes
suggestions, `decide` accepts or rejects, a rejected tag is never
re-proposed, `forSessionKeys` resolves a session through its key aliases).
There is no HTTP or MCP surface for it here yet, no summary tags (SQLite has
no summaries), and the vocabulary table is not edited through it.

Uses Node's built-in `node:sqlite` (`DatabaseSync`). No native addons.
