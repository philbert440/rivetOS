# `@rivetos/memory-sqlite`

SQLite implementation of the RivetOS `Memory` contract. Opt-in via:

```yaml
memory:
  sqlite:
    path: ~/.rivetos/memory.sqlite
```

Phase 1: WAL file store, append + session/task history, FTS5 search. Vectors,
compaction, wiki, and multi-user routing are later phases.

Uses Node's built-in `node:sqlite` (`DatabaseSync`). No native addons.
