---
name: memory-recall
description: RivetOS memory discipline for Cursor Grok Bot. Browse with window first, then search. Writes use memory_append tagged source=grokbot.
tags: [rivetos, memory, recall, grokbot]
version: 0.1.0
---

# RivetOS Memory Recall (Grok Bot)

Query: time-bounded uses memory_browse with window=. Topic uses multi-angle memory_search.
Write: memory_append or memory_ingest_session with session_id, agent, persona. Leave source unset.
Do not point Grok Build at this integration.
