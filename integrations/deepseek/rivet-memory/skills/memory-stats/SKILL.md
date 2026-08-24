---
name: memory-stats
description: 'Quickly check the health and coverage of the RivetOS memory store. Use when the user asks about memory status, how much history exists, compaction state, or "is memory working?"'
tags: [rivetos, memory]
version: 0.1.0
---

# Memory Stats

Call the `memory_stats` (or `rivetos__memory_stats`) tool from the RivetOS MCP server.

This gives a high-level view of:

- Alerts first: stuck graphile jobs, orphan summaries, embedding/compaction backlog
- Number of conversations and messages
- Coverage by agent (`rivet-claude`, `rivet-hermes`, `rivet-grok`, `rivet-kimi`, `rivet-deepseek`, etc.)
- Compaction / summarization status
- Any obvious gaps

Read the alert sections before the per-agent census. Those now render first so
truncated MCP payloads still surface silent rot.

Useful as a diagnostic before a big recall session or when debugging why memory searches are returning thin results.
