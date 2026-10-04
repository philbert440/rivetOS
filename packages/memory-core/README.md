# @rivetos/memory-core

The backend-neutral half of the RivetOS memory system. Pure TypeScript: no
database, no network, no filesystem.

- **Scoring** — temporal decay, role importance, the weighted relevance
  formula and Reciprocal Rank Fusion.
- **Fusion policy** — candidate pool depth, when the literal arm joins a
  hybrid search, the summary bonus and the relevance gate.
- **Compaction** — leaf / branch / root system prompts, prompt formatters,
  token budgets and the pipeline version.
- **Wiki** — extraction and recompile prompts and patch parsing.

`@rivetos/memory-postgres` imports from here and re-exports everything it
exported before, so existing imports keep working. The SQLite backend will use
the same package as it gains search fusion, summaries and wiki, so both
backends rank, summarize and extract the same way.
