---
name: memory-recall
description: 'Auto-activate on any question about past work, decisions, commands, facts, or current status ("what did we do this morning/yesterday/today", "how\'s everything looking", "what\'s in flight", "remember when", "have we seen this error before", "what is the IP of X"). Encodes RivetOS recall discipline: status/workboard protocol, time-bounded browse first, multi-angle search + trigram fallback, cross-agent awareness.'
tags: [rivetos, memory, recall, discipline, rivet-memory, status]
version: 0.3.0
---

# RivetOS Memory Recall Discipline (Grok Build)

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


Persistent memory shared across every Rivet agent serving the same user
(`rivet-claude`, `rivet-hermes`, `grok`, etc.) via the RivetOS MCP server —
per-user, never across users (Step 0).

**Usual failure mode is poor discipline** — wrong tool, wrong evidence layer, or a browse flooded by tool rows.

## The Core Rules

### 0. Status / "how's things" question? → Workboard first (not host health)

Prompts like "how's everything looking", "what's going on", "status", "what's in flight", "catch me up" mean **current work across agents**, not memory_stats or box uptime.

1. `memory_browse(window="last_24h")` (default already excludes tool rows) — read **user + assistant closers** from all agents.
2. If thin, widen (`today` / `yesterday`) or `memory_search` for the live thread (PR numbers, "merged", "blocked", "hands off").
3. Treat `workspace/memory/*.md` and HEARTBEAT dated notes as **hints to verify**, never as current state. RivetOS conversation memory (and session-state / wiki when present) wins.
4. Host/`memory_stats` only as a secondary note when relevant — never the lead answer.

### 1. Time-bounded question? → `memory_browse` with `window=` FIRST

Any prompt that pins a timeframe ("this morning", "yesterday", "today", "earlier", "last week", "the standup") needs chronological results, not relevance rank.

Use `window=` when available:

- `window="this_morning" | "yesterday" | "today" | "this_week" | "last_24h" | "last_7d" | "last_14d"`

Prefer rolling `last_7d` / `last_14d` over `this_week` early in the week. Fallback: full UTC ISO `since` / `before` (never bare dates).

After a browse hits the limit, raise `limit` (max 200) or flip `order` — do not assume you have everything.

**Default browse excludes `role=tool`.** Limit budget goes to user/assistant/system. Pass `include_tools=true` only when debugging capture, harness wiring, or tool failures.

### 2. Topic / lookup question (no clear timeframe)? → Multi-angle search, minimum 3 queries

Vary by service/role, host/nickname, network, and exact tokens. Use `mode="trigram"` for IPs, MACs, error strings, hostnames. FTS OR/phrases when supported.

### 3. Semantic/FTS returns thin? Immediately retry with `mode="trigram"`

### 4. "No results" / user pushback → change strategy, do not give up

Widen window, add angles/trigram, check other agents. Only then go external.

## Decision Flow

```
User asks about past / status / "remember" / facts
          │
          ▼
Status / how's things / in flight?
   YES → workboard browse (rule 0)
   NO
          │
          ▼
Mentions clear timeframe?
   YES                     NO
    │                       │
    ▼                       ▼
memory_browse          3× memory_search
(window= preferred)    (different angles)
    │                       │
    ▼                       ▼
Still thin?             Thin results?
Widen / raise limit    Retry trigram + FTS
```

## Grok Build Tool Usage

1. `search_tool` to discover qualified names (`rivetos__memory_browse`, etc.).
2. Time-bounded → `window=` on browse.
3. Status → rule 0 before `memory_stats`.

## Cross-Agent Reality

Hits from `rivet-claude` / `rivet-hermes` / `grok` are equally valid. Filter by `agent` only when the user wants one lineage.

## Why This Exists

2026-05-23 WAP-DHCP: keyword search returned nothing; `memory_browse` over the morning window recovered the full incident. 2026-08-25 status miss: `memory_stats` + stale `memory/*.md` buried a live Claude workboard (#545 merged, on-device validation).

## Related

- `memory-today` / `memory-yesterday` — thin wrappers around rule 1 with the matching window.
- `memory_stats` — coverage/health diagnostics, not a status briefing.
- Pre-compaction Hermes captures are high-value for long sessions.
