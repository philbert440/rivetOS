---
name: memory-recall
description: 'This skill should be used whenever the user asks about something that happened in a past conversation or a specific time window — "what did we do this morning / yesterday / today / recently / earlier / last week", "check memory", "do you remember", "have we seen this before", "what was that thing we tried", "did we already…", "what was the IP/MAC/password of X". Also use for any "where does X live" / "what is the IP of Y" infra lookup. Encodes the rivet-memory recall discipline — browse-with-date-range FIRST for time-bounded questions, multi-angle search with trigram-first for any literal/punctuated term (domains, IPs, IDs, paths, brand names) for topic questions.'
version: 0.2.0
---

# Memory Recall Discipline

You have persistent memory of every past conversation with Phil, exposed via the
`rivet-memory` MCP tools (`memory_search`, `memory_browse`, `memory_stats`). The
tools are correct; what fails is **discipline** — reaching for `memory_search`
(semantic-ranked, keyword-fragile) when the question is time-bounded and
`memory_browse` (chronological, exhaustive) is the right reflex.

This skill exists because of one specific failure mode. Read the case study at
the bottom before you forget why these rules are non-negotiable.

## The four rules

### 1. Time-bounded question? → `memory_browse` with `since` / `before`. FIRST.

Any phrasing that pins a window — "this morning", "yesterday", "today",
"recently", "earlier", "last week", "the other day", "a couple days ago" —
means the user already knows *when* the relevant conversation happened. They
don't need relevance ranking. They need everything in that window.

**Timezone — read this once and don't get it wrong.** The DB stores
`created_at` in UTC. The user's "this morning" is in **their local
timezone**, not UTC. Naively passing `<today>T00:00:00Z` cuts off the wrong
slice — for PT/MT/ET users, UTC-midnight is the previous afternoon/evening
local, so a "this morning" query at 9am ET (= 13:00 UTC same day) silently
includes yesterday-evening's conversations and may miss late-morning ones
depending on which day's UTC midnight you picked. Convert the local window
to UTC (subtract the local offset, accounting for DST). If you don't know
the user's timezone, assume system local; never silently treat `currentDate`
as if it were UTC. `currentDate` is a date string, not a timestamp.

**Recipes** (replace dates with today's; ranges are local-then-converted-to-UTC):

- "this morning" → `memory_browse(since="<local-today-00:00 → UTC>", before="<now → UTC>")`
- "yesterday" → `memory_browse(since="<local-yesterday-00:00 → UTC>", before="<local-today-00:00 → UTC>")`
- "today" / "earlier today" → `memory_browse(since="<local-today-00:00 → UTC>")`
- "this week" → `memory_browse(since="<local-monday-00:00 → UTC>")`
- "the X days" / "recently" → start with `since="<now - 3d>"`, widen if thin

Pair with a topic filter only if browse returns more than ~30 entries — never
as the first cut.

### 2. Topic question, no timeframe? → multi-angle `memory_search`, three queries minimum.

For "where does X live", "what's the IP of Y", "have we ever set up Z" — vary
the angle. One semantic query is not enough; embeddings miss when the
vocabulary doesn't co-occur.

Run three queries from different vectors:
- by **service name** (`"frigate"`, `"nginx"`)
- by **host nickname** (`"minipc"`, `"deckard"`, `"pve3"`)
- by **subnet prefix** (`"10.4.20"`, `"192.168.1"`)
- by **role** (`"NVR"`, `"router"`, `"WAP"`)

Three queries from different vectors beats one query, every time.

### 3. Literal or punctuated term? → lead with `mode: "trigram"`. Thin/empty FTS → trigram, same turn, always.

`memory_search` defaults to `mode: "fts"` (full-text), which **tokenizes on
punctuation**. So a query for a dotted / brand / identifier term —
`"families.app"`, `"emkit.dev"`, `"10.4.20.8"`, `"qwen3.6-27b-int4"`,
`/var/www/emkit.dev` — gets split apart and can return **zero hits even when the
fact is right there in memory**. Two non-negotiable defaults:

1. **If the term contains a dot, slash, colon, dash-joined id, IP/MAC, port,
   file path, or package/domain/brand name → run `mode: "trigram"` from the
   start.** These are literal tokens, not semantic concepts. (Same for exact
   error strings.)
2. **Any FTS query that returns 0–2 hits → immediately re-run it in
   `mode: "trigram"` in the same turn.** Never report "no results" off an
   FTS-only pass. Trigram is fuzzy/substring and catches what FTS tokenization
   drops.

(2026-05-31: default-FTS searches for `"families.app"` and `"emkit.dev"`
returned *No results found*; the identical terms in trigram surfaced the entire
project history. Don't repeat that whiff.)

### 4. Empty results aren't ground truth.

"No results found" means *your queries didn't surface it*, not *it isn't
there*. If the user pushes back ("check memory", "have you searched?"), treat
that as a **search-quality signal** — re-search with a different mode or
`memory_browse` with a date range before recommending external probes (ping,
nmap, asking the user, etc).

After locating a fact via probing or pushback, write a synonym-bridging memory
entry (see `host-inventory.md` and `minipc-host.md` for the canonical pattern)
so the next session finds it from any angle.

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
memory_browse  Three memory_search queries
+ since/before from different angles
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
→ Compute local-today 00:00 in the user's TZ, convert to UTC.
`memory_browse(since="<that UTC>", before="<now UTC>")`. Do NOT use
`memory_search("what did we do this morning")` — that returns empty because
no past message contains those words verbatim. And do NOT pass
`<today>T00:00:00Z` raw — that's UTC midnight, which is yesterday afternoon
or evening for any US local timezone.

**"What's the frigate IP?"**
→ Topic question, no timeframe. Run three searches:
1. `memory_search("frigate NVR")` — semantic, by role
2. `memory_search("minipc")` — by host nickname
3. `memory_search("10.4.20")` — by subnet, with `mode: "trigram"` if semantic is thin

**"Did we touch the router today?"**
→ Time-bounded ("today"). Compute local-today 00:00 → UTC, browse from
there. Then scan results for router-related entries. Don't search by
keyword first — the conversation might be tagged "openwrt", "192.168.1.1",
"WAP", "DHCP", any of which a single semantic query could miss.

**"Have we seen this error before?"**
→ Topic question with no timeframe. `memory_search` with the exact error
string in `mode: "trigram"` first — error messages are literal tokens, not
semantic concepts.

## Case study: 2026-05-23 WAP-DHCP incident

Phil reported a new WAP wasn't giving DHCP. I ran `memory_search` for
`"tp-link omada EAP setup"`, `"added wireless AP today"`, `"192.168.1.3"`,
`"daughter tablet wifi DHCP"` — **all returned zero hits**. I started
recommending external probes (nmap, ssh-by-hand) instead.

Phil twice nudged me: first "check memory from this morning", then "add a
date range to your query". Only then did I switch to:

```
memory_browse(since="2026-05-23T08:00:00Z", before="2026-05-23T14:30:00Z")
```

That call surfaced the **entire morning conversation**: WAP IP, MAC, SSH
creds, the duplicate static-lease that broke dnsmasq. Everything I needed.

The failure wasn't the tools. It was reaching for the wrong tool first. This
skill exists so future-me doesn't burn the same ten minutes.

## Related memories

- `feedback-memory-search-discipline.md` — the rule source
- `host-inventory.md` — the synonym-bridging entry pattern
- `minipc-host.md` — example of a dual-homed host write-up that survives
  vocabulary drift
- `project-rivetos-memory-cc-plugin.md` — why this plugin exists
