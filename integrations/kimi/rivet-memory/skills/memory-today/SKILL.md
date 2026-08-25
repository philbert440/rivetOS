---
name: memory-today
description: 'Quick recall of everything from today (local time). Use when user says "what happened today", "anything today about X", "show me today\'s work", or similar time-bounded requests for the current day.'
tags: [rivetos, memory, recall]
version: 0.1.1
---

# Memory Today

Immediately call the RivetOS memory tools with a "today" window.

1. Discover the exact tool names (`memory_browse` / `rivetos__memory_browse` or however kimi-code qualifies MCP tools).
2. Call with `window="today"` — tools excluded by default; `include_tools=true` only for tool/capture debugging. Raise `limit` or flip `order` if you hit the cap.
3. Prefer user/assistant closers across agents; dated workspace notes are hints only.
4. If the user mentions a topic, run a follow-up `memory_search` or add a filter after the initial browse.

For "how's everything" / "what's in flight", use `memory-recall` rule 0 (`last_24h` workboard), not this skill alone.
