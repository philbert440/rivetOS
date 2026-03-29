# RivetOS Memory System Design

> Replacing LCM. Our system, our rules.

## Design Principles

1. **Every word persists** — full transcripts of every conversation, every tool call, every response. Never deleted.
2. **Smart retrieval, not smart storage** — store everything flat, use scoring to surface what matters.
3. **Local-first processing** — Rivet Local (GERTY) handles embeddings and compaction. No cloud API dependency for memory.
4. **Time-aware** — recent context matters more than old context. Ebbinghaus decay + access frequency.
5. **Two memory layers** — short-term (session injection) and long-term (searchable archive).

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                  Agent Turn                           │
│                                                      │
│  System Prompt = workspace files                     │
│                + short-term memory (auto-injected)   │
│                + relevant context (query-driven)     │
├──────────────────────────────────────────────────────┤
│              Short-Term Memory                        │
│                                                      │
│  What: Last N messages + recent summaries             │
│  How: Loaded on session create, updated each turn     │
│  Scoring: recency-weighted, capped by token budget    │
│  Source: messages table + summaries table              │
├──────────────────────────────────────────────────────┤
│              Long-Term Memory                         │
│                                                      │
│  What: Full transcript archive + summary DAG          │
│  How: Agent tools (memory_grep, memory_expand, etc.)  │
│  Scoring: FTS + semantic + temporal decay             │
│  Source: messages + summaries + embeddings             │
├──────────────────────────────────────────────────────┤
│              Background Processing                    │
│                                                      │
│  Embedder: Rivet Local generates embeddings (async)   │
│  Compactor: Rivet Local summarizes old messages (async)│
│  Both run on timers, never block the message pipeline │
└──────────────────────────────────────────────────────┘
```

## Schema (Clean, from scratch)

### messages
The immutable transcript. Every message ever sent or received.

```sql
CREATE TABLE messages (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL,
  agent         TEXT NOT NULL,          -- opus, grok, gemini, local
  channel       TEXT NOT NULL,          -- telegram, discord, voice, heartbeat
  role          TEXT NOT NULL,          -- user, assistant, system, tool
  content       TEXT NOT NULL DEFAULT '',
  
  -- Tool call details (NULL for non-tool messages)
  tool_name     TEXT,
  tool_args     JSONB,
  tool_result   TEXT,
  
  -- Metadata (sender info, platform-specific data)
  metadata      JSONB DEFAULT '{}',
  
  -- Search infrastructure
  embedding     halfvec(4000),          -- Nemotron 8B embeddings
  content_tsv   tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  
  -- Temporal
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_messages_conversation ON messages (conversation_id, created_at);
CREATE INDEX idx_messages_agent ON messages (agent, created_at DESC);
CREATE INDEX idx_messages_fts ON messages USING gin(content_tsv);
CREATE INDEX idx_messages_trgm ON messages USING gin(content gin_trgm_ops);
CREATE INDEX idx_messages_embedding ON messages USING hnsw(embedding halfvec_cosine_ops);
CREATE INDEX idx_messages_created ON messages (created_at DESC);
```

### conversations
Group messages into sessions.

```sql
CREATE TABLE conversations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_key   TEXT NOT NULL,           -- channelId:userId
  agent         TEXT NOT NULL,           -- opus, grok, gemini, local
  channel       TEXT NOT NULL,           -- telegram, discord, voice, cli, heartbeat
  channel_id    TEXT,                    -- platform chat/channel ID (e.g., Telegram chat ID, Discord channel ID)
  bot_identity  TEXT,                    -- @RivetGeminiBot, RivetOpus#4006
  title         TEXT,
  settings      JSONB DEFAULT '{}',      -- thinking, reasoningVisible, toolsVisible
  active        BOOLEAN DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- "What was I talking about with Grok on Discord?"
-- → agent='grok' AND channel='discord'
-- "Show me what happened in #brainstorm last week"
-- → channel_id='1474965558851145793' AND created_at > NOW() - INTERVAL '7 days'
CREATE INDEX idx_conversations_session ON conversations (session_key, active, updated_at DESC);
CREATE INDEX idx_conversations_agent_channel ON conversations (agent, channel, updated_at DESC);
```

### summaries
Compacted summaries of message groups. Forms a DAG for drill-down.

```sql
CREATE TABLE summaries (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID,                  -- NULL for cross-conversation summaries
  
  -- DAG structure
  parent_id     UUID REFERENCES summaries(id),  -- NULL for root summaries
  depth         INTEGER NOT NULL DEFAULT 0,
  
  -- Content
  content       TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'leaf',  -- leaf, branch, root
  
  -- What this summary covers
  message_count INTEGER NOT NULL DEFAULT 0,
  earliest_at   TIMESTAMPTZ,
  latest_at     TIMESTAMPTZ,
  
  -- Search
  embedding     halfvec(4000),
  content_tsv   tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  
  -- What model created this summary
  model         TEXT,
  
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Link summaries to their source messages
CREATE TABLE summary_sources (
  summary_id    UUID NOT NULL REFERENCES summaries(id),
  message_id    UUID NOT NULL REFERENCES messages(id),
  ordinal       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (summary_id, message_id)
);

CREATE INDEX idx_summaries_fts ON summaries USING gin(content_tsv);
CREATE INDEX idx_summaries_embedding ON summaries USING hnsw(embedding halfvec_cosine_ops);
CREATE INDEX idx_summaries_parent ON summaries (parent_id);
CREATE INDEX idx_summaries_time ON summaries (latest_at DESC);
```

## Short-Term Memory (Session Injection)

### What gets injected into the system prompt each turn:

1. **Workspace files** — SOUL.md, IDENTITY.md, USER.md, AGENTS.md, TOOLS.md, MEMORY.md, today's daily notes (already working)

2. **Recent conversation** — last N messages from this session (already working via session history)

3. **Relevant context** — TinyClaw-inspired scoring:

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

```sql
ALTER TABLE messages ADD COLUMN access_count INTEGER DEFAULT 0;
ALTER TABLE messages ADD COLUMN last_accessed_at TIMESTAMPTZ;
ALTER TABLE summaries ADD COLUMN access_count INTEGER DEFAULT 0;
ALTER TABLE summaries ADD COLUMN last_accessed_at TIMESTAMPTZ;
```

## Long-Term Memory (Agent Tools)

### memory_grep
Search across messages and summaries. Modes: fts, semantic, regex, trigram.
Already implemented — keep as-is.

### memory_expand  
Drill into a summary: show children and source messages.
Already implemented — keep as-is.

### memory_describe
Show summary metadata.
Already implemented — keep as-is.

### memory_expand_query (NEW)
Ask a focused question against expanded summaries. Delegates to Rivet Local:
1. Grep for relevant summaries
2. Expand them to source messages
3. Send expanded context + question to Rivet Local
4. Return the focused answer

This is the "pick up where we left off" tool.

## Background Processing

### Embedder (already built)
- Runs every 30s
- Picks up messages with NULL embedding
- Calls Nemotron 8B on GERTY (port 9401)
- 10 messages per batch

### Compactor (NEW — runs on Rivet Local)
Periodically summarize old messages into the summary DAG:

1. **Trigger**: Every 30 minutes, check for conversations with >50 unsummarized messages
2. **Batch**: Take the oldest 20-30 unsummarized messages from that conversation
3. **Summarize**: Send to Rivet Local (GERTY llama-server):
   - System prompt: "Summarize these conversation messages. Preserve: key decisions, technical details, action items, state changes. Be concise but precise."
   - Messages formatted as `[role] content`
4. **Store**: Insert summary with parent_id linking to the conversation's latest summary
5. **Link**: Insert summary_sources rows connecting the summary to its source messages
6. **Embed**: Queue the summary for embedding

**Compaction levels:**
- Level 0 (leaf): 20-30 messages → 1 summary (~200-400 tokens)
- Level 1 (branch): 5-8 leaf summaries → 1 branch summary (~300-500 tokens) 
- Level 2 (root): 3-5 branch summaries → 1 root summary (~400-600 tokens)

This creates a tree: root → branches → leaves → source messages. The `memory_expand` tool walks this tree.

## Migration from LCM

1. Create new tables alongside old ones
2. Migrate messages: `INSERT INTO new_messages SELECT ... FROM messages` (map columns)
3. Migrate summaries: `INSERT INTO new_summaries SELECT ... FROM summaries` (map columns, flatten parent relationships)
4. Migrate summary_sources: `INSERT INTO new_summary_sources SELECT ... FROM summary_messages`
5. Copy embeddings (they're the expensive part — no recomputation needed)
6. Verify counts match
7. Switch the adapter to use new tables
8. Keep old tables as read-only backup

## What We're NOT Building

- No vector database (pgvector in PostgreSQL is sufficient)
- No external embedding API (Nemotron on GERTY is local and free)
- No real-time streaming of memory updates
- No memory sharing between users (single-user system)
- No automatic forgetting/deletion (everything persists, scoring handles relevance)
