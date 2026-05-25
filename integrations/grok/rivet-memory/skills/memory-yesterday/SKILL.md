---
name: memory-yesterday
description: 'Quick recall of everything from yesterday (local time). Use on "what did we do yesterday", "yesterday\'s changes", "check yesterday for X", etc.'
tags: [rivetos, memory, recall]
version: 0.1.0
---

# Memory Yesterday

Immediately call the RivetOS memory tools with a "yesterday" window.

1. Discover tools via `search_tool`.
2. Call `memory_browse(window="yesterday")` (or equivalent `since`/`before` for yesterday's local day in UTC).
3. Follow up with targeted search if a topic is mentioned.

Companion to `memory-today` and the full `memory-recall` discipline.
