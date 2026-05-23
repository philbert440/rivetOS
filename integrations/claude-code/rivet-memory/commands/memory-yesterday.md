---
description: Browse RivetOS memory for everything from yesterday (optional topic filter)
argument-hint: [optional topic]
---

Call `memory_browse` with `since` = yesterday at 00:00 UTC and `before` =
today at 00:00 UTC. If `$ARGUMENTS` is non-empty, filter the returned
entries to those that reference the topic — browse first, narrow second.
Do not use `memory_search`.

Today's date is in the conversation context as `currentDate`. Compute
yesterday from that.

Return a chronological summary of yesterday's work: prompts, key tool
calls, decisions, files touched. One short bullet per entry, grouped by
conversation.

If browse returns empty, say "no memory entries for yesterday" — don't
fall back to `memory_search`.
