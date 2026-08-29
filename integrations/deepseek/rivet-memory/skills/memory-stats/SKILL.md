---
name: memory-stats
description: 'Quickly check the health and coverage of the RivetOS memory store. Use when the user asks about memory status, how much history exists, compaction state, or "is memory working?"'
tags: [rivetos, memory]
version: 0.1.0
---

# Memory Stats

## Step 0 — Whose memory is this? (identity check)

Before recalling anything, check the routed user: `echo "${RIVETOS_USER_ID:-}"`.
When it prints a user id, this session serves **that user**, not the node
owner — den routed the memory tools to *their* database when it spawned this
harness (#561), so findings are about their history. Address them directly,
never assume the node owner's projects, preferences, or past apply to them,
and name whose memory you searched in the answer ("searched coco's memory
for…"). When it prints nothing, you are serving the node owner as usual and
nothing below changes.


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
