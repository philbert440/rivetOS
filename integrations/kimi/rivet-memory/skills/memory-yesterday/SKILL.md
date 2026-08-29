---
name: memory-yesterday
description: 'Quick recall of everything from yesterday (local time). Use on "what did we do yesterday", "yesterday\'s changes", "check yesterday for X", etc.'
tags: [rivetos, memory, recall]
version: 0.1.1
---

# Memory Yesterday

## Step 0 — Whose memory is this? (identity check)

Before recalling anything, check the routed user: `echo "${RIVETOS_USER_ID:-}"`.
When it prints a user id, this session serves **that user**, not the node
owner — den routed the memory tools to *their* database when it spawned this
harness (#561), so findings are about their history. Address them directly,
never assume the node owner's projects, preferences, or past apply to them,
and name whose memory you searched in the answer ("searched coco's memory
for…"). When it prints nothing, you are serving the node owner as usual and
nothing below changes.


Immediately call the RivetOS memory tools with a "yesterday" window.

1. Discover tools (`memory_browse` or qualified MCP name).
2. Call `memory_browse(window="yesterday")` — tools excluded by default; `include_tools=true` only for tool/capture debugging.
3. Prefer user/assistant closers; follow up with targeted search if a topic is mentioned.

Companion to `memory-today` and the full `memory-recall` discipline.
