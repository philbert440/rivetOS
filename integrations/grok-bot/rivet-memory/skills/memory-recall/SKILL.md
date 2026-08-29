---
name: memory-recall
description: RivetOS memory discipline for Cursor Grok Bot. Browse with window first, then search. Writes use memory_append tagged source=grokbot.
tags: [rivetos, memory, recall, grokbot]
version: 0.1.0
---

# RivetOS Memory Recall (Grok Bot)

## Step 0 — Whose memory is this? (identity check)

Before recalling anything, check the routed user: `echo "${RIVETOS_USER_ID:-}"`.
When it prints a user id, this session serves **that user**, not the node
owner — den routed the memory tools to *their* database when it spawned this
harness (#561), so findings are about their history. Address them directly,
never assume the node owner's projects, preferences, or past apply to them,
and name whose memory you searched in the answer ("searched coco's memory
for…"). When it prints nothing, you are serving the node owner as usual and
nothing below changes.


Query: status/how's-things uses memory_browse window=last_24h (workboard; not memory_stats). Time-bounded uses memory_browse with window=. Topic uses multi-angle memory_search. Browse excludes tool rows by default (include_tools=true to opt in).
Write: memory_append or memory_ingest_session with session_id, persona (when relevant). Agent defaults to rivet-grokbot from launcher; source unset.
Do not point Grok Build at this integration.
