#!/bin/bash
set -e

# ===========================================================================
# RivetOS — Datahub Database Initialization
#
# Creates extensions, core ros_* tables, queue tables, trigger functions,
# and triggers. Runs on first database initialization (idempotent — safe
# to re-run; every CREATE uses IF NOT EXISTS).
#
# Schema source of truth: docs/MEMORY-DESIGN.md
# Mirrors the live CT110 schema as of 2026-04-26.
# ===========================================================================

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-'EOSQL'

    -- -----------------------------------------------------------------------
    -- Extensions
    -- -----------------------------------------------------------------------

    CREATE EXTENSION IF NOT EXISTS vector;
    CREATE EXTENSION IF NOT EXISTS pg_trgm;

    -- -----------------------------------------------------------------------
    -- ros_conversations — sessions, grouped by channel/agent with settings
    -- -----------------------------------------------------------------------

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

    -- -----------------------------------------------------------------------
    -- ros_messages — immutable transcript with tool data, embeddings,
    -- and access tracking
    -- -----------------------------------------------------------------------

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

    -- -----------------------------------------------------------------------
    -- ros_summaries — compacted summaries forming a DAG (parent_id)
    -- -----------------------------------------------------------------------

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

    -- -----------------------------------------------------------------------
    -- ros_summary_sources — links summaries to their source messages
    -- -----------------------------------------------------------------------

    CREATE TABLE IF NOT EXISTS ros_summary_sources (
        summary_id   UUID NOT NULL REFERENCES ros_summaries(id) ON DELETE CASCADE,
        message_id   UUID NOT NULL REFERENCES ros_messages(id) ON DELETE RESTRICT,
        ordinal      INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (summary_id, message_id)
    );

    -- -----------------------------------------------------------------------
    -- ros_tool_synth_queue — async queue for synthesizing natural-language
    -- content for assistant tool-call messages with empty content (v5)
    -- -----------------------------------------------------------------------

    CREATE TABLE IF NOT EXISTS ros_tool_synth_queue (
        message_id        UUID PRIMARY KEY REFERENCES ros_messages(id) ON DELETE CASCADE,
        enqueued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        attempts          INTEGER NOT NULL DEFAULT 0,
        last_error        TEXT,
        last_attempt_at   TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS idx_tool_synth_queue_enqueued
        ON ros_tool_synth_queue (enqueued_at);

    -- -----------------------------------------------------------------------
    -- Embedding Queue — event-driven embedding via Nemotron GPU
    --
    -- Populated by triggers on ros_messages and ros_summaries INSERT.
    -- Consumed by the embedding-worker service via LISTEN/NOTIFY.
    -- -----------------------------------------------------------------------

    CREATE TABLE IF NOT EXISTS ros_embedding_queue (
        id           BIGSERIAL    PRIMARY KEY,
        target_table TEXT         NOT NULL,        -- 'ros_messages' or 'ros_summaries'
        target_id    UUID         NOT NULL,
        created_at   TIMESTAMPTZ  DEFAULT now(),
        attempts     INTEGER      DEFAULT 0,
        last_error   TEXT
    );

    -- Prevent duplicate queue entries for the same row
    CREATE UNIQUE INDEX IF NOT EXISTS idx_embedding_queue_unique
        ON ros_embedding_queue (target_table, target_id);

    -- Worker picks oldest pending items first
    CREATE INDEX IF NOT EXISTS idx_embedding_queue_pending
        ON ros_embedding_queue (created_at);

    -- -----------------------------------------------------------------------
    -- Compaction Queue — event-driven summarization via E2B CPU
    --
    -- Populated by:
    --   1. Trigger on ros_messages INSERT (threshold-based)
    --   2. Periodic idle session check (enqueue_idle_sessions function)
    --   3. Explicit agent requests (direct INSERT)
    --
    -- Consumed by the compaction-worker service via LISTEN/NOTIFY.
    -- -----------------------------------------------------------------------

    CREATE TABLE IF NOT EXISTS ros_compaction_queue (
        id              BIGSERIAL    PRIMARY KEY,
        conversation_id UUID         NOT NULL,
        trigger_type    TEXT         NOT NULL,       -- 'threshold', 'session_idle', 'explicit'
        status          TEXT         DEFAULT 'pending',  -- 'pending', 'processing', 'done', 'failed'
        locked_at       TIMESTAMPTZ,
        attempts        INTEGER      DEFAULT 0,
        last_error      TEXT,
        created_at      TIMESTAMPTZ  DEFAULT now()
    );

    -- Only one pending/processing entry per conversation at a time
    CREATE UNIQUE INDEX IF NOT EXISTS idx_compaction_queue_conv_pending
        ON ros_compaction_queue (conversation_id)
        WHERE status IN ('pending', 'processing');

    -- Worker picks oldest pending items first
    CREATE INDEX IF NOT EXISTS idx_compaction_queue_pending
        ON ros_compaction_queue (status, created_at)
        WHERE status = 'pending';

    -- -----------------------------------------------------------------------
    -- Trigger Function: notify_embedding_queue
    --
    -- Fires on INSERT to ros_messages and ros_summaries.
    -- Enqueues the new row for embedding and sends NOTIFY to wake the worker.
    -- -----------------------------------------------------------------------

    CREATE OR REPLACE FUNCTION notify_embedding_queue() RETURNS trigger AS $$
    BEGIN
        -- Only enqueue if content is non-trivial (skip empty/short messages)
        IF NEW.content IS NOT NULL AND LENGTH(NEW.content) > 20 THEN
            INSERT INTO ros_embedding_queue (target_table, target_id)
            VALUES (TG_TABLE_NAME, NEW.id)
            ON CONFLICT (target_table, target_id) DO NOTHING;
            PERFORM pg_notify('embedding_work', TG_TABLE_NAME || ':' || NEW.id::text);
        END IF;
        RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    -- -----------------------------------------------------------------------
    -- Trigger Function: check_compaction_threshold
    --
    -- Fires on INSERT to ros_messages.
    -- Counts unsummarized messages for the conversation; if >= threshold,
    -- enqueues the conversation for compaction.
    -- -----------------------------------------------------------------------

    CREATE OR REPLACE FUNCTION check_compaction_threshold() RETURNS trigger AS $$
    DECLARE
        unsummarized_count INTEGER;
        threshold INTEGER := 50;
    BEGIN
        -- Count unsummarized messages for this conversation
        SELECT COUNT(*) INTO unsummarized_count
        FROM ros_messages m
        LEFT JOIN ros_summary_sources ss ON ss.message_id = m.id
        WHERE m.conversation_id = NEW.conversation_id
          AND ss.summary_id IS NULL
          AND m.content IS NOT NULL
          AND LENGTH(m.content) > 10;

        -- If threshold reached, enqueue compaction
        IF unsummarized_count >= threshold THEN
            INSERT INTO ros_compaction_queue (conversation_id, trigger_type)
            VALUES (NEW.conversation_id, 'threshold')
            ON CONFLICT (conversation_id) WHERE status IN ('pending', 'processing')
            DO NOTHING;
            PERFORM pg_notify('compaction_work', NEW.conversation_id::text);
        END IF;

        RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    -- -----------------------------------------------------------------------
    -- Function: enqueue_idle_sessions
    --
    -- Called periodically by the compaction worker (every 5 min).
    -- Finds conversations that have been idle for N minutes and have
    -- unsummarized messages, then enqueues them for compaction.
    -- -----------------------------------------------------------------------

    CREATE OR REPLACE FUNCTION enqueue_idle_sessions(
        idle_minutes INTEGER DEFAULT 15,
        min_unsummarized INTEGER DEFAULT 10
    ) RETURNS INTEGER AS $$
    DECLARE
        enqueued INTEGER := 0;
        conv_row RECORD;
    BEGIN
        FOR conv_row IN
            SELECT c.id AS conversation_id, COUNT(m.id) AS unsummarized
            FROM ros_conversations c
            JOIN ros_messages m ON m.conversation_id = c.id
            LEFT JOIN ros_summary_sources ss ON ss.message_id = m.id
            WHERE c.updated_at < NOW() - (idle_minutes || ' minutes')::interval
              AND ss.summary_id IS NULL
              AND m.content IS NOT NULL
              AND LENGTH(m.content) > 10
              AND NOT EXISTS (
                  SELECT 1 FROM ros_compaction_queue q
                  WHERE q.conversation_id = c.id
                    AND q.status IN ('pending', 'processing')
              )
            GROUP BY c.id
            HAVING COUNT(m.id) >= min_unsummarized
            ORDER BY c.updated_at ASC
            LIMIT 10
        LOOP
            INSERT INTO ros_compaction_queue (conversation_id, trigger_type)
            VALUES (conv_row.conversation_id, 'session_idle')
            ON CONFLICT (conversation_id) WHERE status IN ('pending', 'processing')
            DO NOTHING;
            PERFORM pg_notify('compaction_work', conv_row.conversation_id::text);
            enqueued := enqueued + 1;
        END LOOP;

        RETURN enqueued;
    END;
    $$ LANGUAGE plpgsql;

    -- -----------------------------------------------------------------------
    -- Attach triggers to tables
    --
    -- Uses DROP IF EXISTS + CREATE to be idempotent.
    -- Triggers only fire on INSERT (not UPDATE/DELETE).
    -- -----------------------------------------------------------------------

    -- Embedding triggers
    DROP TRIGGER IF EXISTS trg_embed_message ON ros_messages;
    CREATE TRIGGER trg_embed_message
        AFTER INSERT ON ros_messages
        FOR EACH ROW EXECUTE FUNCTION notify_embedding_queue();

    DROP TRIGGER IF EXISTS trg_embed_summary ON ros_summaries;
    CREATE TRIGGER trg_embed_summary
        AFTER INSERT ON ros_summaries
        FOR EACH ROW EXECUTE FUNCTION notify_embedding_queue();

    -- Compaction threshold trigger
    DROP TRIGGER IF EXISTS trg_compact_threshold ON ros_messages;
    CREATE TRIGGER trg_compact_threshold
        AFTER INSERT ON ros_messages
        FOR EACH ROW EXECUTE FUNCTION check_compaction_threshold();

EOSQL

echo "[RivetOS] Database initialized: pgvector + pg_trgm extensions, core ros_* tables (conversations, messages, summaries, summary_sources, tool_synth_queue), queue tables (embedding, compaction), and triggers."
