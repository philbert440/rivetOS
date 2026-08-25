---
name: memory-today
description: 'Quick recall of everything from today (local time). Use when user says "what happened today", "anything today about X", "show me today\'s work", or similar time-bounded requests for the current day.'
tags: [rivetos, memory, recall]
version: 0.2.0
---

# Memory Today

Wrapper around `memory-recall` rule 1 for the current local day.

1. `search_tool` → discover `memory_browse` / `rivetos__memory_browse`.
2. `memory_browse(window="today")` — default already excludes tool rows; raise `limit` or flip `order` if you hit the cap. Pass `include_tools=true` only when debugging tools/capture.
3. Prefer user/assistant closers across agents. Do not lead with `workspace/memory/*.md`.
4. If the user names a topic, follow with `memory_search` or an agent filter.

For "how's everything" / "what's in flight" (no explicit "today"), use `memory-recall` rule 0 (`last_24h` workboard), not this skill alone.
