#!/bin/bash
set -e

# ===========================================================================
# RivetOS — Datahub Database Initialization
#
# Creates extensions, queue tables, trigger functions, and triggers.
# Runs only on first database initialization (idempotent — safe to re-run).
# ===========================================================================

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-'EOSQL'

    -- -----------------------------------------------------------------------
    -- Extensions
    -- -----------------------------------------------------------------------

    CREATE EXTENSION IF NOT EXISTS vector;
    CREATE EXTENSION IF NOT EXISTS pg_trgm;

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

echo "[RivetOS] Database initialized with pgvector, pg_trgm, queue tables, and triggers."
