---
description: Show RivetOS memory system health — backlog, embedding coverage, compaction candidates, stuck jobs
---

Call `memory_stats` and pretty-print the result.

Report:

- **Totals** — total memories, total conversations, total messages.
- **Embedding coverage** — how many memories have embeddings vs. how many
  are pending. Flag if the pending backlog is > 100 or growing.
- **Top compaction candidates** — the top 5 conversations by message count
  that haven't been compacted yet. Show conversation ID and message count.
- **Queue health** — any stuck embedder / compactor jobs (jobs older than
  1 hour in `processing` state). Flag explicitly if found.

Finish with one line on overall health: "healthy", "backlog growing",
or "needs attention" with a one-sentence reason.
