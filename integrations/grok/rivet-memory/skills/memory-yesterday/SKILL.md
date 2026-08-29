---
name: memory-yesterday
description: 'Quick recall of everything from yesterday (local time). Use on "what did we do yesterday", "yesterday\'s changes", "check yesterday for X", etc.'
tags: [rivetos, memory, recall]
version: 0.2.0
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


Wrapper around `memory-recall` rule 1 for yesterday's local day.

1. `search_tool` → discover `memory_browse` / `rivetos__memory_browse`.
2. `memory_browse(window="yesterday")` — tools excluded by default; `include_tools=true` only for tool/capture debugging.
3. Prefer user/assistant closers across agents; treat dated workspace notes as hints only.

Companion to `memory-today` and full `memory-recall`.
