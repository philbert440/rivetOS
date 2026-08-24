---
name: memory-recall
description: 'Auto-activate on any question about past work, decisions, commands, or facts ("what did we do this morning/yesterday/today", "remember when", "have we seen this error before", "what is the IP of X", "where does Y live"). Encodes the optimal RivetOS memory recall discipline across all agents (rivet-claude, rivet-hermes, rivet-grok, rivet-kimi, rivet-deepseek). Prefers time-bounded browse with window= first, multi-angle search + trigram fallback, and cross-agent awareness.'
tags: [rivetos, memory, recall, discipline, rivet-memory]
version: 0.2.0
---

# RivetOS Memory Recall Discipline (DeepSeek Harness)

You have access to a shared, persistent memory store used by **every** Rivet agent
(`rivet-claude`, `rivet-hermes`, `rivet-grok`, `rivet-kimi`, `rivet-deepseek`, etc.)
via the RivetOS MCP server.

**The tools are excellent. The usual failure mode is poor discipline** — using semantic
search when a chronological browse of a known time window is the correct reflex.

This skill exists so you reach for the right tool on the first try.

## The Core Rules (Best of Hermes + Claude + Grok)

### 1. Time-bounded question? → `memory_browse` with `window=` FIRST

Any prompt that pins a timeframe ("this morning", "yesterday", "today", "earlier",
"last week", "the standup", "what we did on Tuesday") means the user already knows
*when*. They need exhaustive results in order, not relevance-ranked hits.

**Use the enhanced `window=` parameter whenever available**:

- `window="this_morning" | "yesterday" | "today" | "this_week" | "last_24h" | "last_7d" | "last_14d"`
  (prefer rolling `last_7d` over calendar `this_week` early in the week)

**Fallback**: Explicit `since` / `before` as full UTC ISO timestamps (never bare dates).

**Important**: After a browse that hits the limit, flip `order="asc"` or increase
`limit` (max usually 200) instead of assuming you have everything.

### 2. Topic / lookup question (no clear timeframe)? → Multi-angle search, minimum 3 queries

One embedding call is fragile. Run from different semantic vectors:

- Service / role: "frigate NVR", "openwrt router"
- Host / nickname: "minipc", "example-host"
- Network: use documentation examples only (e.g. RFC5737 `192.0.2.0/24` in public docs)
- Exact tokens: IPs, MACs, error strings, port numbers → use `mode="trigram"`

**FTS power move** (when supported):
- `memory_search(query="frigate OR minipc OR \"error 1234\"", mode="fts")` — real OR, phrases, exclusions.

### 3. Semantic/FTS returns thin? Immediately retry with `mode="trigram"`

The moment you get 0–2 results on something that *should* exist, re-issue the same
queries with trigram mode.

### 4. "No results" is a signal to try harder — never the final answer

Treat empty results + any user pushback as a cue to change strategy:
- Switch to browse with a wider window
- Add more angles or trigram
- Check cross-agent history (filter by `agent` only when you specifically want to exclude other Rivet faces)

Only after exhausting the memory tools should you consider external actions.

## DeepSeek Harness Specific Tool Usage

1. Discover the exact MCP tool names for the RivetOS server. Depending on how
   dsh surfaces MCP tools, they may appear as `memory_search` /
   `memory_browse` / `memory_stats`, or as qualified names such as
   `rivetos__memory_search`. Check the available tools list before calling.
2. Call the tools with the documented parameters (`window=`, `mode=`, `agent=`, etc.).
3. For time-bounded questions, strongly prefer the `window=` parameter on browse
   when the server supports it.

## Cross-Agent Reality

Memory hits may be tagged with `agent = "rivet-claude"`, `"rivet-hermes"`,
`"rivet-grok"`, `"rivet-kimi"`, `"rivet-deepseek"`, etc. This is a feature.

Only filter by `agent` when the user explicitly wants the history from one specific lineage.

## Related Patterns

- Write synonym-bridging memory entries when you discover facts through probing or user correction.
- Use `memory_stats` to understand coverage and health.
- Live capture is a Cordis `session/event` plugin, not Claude-style hooks.
