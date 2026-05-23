---
name: memory-recall
description: 'Auto-load this when the user asks about anything from a past conversation or a specific time window — "what did we do this morning / yesterday / today / recently / earlier / last week", "check memory", "do you remember", "have we seen this before", "what was that thing we tried", "did we already…", "what was the IP/MAC/password of X". Also use for any "where does X live" / "what is the IP of Y" infra lookup. Encodes the rivet-memory recall discipline — browse-with-date-range FIRST for time-bounded questions, multi-angle search plus trigram fallback for topic questions. Companion to the rivet_memory Hermes memory provider.'
tags: [rivetos, memory, recall, discipline, rivet-memory]
version: 0.2.0
---

# Memory Recall Discipline (Hermes)

You have persistent cross-agent memory via the `rivet_memory` provider —
exposed as the in-process tools `rivet_memory_search`, `rivet_memory_browse`,
and `rivet_memory_stats`. Every Rivet agent (rivet-hermes, rivet-claude, opus,
grok) writes into the same store, so memory you find may be from past Hermes
turns OR from another agent's session.

The tools are correct; what fails is **discipline** — reaching for
`rivet_memory_search` (semantic-ranked, keyword-fragile) when the question is
time-bounded and `rivet_memory_browse` (chronological, exhaustive) is the
right reflex.

Read the case study at the bottom before you forget why these rules are
non-negotiable.

## The four rules

### 1. Time-bounded question? → `rivet_memory_browse` with `since` / `before`. FIRST.

Any phrasing that pins a window — "this morning", "yesterday", "today",
"recently", "earlier", "last week", "the other day", "a couple days ago" —
means the user already knows *when* the relevant conversation happened. They
don't need relevance ranking. They need everything in that window.

**Timezone — read this once and don't get it wrong.** The DB stores
`created_at` in UTC. The user's "this morning" is in **their local
timezone**, not UTC. Naively passing `<today>T00:00:00Z` cuts off the wrong
slice — for PT/MT/ET users, UTC-midnight is the previous afternoon/evening
local. Convert the local window to UTC for the query (subtract the local
offset). If you don't know the user's timezone, ask once or assume system
local; never silently treat `currentDate` as if it were UTC.

**Recipes** (replace dates with today's; ranges are local-then-converted-to-UTC):

- "this morning" → `rivet_memory_browse(since="<local-today-00:00 → UTC>", before="<now → UTC>")`
- "yesterday" → `rivet_memory_browse(since="<local-yesterday-00:00 → UTC>", before="<local-today-00:00 → UTC>")`
- "today" / "earlier today" → `rivet_memory_browse(since="<local-today-00:00 → UTC>")`
- "this week" → `rivet_memory_browse(since="<local-monday-00:00 → UTC>")`
- "the X days" / "recently" → start with `since="<now - 3d>"`, widen if thin
- Add `agent="rivet-hermes"` if the user clearly means *this* Hermes session lineage
  rather than cross-agent memory; otherwise omit it and let cross-agent hits surface.

Pair with a topic filter only if browse returns more than ~30 entries — never
as the first cut.

### 2. Topic question, no timeframe? → multi-angle `rivet_memory_search`, three queries minimum.

For "where does X live", "what's the IP of Y", "have we ever set up Z" — vary
the angle. One semantic query is not enough; embeddings miss when the
vocabulary doesn't co-occur.

Run three queries from different vectors:
- by **service name** (`"frigate"`, `"nginx"`)
- by **host nickname** (`"minipc"`, `"deckard"`, `"pve3"`)
- by **subnet prefix** (`"10.4.20"`, `"192.168.1"`)
- by **role** (`"NVR"`, `"router"`, `"WAP"`)

For non-infra topics (decisions, preferences, prior reasoning), vary by
synonym, related concept, or stakeholder name instead. Three angles, always.

### 3. Semantic returns thin? → fall back to `mode: "trigram"`.

`rivet_memory_search` defaults to FTS-with-semantic-blend. It misses literal
token matches: IPs, MACs, hostnames, port numbers, exact error strings. The
moment you see ≤ 2 hits on a query that *should* have matched, re-run it
with `mode: "trigram"`. Often the result is already in memory, indexed under
different surrounding text.

### 4. Empty results aren't ground truth.

"No results found" means *your queries didn't surface it*, not *it isn't
there*. If the user pushes back ("check memory", "have you searched?"), treat
that as a **search-quality signal** — re-search with a different mode or
`rivet_memory_browse` with a date range before recommending external probes
(ping, nmap, asking the user, etc.).

After locating a fact via probing or pushback, write a synonym-bridging memory
entry so the next session finds it from any angle.

## Cross-agent reality check

Because every Rivet agent writes into the same store, recall hits may carry
an `agent` tag of `rivet-claude`, `opus`, `grok`, etc. Treat those as
first-class — Phil's "did we ever do X" includes work done by other Rivet
faces. Only filter by `agent="rivet-hermes"` when the user explicitly means
"in this Hermes session lineage."

## Decision flow

```
User question about past work or facts
         │
         ▼
Does it mention a timeframe?
   ("this morning", "yesterday", "today", "recently"…)
         │
   ┌─────┴─────┐
  YES          NO
   │           │
   ▼           ▼
rivet_memory_  Three rivet_memory_search
browse +       queries, different angles
since/before
   │           │
   ▼           ▼
≥ 1 hit?       ≥ 1 hit?
   │           │
  NO           NO
   │           │
   ▼           ▼
Widen window   Retry with mode: "trigram"
or add topic   on each query
   │           │
   └─────┬─────┘
         ▼
Still nothing? User pushes back? → re-search,
don't externally probe yet.
```

## Worked examples

**"What were we doing this morning?"**
→ Compute local-today 00:00 in user's TZ, convert to UTC.
`rivet_memory_browse(since="<that UTC>", before="<now UTC>")`. Do NOT
`rivet_memory_search("what did we do this morning")` — past messages don't
contain those words verbatim.

**"What's the frigate IP?"**
→ Topic question, no timeframe. Run three searches:
1. `rivet_memory_search(query="frigate NVR")` — semantic, by role
2. `rivet_memory_search(query="minipc")` — by host nickname
3. `rivet_memory_search(query="10.4.20", mode="trigram")` — by subnet, literal

**"Did we touch the router today?"**
→ Time-bounded ("today"). Local-today midnight → UTC for `since`. Browse
first, then scan results for router-related entries. Don't search by keyword
first — the conversation might be tagged "openwrt", "192.168.1.1", "WAP",
"DHCP", any of which a single semantic query could miss.

**"Have we seen this error before?"**
→ Topic question with no timeframe. `rivet_memory_search` with the exact
error string in `mode: "trigram"` first — error messages are literal tokens,
not semantic concepts.

## Case study: 2026-05-23 WAP-DHCP incident (rivet-claude session, same lesson)

A sibling Rivet session reported a new WAP wasn't giving DHCP. The agent ran
`memory_search` for `"tp-link omada EAP setup"`, `"added wireless AP today"`,
`"192.168.1.3"`, `"daughter tablet wifi DHCP"` — **all returned zero hits**.
It started recommending external probes (nmap, ssh-by-hand) instead.

Phil twice nudged: first "check memory from this morning", then "add a date
range to your query". Only then did the agent switch to:

```
memory_browse(since="2026-05-23T08:00:00Z", before="2026-05-23T14:30:00Z")
```

That call surfaced the **entire morning conversation**: WAP IP, MAC, SSH
creds, the duplicate static-lease that broke dnsmasq.

The failure wasn't the tools. It was reaching for the wrong tool first.
This skill exists so future Hermes turns don't burn the same ten minutes.
The lesson lives in shared memory across every Rivet agent — same store,
same discipline.

## Related memories

- `feedback-memory-search-discipline.md` — the rule source
- `host-inventory.md` — the synonym-bridging entry pattern
- `hermes-rivet-memory-plugin-plan.md` — why this plugin exists
