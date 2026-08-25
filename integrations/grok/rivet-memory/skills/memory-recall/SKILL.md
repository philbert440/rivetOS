---
name: memory-recall
description: 'Auto-activate on any question about past work, decisions, commands, facts, or current status ("what did we do this morning/yesterday/today", "how\'s everything looking", "what\'s in flight", "remember when", "have we seen this error before", "what is the IP of X"). Encodes RivetOS recall discipline: status/workboard protocol, time-bounded browse first, multi-angle search + trigram fallback, cross-agent awareness.'
tags: [rivetos, memory, recall, discipline, rivet-memory, status]
version: 0.3.0
---

# RivetOS Memory Recall Discipline (Grok Build)

Shared persistent memory across every Rivet agent (`rivet-claude`, `rivet-hermes`, `grok`, etc.) via the RivetOS MCP server.

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
