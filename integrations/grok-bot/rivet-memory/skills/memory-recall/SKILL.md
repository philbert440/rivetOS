---
name: memory-recall
description: RivetOS memory discipline for Cursor Grok Bot. Browse with window first, then search. Writes use memory_append tagged source=grokbot.
tags: [rivetos, memory, recall, grokbot]
version: 0.1.0
---

# RivetOS Memory Recall (Grok Bot)

## Step 0 — Whose memory is this? (identity check)

Before recalling anything, check the routed user: `echo "${RIVETOS_USER_ID:-}"`.
One predicate, everywhere:

- **Empty, or equal to the node owner's id** (the owner is whoever USER.md
  describes; their id is in `users/profiles.json` when one exists) → you are
  serving the **node owner**. Everything below applies unchanged — and when
  the env WAS set, still name whose memory you searched.
- **Any other id** → den routed this session to **that user**: the memory
  tools already hit *their* database (#561), so findings are their history.
  Address them directly; do not apply the owner's projects, preferences, or
  past to them; and the owner's USER.md / private workspace context is **not
  yours to disclose** to them. Resolve the id to a name via
  `users/profiles.json` or `users/<id>.md` — if neither exists, use the raw
  id, never guess. Name whose memory you searched in every answer
  ("searched coco's memory for…").

The store your tools hit is shared by every Rivet agent **serving this same
user** — cross-agent recall stays first-class, per user, never across users.

**Delegating to `memory-researcher`? State the identity in the prompt** —
"routed user: <name> (<id>)" or "node owner" — every time. The researcher has
no shell and cannot run this check; an unstated identity forces it into
neutral framing.


Query: status/how's-things uses memory_browse window=last_24h (workboard; not memory_stats). Time-bounded uses memory_browse with window=. Topic uses multi-angle memory_search. Browse excludes tool rows by default (include_tools=true to opt in).
Write: memory_append or memory_ingest_session with session_id, persona (when relevant). Agent defaults to rivet-grokbot from launcher; source unset.
Do not point Grok Build at this integration.
