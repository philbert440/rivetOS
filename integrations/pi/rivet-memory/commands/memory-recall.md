# /memory-recall

Quickly invoke the full RivetOS memory recall discipline.

**Usage:**
```
/memory-recall what did we do about the WAP last week
/memory-recall check memory for the minipc IP
```

This activates (or reinforces) the `memory-recall` skill with the optimal search strategy for the query.

**Behavior:**
- Detects whether the question is time-bounded
- Prefers `memory_browse` with `window=` (or date range) when appropriate
- Runs multi-angle searches + trigram fallback for topic queries
- Synthesizes results across agents when relevant
