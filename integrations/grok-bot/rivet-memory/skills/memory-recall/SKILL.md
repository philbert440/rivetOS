---
name: memory-recall
description: RivetOS memory discipline for Cursor Grok Bot. Browse with window first, then search. Writes use memory_append tagged source=grokbot.
tags: [rivetos, memory, recall, grokbot]
version: 0.1.0
---

# RivetOS Memory Recall (Grok Bot)

Query: status/how's-things uses memory_browse window=last_24h (workboard; not memory_stats). Time-bounded uses memory_browse with window=. Topic uses multi-angle memory_search. Browse excludes tool rows by default (include_tools=true to opt in).
Write: memory_append or memory_ingest_session with session_id, persona (when relevant). Agent defaults to rivet-grokbot from launcher; source unset.
Do not point Grok Build at this integration.
