# MEMORY.md -- where answers live (Cursor)

One spine per shelf. Pick the one that matches the question, query it, then act.

- **`memory_search`** -- semantic + lexical search over every past conversation; the default first move for "what did we decide / have we done X / why is Y like this".
- **`memory_browse`** -- chronological browse; for when you know roughly *when* something happened ("what did we do Tuesday").
- **`memory_stats`** -- health of the memory system itself; for "is capture/embedding working".
- **`memory_get_full`** -- expand a truncated search/browse row by UUID.
- **`wiki_search` / `wiki_read`** -- curated standing facts distilled from memory; for "what is currently true about X".
- **`/rivet-shared/wiki/topics/`** -- durable per-subject articles on disk.
- **`/rivet-shared/*.md` and project kits** -- proven runbooks, recipes, and build logs.
- **`/rivet-shared/plans/`** -- approved plans and session-state handoffs.
- **`users/profiles.json` and `users/<id>.md`** -- who a routed user is.
- **`config.yaml`** -- this node's own wiring (provider, mesh, den).

If two shelves disagree, memory wins over workspace files -- update the file.

## RivetOS recall tools

Discover qualified names from the connected `rivetos` MCP server
(`plugin-rivet-memory-rivetos` or host-local equivalents).

| Tool | Use |
| --- | --- |
| `memory_search` | Raw messages and summaries. Modes: `hybrid` (default), `fts`, `trigram`, `regex`, `vector`; scopes: `messages`, `summaries`, `both`. Supports agent/date/window filters. |
| `memory_browse` | Chronological messages by conversation, agent, or time window. `include_tools=true` includes tool traffic; `order=asc|desc`, maximum limit 200. |
| `memory_get_full` | Expand a row UUID returned in a truncation hint. |
| `memory_stats` | Capture freshness, counts, embeddings, queue jobs; optional agent filter. |
| `wiki_search` | Find curated standing facts by topic; returns slugs for `wiki_read`. |
| `wiki_read` | Read a topic slug and its history/provenance. |

### Decision flow

1. Status / "how's things" / in flight -> `memory_browse(window="last_24h")` first (workboard).
2. Time-bounded ("this morning", "yesterday") -> `memory_browse` with `window=` **first**, not `memory_search`.
3. Topic / lookup -> at least 3 angled `memory_search` calls; thin results -> `mode="trigram"`.
4. Standing facts -> `wiki_search` then `wiki_read`.

Time windows (`today`, `yesterday`, `this_morning`, `this_week`, `last_24h`,
`last_7d`, `last_14d`) use the server timezone. Do not mistake an empty search
for proof something never happened.

`memory_append` / `memory_ingest_session` are write tools (enabled when the
Cursor launcher sets `RIVETOS_MCP_ENABLE_MEMORY_WRITE=1`). Full discipline:
`memory-recall` skill.
