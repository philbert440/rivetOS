---
description: Show RivetOS memory system health — message/summary counts, embedding queue, compaction backlog, stuck graphile jobs, freshness
---

Call `memory_stats` and present its output to the user.

The tool returns a pre-formatted markdown payload covering:

- **Messages** — total count + date range, with breakdowns by agent and by role
- **Conversations** — total + active count
- **Summaries** — counts by kind, max tree depth (warns if zero — compactor may not be running)
- **Embedding queue** — messages and summaries awaiting embedding, with caught-up / pending / backlog status
- **Embedding coverage** — % of messages and summaries that have embeddings
- **Unsummarized messages** — bucketed by compactor eligibility: `eligible` (will be picked next pass), `active_tail` (still-active conversation, will flush when idle), `below_floor` (under MIN_BATCH_SIZE, won't compact by design). The actionable bucket is `eligible` — that's where the ⚠️ flag fires
- **Top conversations eligible for compaction** — up to 5, oldest-first (matches the worker's enqueue order), with agent, unsummarized count, trigger reason, short conv id
- **Stuck queue jobs** — graphile-worker jobs at `attempts >= max_attempts` (i.e. dead, won't retry), grouped by task identifier, with oldest-failure timestamp and a sample error message
- **Orphan leaf summaries** — leaf summaries with no source-message links (data integrity issue)
- **Summary tree** — max depth, root vs child counts
- **Freshness** — time since newest message and newest summary

The payload is already formatted with ⚠️ / ⏳ / ✅ status markers. Pass it
through largely as-is. If the user asked a specific question
("is the compactor healthy?"), call out the relevant section in one
sentence at the top.
