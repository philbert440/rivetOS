---
name: memory-recall
description: 'Auto-load this when the user asks about anything from a past conversation or a specific time window — "what did we do this morning / yesterday / today / recently / earlier / last week", "check memory", "do you remember", "have we seen this before", "what was that thing we tried", "did we already…", "what was the IP/MAC/password of X". Also use for any "where does X live" / "what is the IP of Y" infra lookup. Encodes the rivet-memory recall discipline — browse-with-date-range FIRST for time-bounded questions, multi-angle search plus trigram fallback for topic questions. Companion to the rivet_memory Hermes memory provider.'
tags: [rivetos, memory, recall, discipline, rivet-memory]
version: 0.3.0
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

### 1. Time-bounded question? → `rivet_memory_browse` with `window=...`. FIRST.

Any phrasing that pins a window — "this morning", "yesterday", "today",
"recently", "earlier", "last week", "the other day", "a couple days ago" —
means the user already knows *when* the relevant conversation happened. They
don't need relevance ranking. They need everything in that window.

**Use `window=` and skip the TZ math.** The DB stores `created_at` in UTC,
the user's "this morning" is in *their local timezone*, and naively passing
`since="<today>" / "<today>T00:00:00Z"` cuts off the wrong slice (UTC-midnight
is the previous afternoon/evening for any US local timezone). The plugin
ships a `window=` enum that resolves to UTC bounds anchored at the server's
local midnight — no offset arithmetic on your end.

**Recipes:**

- "this morning" → `rivet_memory_browse(window="this_morning")`
- "yesterday" → `rivet_memory_browse(window="yesterday")`
- "today" / "earlier today" → `rivet_memory_browse(window="today")`
- "this week" → `rivet_memory_browse(window="this_week")`
- "last 24 hours" / "recently" → `rivet_memory_browse(window="last_24h")`

For windows the enum doesn't cover, fall back to explicit `since`/`before`
ISO timestamps — but pass full UTC datetimes (`"2026-05-23T04:00:00Z"`), not
bare dates (`"2026-05-23"`) which Postgres reads as UTC midnight.

Add `agent="rivet-hermes"` if the user clearly means *this* Hermes session
lineage rather than cross-agent memory; otherwise omit it and let cross-agent
hits surface.

**If browse returns at `limit`,** it'll print
`_limit=N reached; more rows may exist..._` — flip `order="asc"` to see the
older end, raise `limit` (max 200), or narrow with `window`/`since`/`before`.
Pair with a topic filter only if the window has more than ~30 entries — never
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

**FTS syntax in `mode="fts"` (websearch-style):**
- `foo bar baz` — AND of all terms (default).
- `foo OR bar OR baz` — real OR. Use for a multi-angle sweep in one call
  when you already know the synonyms upfront (`"frigate OR minipc OR NVR"`).
- `"exact phrase"` — phrase match.
- `-noise` — exclude a term.

(Powered by Postgres's `websearch_to_tsquery` — the operators are part of
the query string, not separate parameters.)

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
window=        (or one with OR-joined synonyms)
   │           │
   ▼           ▼
≥ 1 hit?       ≥ 1 hit?
   │           │
  NO           NO
   │           │
   ▼           ▼
Widen window   Retry with mode: "trigram"
(or asc + bump on each query
 limit on hit)
   │           │
   └─────┬─────┘
         ▼
Still nothing? User pushes back? → re-search,
don't externally probe yet.
```

## Worked examples

**"What were we doing this morning?"**
→ `rivet_memory_browse(window="this_morning")`. Done. Don't do TZ math,
don't `rivet_memory_search("this morning")` — past messages don't contain
those words verbatim.

**"What's the frigate IP?"**
→ Topic question, no timeframe. One OR-joined call OR three separate ones:
- `rivet_memory_search(query="frigate OR minipc OR NVR")` — one call, three angles.
- Or, if you'd rather see each result set independently:
  1. `rivet_memory_search(query="frigate NVR")`
  2. `rivet_memory_search(query="minipc")`
  3. `rivet_memory_search(query="10.4.20", mode="trigram")` — literal subnet via trigram.

**"Did we touch the router today?"**
→ Time-bounded ("today"). `rivet_memory_browse(window="today")` first, then
scan for router-related entries. Don't search by keyword first — the
conversation might be tagged "openwrt", "192.168.1.1", "WAP", "DHCP", any of
which a single semantic query could miss.

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
