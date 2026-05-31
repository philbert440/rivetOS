-- =============================================================================
-- 0001_baseline.sql — consolidated baseline for the RivetOS memory store.
--
-- This is a SQUASH of the former 0001–0004 migration chain, regenerated from
-- the live datahub schema (pg_dump --schema-only, 2026-05-31) so it reflects
-- *actual production* — including changes that had been applied out-of-band and
-- never recorded as migrations:
--   • HNSW vector indexes on the embedding columns (were missing from schema-as-code)
--   • notify_embedding_queue() in its current form (graphile_worker.add_job,
--     LENGTH(TRIM(content)) > 0, max_attempts => 5)
--   • the bespoke queue tables (ros_embedding_queue / ros_compaction_queue /
--     ros_tool_synth_queue) and the check_compaction_threshold trigger +
--     enqueue_idle_sessions() are intentionally ABSENT — compaction enqueueing
--     now lives in the worker's graphile-worker 'enqueue-idle' cron, not a DB trigger.
--
-- Idempotent (IF NOT EXISTS / CREATE OR REPLACE) so it is a safe no-op against
-- any database that already carries this schema. Existing DBs that recorded
-- "0001_baseline.sql" simply skip it; fresh / disaster-recovery builds get the
-- full schema from this one file.
--
-- Runtime note: notify_embedding_queue() calls graphile_worker.add_job(). That
-- schema is installed lazily by the compaction/embedding worker services on
-- first run. plpgsql does not resolve the call at CREATE time, so this file
-- applies cleanly before graphile_worker exists; the trigger only needs it at
-- INSERT time, by which point the workers have started (same ordering as today).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Extensions (provide halfvec + halfvec_cosine_ops and gin_trgm_ops)
-- -----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- -----------------------------------------------------------------------------
-- ros_conversations — sessions, grouped by channel/agent with settings
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ros_conversations (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_key   TEXT NOT NULL,
    agent         TEXT NOT NULL,
    channel       TEXT NOT NULL DEFAULT 'unknown',
    channel_id    TEXT,
    bot_identity  TEXT,
    title         TEXT,
    settings      JSONB DEFAULT '{}'::jsonb,
    active        BOOLEAN DEFAULT true,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ros_conversations_session
    ON ros_conversations (session_key, active, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_ros_conversations_agent_channel
    ON ros_conversations (agent, channel, updated_at DESC);

-- -----------------------------------------------------------------------------
-- ros_messages — immutable transcript with tool data, embeddings, access stats
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ros_messages (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id   UUID NOT NULL REFERENCES ros_conversations(id) ON DELETE CASCADE,
    agent             TEXT NOT NULL,
    channel           TEXT NOT NULL,
    role              TEXT NOT NULL CHECK (role IN ('system','user','assistant','tool')),
    content           TEXT NOT NULL DEFAULT '',
    tool_name         TEXT,
    tool_args         JSONB,
    tool_result       TEXT,
    metadata          JSONB DEFAULT '{}'::jsonb,
    embedding         halfvec(4000),
    content_tsv       tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
    access_count      INTEGER DEFAULT 0,
    last_accessed_at  TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    embed_failures    INTEGER DEFAULT 0,
    embed_error       TEXT,
    embed_status      TEXT
);

CREATE INDEX IF NOT EXISTS idx_ros_messages_conversation
    ON ros_messages (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ros_messages_agent
    ON ros_messages (agent, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ros_messages_created
    ON ros_messages (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ros_messages_fts
    ON ros_messages USING gin (content_tsv);
CREATE INDEX IF NOT EXISTS idx_ros_messages_trgm
    ON ros_messages USING gin (content gin_trgm_ops);
CREATE INDEX IF NOT EXISTS ros_messages_embedding_hnsw
    ON ros_messages USING hnsw (embedding halfvec_cosine_ops)
    WITH (m = 32, ef_construction = 120);

-- -----------------------------------------------------------------------------
-- ros_summaries — compacted summaries forming a DAG (parent_id)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ros_summaries (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id    UUID REFERENCES ros_conversations(id),
    parent_id          UUID REFERENCES ros_summaries(id),
    depth              INTEGER NOT NULL DEFAULT 0,
    content            TEXT NOT NULL,
    kind               TEXT NOT NULL DEFAULT 'leaf',
    message_count      INTEGER NOT NULL DEFAULT 0,
    earliest_at        TIMESTAMPTZ,
    latest_at          TIMESTAMPTZ,
    embedding          halfvec(4000),
    content_tsv        tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
    model              TEXT,
    access_count       INTEGER DEFAULT 0,
    last_accessed_at   TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    embed_failures     INTEGER DEFAULT 0,
    embed_error        TEXT,
    pipeline_version   INTEGER NOT NULL DEFAULT 1,
    embed_status       TEXT
);

CREATE INDEX IF NOT EXISTS idx_ros_summaries_parent
    ON ros_summaries (parent_id);
CREATE INDEX IF NOT EXISTS idx_ros_summaries_time
    ON ros_summaries (latest_at DESC);
CREATE INDEX IF NOT EXISTS idx_ros_summaries_fts
    ON ros_summaries USING gin (content_tsv);
CREATE INDEX IF NOT EXISTS idx_ros_summaries_pipeline_version
    ON ros_summaries (pipeline_version) WHERE pipeline_version < 5;
CREATE INDEX IF NOT EXISTS ros_summaries_embedding_hnsw
    ON ros_summaries USING hnsw (embedding halfvec_cosine_ops)
    WITH (m = 32, ef_construction = 120);

-- -----------------------------------------------------------------------------
-- ros_summary_sources — links summaries to their source messages
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ros_summary_sources (
    summary_id   UUID NOT NULL REFERENCES ros_summaries(id) ON DELETE CASCADE,
    message_id   UUID NOT NULL REFERENCES ros_messages(id) ON DELETE RESTRICT,
    ordinal      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (summary_id, message_id)
);

-- -----------------------------------------------------------------------------
-- ros_subagent_sessions — durable subagent sessions (the @rivetos/core worker)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ros_subagent_sessions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    parent_agent    TEXT NOT NULL,
    child_agent     TEXT NOT NULL,
    provider        TEXT NOT NULL,
    status          TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed','killed')),
    history         JSONB NOT NULL DEFAULT '[]'::jsonb,
    pending_message TEXT,
    iterations      INTEGER NOT NULL DEFAULT 0,
    tools_used      JSONB NOT NULL DEFAULT '[]'::jsonb,
    usage           JSONB,
    last_response   TEXT NOT NULL DEFAULT '',
    error           TEXT,
    model_override  TEXT,
    timeout_ms      INTEGER,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    duration_ms     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_ros_subagent_sessions_status
    ON ros_subagent_sessions (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ros_subagent_sessions_child_agent
    ON ros_subagent_sessions (child_agent, created_at DESC);

-- -----------------------------------------------------------------------------
-- ros_delegation_runs — delegation observability/audit log
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ros_delegation_runs (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    from_agent        TEXT NOT NULL,
    to_agent          TEXT NOT NULL,
    task              TEXT NOT NULL,
    model             TEXT,
    chain_depth       INTEGER NOT NULL DEFAULT 0,
    status            TEXT NOT NULL CHECK (status IN ('completed','failed','timeout','cached','blocked')),
    response          TEXT,
    iterations        INTEGER,
    prompt_tokens     INTEGER,
    completion_tokens INTEGER,
    tools_used        JSONB,
    duration_ms       INTEGER,
    cached            BOOLEAN NOT NULL DEFAULT false,
    started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ros_delegation_runs_from
    ON ros_delegation_runs (from_agent, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_ros_delegation_runs_to
    ON ros_delegation_runs (to_agent, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_ros_delegation_runs_started
    ON ros_delegation_runs (started_at DESC);

-- -----------------------------------------------------------------------------
-- Trigger Function: notify_embedding_queue
--
-- Fires on INSERT to ros_messages / ros_summaries. Enqueues a graphile-worker
-- 'embed-target' job for the new row (deduped by job_key). graphile_worker.*
-- is installed by the worker services; see the runtime note in the header.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION notify_embedding_queue() RETURNS trigger AS $func$
BEGIN
    IF NEW.content IS NOT NULL AND LENGTH(TRIM(NEW.content)) > 0 THEN
        PERFORM graphile_worker.add_job(
            'embed-target',
            json_build_object('targetTable', TG_TABLE_NAME, 'targetId', NEW.id),
            job_key      => 'embed-' || TG_TABLE_NAME || '-' || NEW.id::text,
            max_attempts => 5
        );
    END IF;
    RETURN NEW;
END;
$func$ LANGUAGE plpgsql;

-- -----------------------------------------------------------------------------
-- Embedding triggers (idempotent via DROP IF EXISTS + CREATE)
-- -----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_embed_message ON ros_messages;
CREATE TRIGGER trg_embed_message
    AFTER INSERT ON ros_messages
    FOR EACH ROW EXECUTE FUNCTION notify_embedding_queue();

DROP TRIGGER IF EXISTS trg_embed_summary ON ros_summaries;
CREATE TRIGGER trg_embed_summary
    AFTER INSERT ON ros_summaries
    FOR EACH ROW EXECUTE FUNCTION notify_embedding_queue();
