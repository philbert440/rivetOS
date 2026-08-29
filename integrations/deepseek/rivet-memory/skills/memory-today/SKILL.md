---
name: memory-today
description: 'Quick recall of everything from today (local time). Use when user says "what happened today", "anything today about X", "show me today\'s work", or similar time-bounded requests for the current day.'
tags: [rivetos, memory, recall]
version: 0.1.0
---

# Memory Today

## Step 0 — Whose memory is this? (identity check)

Before recalling anything, check the routed user: `echo "${RIVETOS_USER_ID:-}"`.
When it prints a user id, this session serves **that user**, not the node
owner — den routed the memory tools to *their* database when it spawned this
harness (#561), so findings are about their history. Address them directly,
never assume the node owner's projects, preferences, or past apply to them,
and name whose memory you searched in the answer ("searched coco's memory
for…"). When it prints nothing, you are serving the node owner as usual and
nothing below changes.


Immediately call the RivetOS memory tools with a "today" window.

1. Discover the exact tool names (`memory_browse` / `rivetos__memory_browse` or however dsh qualifies MCP tools).
2. Call with `window="today"` (preferred) or an explicit `since` for local midnight → now in UTC.
3. If the user mentions a topic, run a follow-up `memory_search` or add a filter after the initial browse.

This is a convenience wrapper around the full `memory-recall` discipline focused on the current day.
