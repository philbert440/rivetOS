---
name: memory-yesterday
description: 'Quick recall of everything from yesterday (local time). Use on "what did we do yesterday", "yesterday\'s changes", "check yesterday for X", etc.'
tags: [rivetos, memory, recall]
version: 0.2.0
---

# Memory Yesterday

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


Wrapper around `memory-recall` rule 1 for yesterday's local day.

1. `search_tool` → discover `memory_browse` / `rivetos__memory_browse`.
2. `memory_browse(window="yesterday")` — tools excluded by default; `include_tools=true` only for tool/capture debugging.
3. Prefer user/assistant closers across agents; treat dated workspace notes as hints only.

Companion to `memory-today` and full `memory-recall`.
