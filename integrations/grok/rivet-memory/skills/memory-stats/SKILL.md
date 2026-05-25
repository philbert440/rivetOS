---
name: memory-stats
description: 'Quickly check the health and coverage of the RivetOS memory store. Use when the user asks about memory status, how much history exists, compaction state, or "is memory working?"'
tags: [rivetos, memory]
version: 0.1.0
---

# Memory Stats

Call the `memory_stats` (or `rivetos__memory_stats`) tool from the RivetOS MCP server.

This gives a high-level view of:
- Number of conversations and messages
- Coverage by agent (`rivet-claude`, `rivet-hermes`, `grok`, etc.)
- Compaction / summarization status
- Any obvious gaps

Useful as a diagnostic before a big recall session or when debugging why memory searches are returning thin results.
