# RivetOS memory system design

> Our system, our rules.

## Design principles

1. **Every word persists**: full transcripts of every conversation, every tool call, every response. Never deleted.
2. **Smart retrieval, not smart storage**: store everything flat, use scoring to surface what matters.
3. **Local-first processing**: Rivet Local (GERTY) handles embeddings and compaction. No cloud API dependency for memory.
4. **Time-aware**: recent context matters more than old context. Ebbinghaus decay + access frequency.
5. **Two memory layers**: short-term (session injection) and long-term (searchable archive).

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

## Short-term memory (session injection)

### What gets injected into the system prompt each turn:

1. **Workspace files**: SOUL.md, IDENTITY.md, USER.md, AGENTS.md, TOOLS.md, MEMORY.md, today's daily notes

2. **Recent conversation**: last N messages from this session (via session history)

3. **Relevant context**: hybrid-scored retrieval:

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

## Long-term memory (agent tools)

### Consolidated tool surface (4 tools)

| Tool | Description |
|------|-------------|
| `memory_search` | Unified search + auto-expand. Searches messages + summaries, auto-expands top summary hits to children/source messages. Supports FTS/trigram/regex modes, agent/date filters, optional LLM synthesis. |
| `memory_browse` | Chronological message browsing. For reviewing sessions and catching up on activity. |
| `memory_stats` | System health diagnostics. Embedding queue depth, unsummarized message counts, compaction status, summary tree depth, embedding coverage. |
| `memory_get_full` | Recover the full payload of a capture-truncated row by id. Rows written by capture workers carry a disk pointer (`session_jsonl_path`/`line` for jsonl harnesses, `session_sqlite_path`/`session_sqlite_part_id` for OpenCode); rows written through the sidecar write tools do not, and their elided tails are unrecoverable. |

Consolidated from the original 6-tool design (`memory_grep`, `memory_expand`, `memory_describe`, `memory_expand_query`) down to this surface, which needs less LLM orchestration.

## Write surface (MCP sidecar)

External MCP clients can write memory through two gated sidecar tools (added 2026-08 for the Grok Bot bridge, usable by any harness):

| Tool | Description |
|------|-------------|
| `memory_append` | Append one message. `role` is required; `content` may be empty only for tool-call messages (`tool_name`/`tool_result` present), which feed the tool-synthesis pipeline. Accepts an optional `event_id` idempotency key; without one, a content-hash key is generated (identical repeated appends collapse by design; pass distinct `event_id`s to store true repeats). |
| `memory_ingest_session` | Bulk-ingest a transcript. Each message requires `role` (**breaking change 2026-08-20**: the old silent `assistant` default is gone, because role is dedupe-hash material) and may carry an ISO `created_at`, preserved into the row so recall order survives replay. Idempotent: per-message event_ids include the ordinal, so retries skip stored rows while repeated identical lines still ingest. |

Both tools register only when `RIVETOS_MCP_ENABLE_MEMORY_WRITE=1` (the write surface is off by default, like `shell` and `file_write`). `memory_tags` follows the same policy: where agents get it in-process it is read-only (list, pending, counts, lookup, taxonomy), and its mutating actions (decide, add, taxonomy edits and merge) answer on the den route and, with the write flag set, through the MCP sidecar on either transport (without the flag the sidecar registers the tool read-only). The six tool names above plus `memory_tags` are callable on the den at `POST /api/memory/tool/<name>` (arguments unchanged, response `{ ok: true, result }` is the tool's own return). Write tools 404 on that route when the pool has no Postgres memory. Tags (`source`/`agent`/`channel`/`persona`) resolve from call args, then `RIVETOS_MEMORY_*` env, then `mcp` defaults; integration launchers pin them (the Grok Bot launcher sets `agent` from the slug rule, default prefix `grokbot`). Content and `tool_result` are capped at 16,000 chars with `truncated`/`full_content_length` reported back to the caller; unlike capture-worker truncation there is no disk pointer, so the tail is gone. Decide before writing.

**Writer convention (load-bearing):** every `ros_messages` writer, capture workers and sidecar tools alike, takes `pg_advisory_xact_lock(hashtext(session_key))` before check-then-insert. Dedupe is convention-enforced, not schema-enforced; a new writer that skips the lock can race in duplicates.

`POST /api/capture` is the canonical harness capture write path: the den locks the session inside one transaction, dedupes batch event IDs within the conversation, and finalizes last. Dedupe remains convention-enforced, with no new schema constraint. `@rivetos/capture-core` spools network/5xx failures as private JSON files in `~/.rivetos/capture-spool`, replays at most 50 oldest files before the next write, and moves 4xx replay failures to `dead/`. The codex, qwen-code, and claude-cli capture hooks post through this route (and spool there when the den is down) instead of opening their own Postgres pools.

### Capture metadata for full-payload recovery

The server hard-caps `content` and `tool_result` at 16,000 UTF-16 code units without an inline marker, recording the corresponding `full_content_length` / `full_tool_result_length` and `truncated: true` in metadata when capped. `memory_get_full` rehydrates only when `metadata.truncated === true` and the row carries a disk pointer in metadata: `session_jsonl_path` (string) plus `session_jsonl_line` (number), or for OpenCode `session_sqlite_path` plus `session_sqlite_part_id`. The server does not cap `tool_args` and never writes `full_tool_args_length` / `full_reasoning_length`; hooks that elide those fields must set the corresponding lengths themselves as numbers. A row over 16k capped without a disk pointer is unrecoverable.

## Background processing

### Embedder
- Runs on a timer (configurable interval)
- Picks up messages with NULL embedding
- Calls embedding model on GERTY (Nemotron 8B)
- Batch processing with error recovery

### Compactor
Periodically summarize old messages into the summary DAG:

1. **Trigger**: Check for conversations with unsummarized messages exceeding threshold
2. **Batch**: Take the oldest unsummarized messages from that conversation
3. **Summarize**: Send to Rivet Local; preserve key decisions, technical details, action items, state changes
4. **Store**: Insert summary with parent_id linking to the conversation's latest summary
5. **Link**: Insert summary_sources rows connecting the summary to its source messages
6. **Embed**: Queue the summary for embedding

**Compaction levels:**
- Level 0 (leaf): messages → 1 summary
- Level 1 (branch): leaf summaries → 1 branch summary
- Level 2 (root): branch summaries → 1 root summary

This creates a tree: root → branches → leaves → source messages. The `memory_search` tool auto-expands this tree.

### Tagger
Sessions and summaries carry `key:value` tags (`ros_tags`, migration 0019) with a review loop: `suggested` → `accepted` / `rejected`. Rejected rows are kept so the same tag is never proposed twice.

- **Rule tags** are facts and skip review: the capture path derives `project:<repo>` from the hook-recorded `settings.cwd` (origin remote name → git root → cwd basename; worktrees resolve to the main repo) and writes it `accepted`.
- **Model tags** come from the `suggest-tags` task, enqueued after each leaf commit. It offers the accepted vocabulary (`ros_tag_taxonomy` + in-use accepted tags) to the tagger and writes proposals on both the summary and its conversation as `suggested`; unseen values also land in `ros_tag_taxonomy` as `suggested` so the vocabulary itself is reviewed.
- **Review and use**: the hub and agents share one surface. HTTP `/api/memory/tags` (list, `pending`, `counts`, `decide`, `add`, `lookup` by session key, `taxonomy` list/upsert/decide/merge) and the `memory_tags` MCP tool with the same actions. `memory_search`, `memory_browse` and the matching HTTP routes take `tag=key:value` to restrict to conversations carrying an accepted tag (on the session or any of its summaries; the predicate is applied inside the queries, so a sparse tag is not crowded out), and return each hit's accepted session tags. On a database that has not run migration 0019 tag reads are empty and tag writes answer 503 (the tool says tagging is not installed). A tag literal may be typed with a full-width colon. Counts use the same definition as the filter: a conversation counts when the tag is on the session or any of its summaries. Rejecting keeps the row, so a rejected tag is never re-proposed; merging a vocabulary value re-points its tags and leaves an alias behind.
- **Wiki**: `extract-wiki` reads the tags already accepted when a leaf is mined and treats the two kinds differently. *Reviewed* tags (added or accepted by a person; re-adding the rule tag, re-accepting it after a rejection, or merging an accepted reviewed tag into it makes it a reviewed tag, and the rule still writes no second project for that session) are identity hints: a `project:` tag is a strong signal for which topic to update and is carried into the patch's entities. The automatic cwd *rule* tag only says where the session ran: it can break a tie, is never added as an entity (the worker strips it from a patch's entities before the identity gate), and is used as a candidate-topic query only when the summary itself mentions it. A leaf's own model suggestions are still unreviewed at that point and are not used; a session tag accepted later informs later leaves of that session, and a leaf already mined at the current pipeline version is not re-mined when a tag is accepted afterwards. `WIKI_PIPELINE_VERSION` 4 marks the introduction of tags as input: the backfill sweep re-mines, once and at low priority, every leaf done under an older version, so history picks up the tags accepted by then.
- **The tagger is a service like the embedder**: `RIVETOS_TAGGER_URL` / `_MODEL` / `_API_KEY` or `_TOKEN_COMMAND`, wire shape `openai` (chat completions + built-in prompt) or `native` (classifier POST). Unset, the compactor model tags. `SESSION_TAGGING=0` disables. Tagging is best-effort: each call is bounded by `RIVETOS_TAGGER_TIMEOUT_SECONDS` (60), a failing job is retried once and then dropped (never left dead), and there is no backfill for summaries compacted while tagging was off or the tagger was down. Orphaned tag rows (entity deleted) are removed by the hourly reap task.
- **SQLite backend**: the same tables and the same lifecycle. The rule tag is written at capture, `suggest-tags` runs on the plugin's in-process job loop, summary tags count for their conversation, and the vocabulary is edited through the same HTTP paths and the HTTP `memory_tags` tool (`tag-vocabulary.ts`, `tagging.ts`). The agent's in-process tags tool is read-only, as on Postgres. The tagger speaks both wire shapes.

## v5 memory-quality pipeline

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

### Prompt architecture

Three system prompts live in `packages/memory-core/src/compactor/types.ts`:

- `LEAF_SYSTEM_PROMPT`: summarize raw messages
- `BRANCH_SYSTEM_PROMPT`: summarize leaves
- `ROOT_SYSTEM_PROMPT`: summarize branches

All three share a common rule set: **exhaustiveness** (cover every distinct topic), **no outside context** (never invent facts not in the source), **system-messages-first-class** (extract identifiers verbatim), and a LaTeX ban (plain Unicode only).

### Tool-call content synthesis

Many assistant messages in the corpus contain only `tool_name` + `tool_args` with empty content. These rows cannot be embedded (empty text) and fall through every search path.

The v5 pipeline synthesizes natural-language content for them, a single past-tense sentence describing what was called, which makes them findable by both FTS and vector search.

**Two synthesis paths:**

1. **Async (live path)**: `adapter.ts` calls `graphile_worker.add_job('synthesize-tool-call', …)` on insert when content is empty and `tool_name` is set. The compaction-worker service consumes the job and writes content back. Non-blocking; inserts never fail on synthesis errors. Dedup via `job_key` so duplicate enqueues coalesce.

2. **CLI backfill (historical)**: `rivetos memory backfill-tool-synth` enqueues a `synthesize-tool-call` job for each historical empty row. Idempotent; already-enqueued messages dedupe via `job_key`. Concurrency, retries, and rate limiting are handled by graphile-worker on the compaction-worker side.

The shared helper (`synthesizeToolCallContent` in `plugins/memory/postgres/src/tool-synth.ts`) uses a hardened undici client and the same prompt as the compactor. Model-agnostic; point `TOOL_SYNTH_ENDPOINT` / `TOOL_SYNTH_MODEL` at any OpenAI-compatible endpoint.

### Operations

```bash
# Show graphile-worker queue state for all RivetOS tasks
rivetos memory queue-status

# Enqueue all historical empty-content tool-call rows
rivetos memory backfill-tool-synth

# Plan only (count candidates, no enqueue)
rivetos memory backfill-tool-synth --dry-run

# After deploying a code fix that made a whole class of jobs die at max_attempts
# (e.g. extract-wiki after a SQL bug), reset those dead rows so workers retry:
rivetos memory retry-failed --task extract-wiki --error 'text[] &' --dry-run
rivetos memory retry-failed --task extract-wiki --error 'text[] &'
```

Failed jobs (after `max_attempts`) remain in graphile-worker's `_private_jobs` table with `attempts >= max_attempts` and `is_available = false`. `queue-status` surfaces counts + a sample `last_error`. `retry-failed` clears `attempts` / `last_error` / locks on matching rows (requires `--task`) so workers pick them up again without losing `job_key` identity.
## What we're NOT building

- No vector database (pgvector in PostgreSQL is sufficient)
- No external embedding API (Nemotron on GERTY is local and free)
- No real-time streaming of memory updates
- No memory sharing between users (single-user system)
- No automatic forgetting/deletion (everything persists, scoring handles relevance)
