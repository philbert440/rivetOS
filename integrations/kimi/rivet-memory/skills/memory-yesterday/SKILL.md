---
name: memory-yesterday
description: 'Quick recall of everything from yesterday (local time). Use on "what did we do yesterday", "yesterday\'s changes", "check yesterday for X", etc.'
tags: [rivetos, memory, recall]
version: 0.1.1
---

# Memory Yesterday

Immediately call the RivetOS memory tools with a "yesterday" window.

1. Discover tools (`memory_browse` or qualified MCP name).
2. Call `memory_browse(window="yesterday")` — tools excluded by default; `include_tools=true` only for tool/capture debugging.
3. Prefer user/assistant closers; follow up with targeted search if a topic is mentioned.

Companion to `memory-today` and the full `memory-recall` discipline.
