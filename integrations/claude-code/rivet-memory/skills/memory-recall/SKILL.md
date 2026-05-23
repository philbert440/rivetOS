---
name: memory-recall
description: 'This skill should be used whenever the user asks about something that happened in a past conversation or a specific time window — "what did we do this morning / yesterday / today / recently / earlier / last week", "check memory", "do you remember", "have we seen this before", "what was that thing we tried", "did we already…", "what was the IP/MAC/password of X". Also use for any "where does X live" / "what is the IP of Y" infra lookup. Encodes the rivet-memory recall discipline — browse-with-date-range FIRST for time-bounded questions, multi-angle search plus trigram fallback for topic questions.'
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

**Recipes** (replace dates with today's):

- "this morning" → `memory_browse(since="<today>T00:00:00Z", before="<now>")`
- "yesterday" → `memory_browse(since="<yesterday>T00:00:00Z", before="<today>T00:00:00Z")`
- "today" / "earlier today" → `memory_browse(since="<today>T00:00:00Z")`
- "this week" → `memory_browse(since="<monday>T00:00:00Z")`
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

### 3. Semantic returns thin? → fall back to `mode: "trigram"`.

`memory_search` defaults to semantic embeddings. They miss literal token
matches: IPs, MACs, hostnames, port numbers, exact error strings. The moment
you see ≤ 2 hits on a query that *should* have matched, re-run it with
`mode: "trigram"`. Often the result is already in memory, indexed under
different surrounding text.

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
→ `memory_browse(since="<today>T00:00:00Z")`. Not `memory_search("what did
we do this morning")` — that returns empty because no past message contains
those words verbatim.

**"What's the frigate IP?"**
→ Topic question, no timeframe. Run three searches:
1. `memory_search("frigate NVR")` — semantic, by role
2. `memory_search("minipc")` — by host nickname
3. `memory_search("10.4.20")` — by subnet, with `mode: "trigram"` if semantic is thin

**"Did we touch the router today?"**
→ Time-bounded ("today"). `memory_browse(since="<today>T00:00:00Z")` first,
then scan results for router-related entries. Don't search by keyword first —
the conversation might be tagged "openwrt", "10.4.20.1", "WAP", "DHCP", any
of which a single semantic query could miss.

**"Have we seen this error before?"**
→ Topic question with no timeframe. `memory_search` with the exact error
string in `mode: "trigram"` first — error messages are literal tokens, not
semantic concepts.

## Case study: 2026-05-23 WAP-DHCP incident

Phil reported a new WAP wasn't giving DHCP. I ran `memory_search` for
`"tp-link omada EAP setup"`, `"added wireless AP today"`, `"10.4.20.3"`,
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
