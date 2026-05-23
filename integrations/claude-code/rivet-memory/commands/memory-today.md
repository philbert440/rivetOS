---
description: Browse RivetOS memory for everything from today in the user's local timezone (optional topic filter)
argument-hint: [optional topic]
---

Call `memory_browse` with `since` set to **today at 00:00 in the user's local
timezone, converted to UTC**, and `before` unset (defaults to now).

The DB stores `created_at` in UTC. Do NOT pass `<today>T00:00:00Z` — that's
UTC midnight, which for any US local timezone is yesterday afternoon/evening.
Compute local-today 00:00, then convert to UTC (subtract the local offset,
accounting for DST). If you don't know the user's timezone, assume system
local. `currentDate` in the conversation context is a date string with no
timezone — don't treat it as a timestamp.

If `$ARGUMENTS` is non-empty, after the browse returns, filter the result set
to entries whose content references the topic — do NOT pass the topic as a
search query; browse first, narrow second.

Return a chronological summary of what happened today: prompts, key tool
calls, decisions made, files touched. One short bullet per memory entry,
grouped by conversation if there were multiple.

If browse returns empty, say "no memory entries for today" — don't fall back
to `memory_search`.
