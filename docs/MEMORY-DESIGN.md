# RivetOS Memory System Design

> Our system, our rules.

## Design Principles

1. **Every word persists** — full transcripts of every conversation, every tool call, every response. Never deleted.
2. **Smart retrieval, not smart storage** — store everything flat, use scoring to surface what matters.
3. **Local-first processing** — Rivet Local (GERTY) handles embeddings and compaction. No cloud API dependency for memory.
4. **Time-aware** — recent context matters more than old context. Ebbinghaus decay + access frequency.
5. **Two memory layers** — short-term (session injection) and long-term (searchable archive).

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                  Agent Turn                             │
│                                                         │
│  System Prompt = workspace files                        │
│                + short-term memory (auto-injected)      │
│                + relevant context (query-driven)        │
├─────────────────────────────────────────────────────────┤
│              Short-Term Memory                          │
│                                                         │
│  What: Last N messages + recent summaries               │
│  How: Loaded on session create, updated each turn       │
│  Scoring: recency-weighted, capped by token budget      │
│  Source: messages table + summaries table               │
├─────────────────────────────────────────────────────────┤
│              Long-Term Memory                           │
│                                                         │
│  What: Full transcript archive + summary DAG            │
│  How: Agent tools (memory_search, memory_browse)        │
│  Scoring: FTS + semantic + temporal decay               │
│  Source: messages + summaries + embeddings              │
├─────────────────────────────────────────────────────────┤
│              Background Processing                      │
│                                                         │
│  Embedder: Rivet Local generates embeddings (async)     │
│  Compactor: Rivet Local summarizes old messages (async) │
│  Both run on timers, never block the message pipeline   │
└─────────────────────────────────────────────────────────┘
```

## Schema (ros_* prefix)

### messages
The immutable transcript. Every message ever sent or received.

```sql
CREATE TABLE ros_messages (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL,
  agent         TEXT NOT NULL,
  channel       TEXT NOT NULL,
  role          TEXT NOT NULL,
  content       TEXT NOT NULL DEFAULT '',
  tool_name     TEXT,
  tool_args     JSONB,
  tool_result   TEXT,
  metadata      JSONB DEFAULT '{}',
  embedding     halfvec(4000),
  content_tsv   tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### conversations
Group messages into sessions.

```sql
CREATE TABLE ros_conversations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_key   TEXT NOT NULL,
  agent         TEXT NOT NULL,
  channel       TEXT NOT NULL,
  channel_id    TEXT,
  bot_identity  TEXT,
  title         TEXT,
  settings      JSONB DEFAULT '{}',
  active        BOOLEAN DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### summaries
Compacted summaries of message groups. Forms a DAG for drill-down.

```sql
CREATE TABLE ros_summaries (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID,
  parent_id     UUID REFERENCES ros_summaries(id),
  depth         INTEGER NOT NULL DEFAULT 0,
  content       TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'leaf',
  message_count INTEGER NOT NULL DEFAULT 0,
  earliest_at   TIMESTAMPTZ,
  latest_at     TIMESTAMPTZ,
  embedding     halfvec(4000),
  content_tsv   tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  model         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### summary_sources
Links summaries to their source messages.

```sql
CREATE TABLE ros_summary_sources (
  summary_id    UUID NOT NULL REFERENCES ros_summaries(id),
  message_id    UUID NOT NULL REFERENCES ros_messages(id),
  ordinal       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (summary_id, message_id)
);
```

## Short-Term Memory (Session Injection)

### What gets injected into the system prompt each turn:

1. **Workspace files** — SOUL.md, IDENTITY.md, USER.md, AGENTS.md, TOOLS.md, MEMORY.md, today's daily notes

2. **Recent conversation** — last N messages from this session (via session history)

3. **Relevant context** — hybrid-scored retrieval:

```
relevance = (fts_rank × 0.3) + (semantic_similarity × 0.3) + (temporal_score × 0.3) + (importance × 0.1)

where:
  fts_rank       = BM25 full-text match (0-1)
  semantic_sim   = cosine similarity of embedding to query (0-1)
  temporal_score = e^(-0.05 × days_since_access) × (1 + 0.02 × access_count)
  importance     = base importance by type (correction: 0.9, preference: 0.8, fact: 0.6, task: 0.5)
```

Token budget: ~4000 tokens for injected context. Fill with highest-scoring results until budget is reached.

### Access frequency tracking:
When a message or summary is returned in a search result, increment its access count. Frequently-accessed memories decay slower (Ebbinghaus reinforcement).

## Long-Term Memory (Agent Tools)

### Consolidated Tool Surface (3 tools)

| Tool | Description |
|------|-------------|
| `memory_search` | Unified search + auto-expand. Searches messages + summaries, auto-expands top summary hits to children/source messages. Supports FTS/trigram/regex modes, agent/date filters, optional LLM synthesis. |
| `memory_browse` | Chronological message browsing. For reviewing sessions and catching up on activity. |
| `memory_stats` | System health diagnostics. Embedding queue depth, unsummarized message counts, compaction status, summary tree depth, embedding coverage. |

Consolidated from the original 6-tool design (`memory_grep`, `memory_expand`, `memory_describe`, `memory_expand_query`) down to 3 tools that require less LLM orchestration.

## Background Processing

### Embedder
- Runs on a timer (configurable interval)
- Picks up messages with NULL embedding
- Calls embedding model on GERTY (Nemotron 8B)
- Batch processing with error recovery

### Compactor
Periodically summarize old messages into the summary DAG:

1. **Trigger**: Check for conversations with unsummarized messages exceeding threshold
2. **Batch**: Take the oldest unsummarized messages from that conversation
3. **Summarize**: Send to Rivet Local — preserve key decisions, technical details, action items, state changes
4. **Store**: Insert summary with parent_id linking to the conversation's latest summary
5. **Link**: Insert summary_sources rows connecting the summary to its source messages
6. **Embed**: Queue the summary for embedding

**Compaction levels:**
- Level 0 (leaf): messages → 1 summary
- Level 1 (branch): leaf summaries → 1 branch summary
- Level 2 (root): branch summaries → 1 root summary

This creates a tree: root → branches → leaves → source messages. The `memory_search` tool auto-expands this tree.

## v5 Memory-Quality Pipeline

The v5 pipeline (April 2026) replaces the original cloud-model-tuned compactor with a local-first, thinking-model architecture optimized for faithfulness and searchability.

### What v5 changed vs v4

| Concern | v4 behavior | v5 behavior |
|---|---|---|
| Source message truncation | Hard-capped at 1,000 chars per message | No truncation — 128k context window handles full messages |
| Summary budget | 1k / 1.5k / 2k tokens (leaf/branch/root) | **7k / 14k / 20k** — thinking mode needs real headroom |
| Thinking | Disabled | **Enabled** — model reasons before summarizing |
| Timestamps | Date-only at branch/root, absent at leaf | **ISO-minute timestamps on every message and every layer** — recency discrimination across same-day iterations |
| Agent attribution | Dropped | **Preserved per message** (`[#01 2026-04-18T12:00Z opus/user]`) |
| Conversation metadata | Absent | **Preamble header** with conv id, agent, channel, title, span, message count |
| System messages | Treated as redundant context | **First-class** — extracts PR numbers, commits, skill names, line counts |
| Tool-call rows (empty content) | Ignored — never embedded, never summarized | **Synthesized** content via async queue (see below) |
| HTTP client | Raw `fetch`, 60s timeout | **Hardened undici Agent** — no timeouts except AbortSignal, 3 retries with 5/10/15s backoff |

See `docs/DECISIONS.md` for the full rationale and the 10-pick probe methodology used to validate each change.

### Prompt architecture

Three system prompts live in `plugins/memory/postgres/src/compactor/types.ts`:

- `LEAF_SYSTEM_PROMPT` — summarize raw messages
- `BRANCH_SYSTEM_PROMPT` — summarize leaves
- `ROOT_SYSTEM_PROMPT` — summarize branches

All three share a common rule set: **exhaustiveness** (cover every distinct topic), **no outside context** (never invent facts not in the source), **system-messages-first-class** (extract identifiers verbatim), and a LaTeX ban (plain Unicode only).

### Tool-call content synthesis

Many assistant messages in the corpus contain only `tool_name` + `tool_args` with empty content. These rows cannot be embedded (empty text) and fall through every search path.

The v5 pipeline synthesizes natural-language content for them — a single past-tense sentence describing what was called — which makes them findable by both FTS and vector search.

**Two synthesis paths:**

1. **Async queue (live path)** — `adapter.ts` enqueues rows into `ros_tool_synth_queue` on insert when content is empty and `tool_name` is set. The compaction-worker's `drainToolSynthQueue` job picks them up, calls the synthesizer, and writes content back. Non-blocking — inserts never fail on synthesis errors.

2. **CLI backfill (historical)** — `rivetos memory backfill-tool-synth` enqueues historical empty rows, then processes them in parallel workers using the same synthesis helper. Resumable, NUMA-pinned friendly (`--urls http://gerty:8001/v1,http://gerty:8002/v1`), and safe to run concurrently with the live queue (`FOR UPDATE SKIP LOCKED`).

The shared helper (`synthesizeToolCallContent` in `plugins/memory/postgres/src/tool-synth.ts`) uses the exact same hardened undici client and prompt as the compactor. Model-agnostic — point `TOOL_SYNTH_ENDPOINT` / `TOOL_SYNTH_MODEL` at any OpenAI-compatible endpoint.

### Schema additions

```sql
CREATE TABLE ros_tool_synth_queue (
  message_id      UUID PRIMARY KEY REFERENCES ros_messages(id) ON DELETE CASCADE,
  enqueued_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts        INT NOT NULL DEFAULT 0,
  last_error      TEXT,
  last_attempt_at TIMESTAMPTZ
);
CREATE INDEX idx_tool_synth_queue_enqueued ON ros_tool_synth_queue(enqueued_at);
```

Applied by `plugins/memory/postgres/src/migrate-v3.ts`. Idempotent — safe to run multiple times.

### Operations

```bash
# Show queue health
rivetos memory queue-status

# Synthesize all historical candidates
rivetos memory backfill-tool-synth \
  --concurrency 8 --batch 8 \
  --urls http://gerty:8001/v1,http://gerty:8002/v1

# Plan only (count candidates, no writes)
rivetos memory backfill-tool-synth --dry-run
```

Rows that fail 3 times are left in the queue (use `queue-status` to surface them) and are not retried automatically. Inspect `last_error`, fix the condition, then run backfill again.

## What We're NOT Building

- No vector database (pgvector in PostgreSQL is sufficient)
- No external embedding API (Nemotron on GERTY is local and free)
- No real-time streaming of memory updates
- No memory sharing between users (single-user system)
- No automatic forgetting/deletion (everything persists, scoring handles relevance)
