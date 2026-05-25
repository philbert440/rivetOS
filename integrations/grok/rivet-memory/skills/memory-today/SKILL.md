---
name: memory-today
description: 'Quick recall of everything from today (local time). Use when user says "what happened today", "anything today about X", "show me today\'s work", or similar time-bounded requests for the current day.'
tags: [rivetos, memory, recall]
version: 0.1.0
---

# Memory Today

Immediately call the RivetOS memory tools with a "today" window.

1. Discover the exact tool names via `search_tool` (look for `memory_browse` or `rivetos__memory_browse`).
2. Call with `window="today"` (preferred) or an explicit `since` for local midnight → now in UTC.
3. If the user mentions a topic, run a follow-up `memory_search` or add a filter after the initial browse.

This is a convenience wrapper around the full `memory-recall` discipline focused on the current day.
