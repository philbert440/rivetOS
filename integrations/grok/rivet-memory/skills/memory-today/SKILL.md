---
name: memory-today
description: 'Quick recall of everything from today (local time). Use when user says "what happened today", "anything today about X", "show me today\'s work", or similar time-bounded requests for the current day.'
tags: [rivetos, memory, recall]
version: 0.2.0
---

# Memory Today

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


Wrapper around `memory-recall` rule 1 for the current local day.

1. `search_tool` → discover `memory_browse` / `rivetos__memory_browse`.
2. `memory_browse(window="today")` — default already excludes tool rows; raise `limit` or flip `order` if you hit the cap. Pass `include_tools=true` only when debugging tools/capture.
3. Prefer user/assistant closers across agents. Do not lead with `workspace/memory/*.md`.
4. If the user names a topic, follow with `memory_search` or an agent filter.

For "how's everything" / "what's in flight" (no explicit "today"), use `memory-recall` rule 0 (`last_24h` workboard), not this skill alone.
