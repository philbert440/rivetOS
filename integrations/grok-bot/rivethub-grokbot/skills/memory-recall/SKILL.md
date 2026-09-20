---
name: rivethub-memory-recall
description: >-
  Use when recalling or writing RivetOS shared memory from Grok Bot. Browse with
  a window first, then search. Writes use memory_append tagged source=grokbot.
---
# RivetHub memory (Grok Bot)

Same Postgres store every Rivet mesh agent shares.

## Recall
1. `memory_browse` or `memory_stats` for recent context
2. `memory_search` with a concrete query (default scope `messages`; embeddings can time out)
3. Prefer agent/session tags when known (`rivet-grokbot`, …)

## Write
- `memory_append` — always pass `role` (`user`|`assistant`|`system`|`tool`)
- Pass `persona` when relevant; leave `source` unset so the launcher stamps `grokbot`
- `memory_ingest_session` for bulk session jsonl

Do not use the Grok Build memory launcher from Grok Bot.
