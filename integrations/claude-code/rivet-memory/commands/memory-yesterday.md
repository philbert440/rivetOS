---
description: Browse RivetOS memory for everything from yesterday in the user's local timezone (optional topic filter)
argument-hint: [optional topic]
---

Call `memory_browse` with `since` = **yesterday at 00:00 in the user's local
timezone, converted to UTC**, and `before` = **today at 00:00 in the user's
local timezone, converted to UTC**.

The DB stores `created_at` in UTC. Do NOT pass raw `<yesterday>T00:00:00Z` and
`<today>T00:00:00Z` — those are UTC midnights, which for any US local
timezone slide the whole window into the wrong day. Compute local-yesterday
00:00 and local-today 00:00, then convert both to UTC (subtract the local
offset, accounting for DST). If you don't know the user's timezone, assume
system local. `currentDate` is a date string with no timezone — don't treat
it as a timestamp.

If `$ARGUMENTS` is non-empty, filter the returned entries to those that
reference the topic — browse first, narrow second. Do not use
`memory_search`.

Return a chronological summary of yesterday's work: prompts, key tool calls,
decisions, files touched. One short bullet per entry, grouped by
conversation.

If browse returns empty, say "no memory entries for yesterday" — don't fall
back to `memory_search`.
