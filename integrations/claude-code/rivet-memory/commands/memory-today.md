---
description: Browse RivetOS memory for everything from today (optional topic filter)
argument-hint: [optional topic]
---

Call `memory_browse` with `since` set to today at 00:00 UTC and `before`
unset (defaults to now). If `$ARGUMENTS` is non-empty, after the browse
returns, filter the result set to entries whose content references the
topic — do NOT pass the topic as a search query; browse first, narrow
second.

Today's date is in the conversation context as `currentDate`. Use that.

Return a chronological summary of what happened today: prompts, key tool
calls, decisions made, files touched. One short bullet per memory entry,
grouped by conversation if there were multiple.

If browse returns empty, say "no memory entries for today" — don't fall
back to `memory_search`.
