---
description: Recall past work from RivetOS memory using the full discipline (browse-with-date-range, multi-angle search, trigram fallback)
argument-hint: [query]
---

Recall this from RivetOS memory: $ARGUMENTS

Apply the `memory-recall` skill discipline. In order:

1. If the query mentions a timeframe ("this morning", "yesterday", "today",
   "last week", "recently"), call `memory_browse` with the appropriate
   `since` / `before` date range FIRST — do not start with `memory_search`.
2. Otherwise, run **at least three** `memory_search` queries from different
   angles (service name, hostname, subnet, role). Vary the vocabulary.
3. If any query returns ≤ 2 hits, retry it with `mode: "trigram"` for
   literal-token matching.
4. Synthesize the findings into a concise answer with the source memory's
   timestamp and `originSessionId` where available, so I can verify or
   follow the thread.

If memory is genuinely empty across all angles, say so explicitly — don't
fall back to guessing or external probes without flagging it.
