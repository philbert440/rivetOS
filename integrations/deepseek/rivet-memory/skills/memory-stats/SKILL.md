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

Then resolve the owner id — one executable step, no reading USER.md:
`cat users/profiles.json 2>/dev/null` and take the reserved `"_owner"` key.

- **Env empty, or equal to that `_owner` value** → you are serving the
  **node owner**. Everything below applies unchanged — and when the env WAS
  set, still name whose memory you searched.
- **Any other id — or the env is set and `users/profiles.json` (or its
  `"_owner"` key) is absent** → treat the session as **routed** to that
  user. This is deliberately fail-safe: a missing map can make the owner's
  own session slightly more formal, but it can never lock anyone out or
  disclose the owner's context to a guest. In routed mode: the memory tools
  already hit *that user's* database (#561), so findings are their history.
  Address them directly; do not apply the owner's projects, preferences, or
  past to them; and the owner's USER.md / private workspace context is **not
  yours to disclose** to them. Resolve the id to a display name via
  `users/profiles.json` or `users/<id>.md` — if neither exists, use the raw
  id, never guess. Name whose memory you searched in every answer
  ("searched coco's memory for…").

The store your tools hit is shared by every Rivet agent **serving this same
user** — cross-agent recall stays first-class, per user, never across users.

**Delegating to `memory-researcher`? Bind the phrase to the branch** — owner
mode says exactly "node owner"; routed mode says exactly
"routed user: <name> (<id>)". Never phrase the owner as a routed user. The
researcher has no shell and cannot run this check; an unstated identity
forces it into neutral framing.


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
