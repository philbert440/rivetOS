---
name: memory-today
description: 'Quick recall of everything from today (local time). Use when user says "what happened today", "anything today about X", "show me today\'s work", or similar time-bounded requests for the current day.'
tags: [rivetos, memory, recall]
version: 0.2.0
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


Wrapper around `memory-recall` rule 1 for the current local day.

1. `search_tool` → discover `memory_browse` / `rivetos__memory_browse`.
2. `memory_browse(window="today")` — default already excludes tool rows; raise `limit` or flip `order` if you hit the cap. Pass `include_tools=true` only when debugging tools/capture.
3. Prefer user/assistant closers across agents. Do not lead with `workspace/memory/*.md`.
4. If the user names a topic, follow with `memory_search` or an agent filter.

For "how's everything" / "what's in flight" (no explicit "today"), use `memory-recall` rule 0 (`last_24h` workboard), not this skill alone.
