---
name: memory-yesterday
description: 'Quick recall of everything from yesterday (local time). Use on "what did we do yesterday", "yesterday\'s changes", "check yesterday for X", etc.'
tags: [rivetos, memory, recall]
version: 0.2.0
---

# Memory Yesterday

Wrapper around `memory-recall` rule 1 for yesterday's local day.

1. `search_tool` → discover `memory_browse` / `rivetos__memory_browse`.
2. `memory_browse(window="yesterday")` — tools excluded by default; `include_tools=true` only for tool/capture debugging.
3. Prefer user/assistant closers across agents; treat dated workspace notes as hints only.

Companion to `memory-today` and full `memory-recall`.
