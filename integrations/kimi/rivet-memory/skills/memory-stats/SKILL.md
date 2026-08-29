---
name: memory-stats
description: 'Quickly check the health and coverage of the RivetOS memory store. Use when the user asks about memory status, how much history exists, compaction state, or "is memory working?"'
tags: [rivetos, memory]
version: 0.1.0
---

# Memory Stats

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


Call the `memory_stats` (or `rivetos__memory_stats`) tool from the RivetOS MCP server.

This gives a high-level view of:

- Alerts first: stuck graphile jobs, orphan summaries, embedding/compaction backlog
- Number of conversations and messages
- Coverage by agent (`rivet-claude`, `rivet-hermes`, `rivet-grok`, `rivet-kimi`, etc.)
- Compaction / summarization status
- Any obvious gaps

Read the alert sections before the per-agent census. Those now render first so
truncated MCP payloads still surface silent rot.

Useful as a diagnostic before a big recall session or when debugging why memory searches are returning thin results.
