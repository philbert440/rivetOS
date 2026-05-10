-- =============================================================================
-- 0002_graphile_worker_enqueue.sql — switch to graphile-worker's job table
--
-- Replaces the bespoke ros_compaction_queue / ros_embedding_queue / ros_tool_synth_queue
-- tables and their LISTEN/NOTIFY channels with direct graphile_worker.add_job calls
-- from triggers. The graphile-worker runner in services/{compaction,embedding}-worker
-- consumes those jobs and applies its own retry/locking/dedup semantics.
--
-- Prerequisites: this migration must run AFTER graphile-worker has installed its
-- own schema (`graphile_worker.add_job(...)` must exist). The application boot
-- sequence is responsible for ordering — graphile_worker installs lazily on first
-- runner.run() in the worker services. Until both worker services have been
-- started at least once, this migration's triggers will fail.
--
-- For staging cutover and prod cutover: start the worker services BEFORE
-- applying this migration. Their first connection installs graphile_worker.*
-- functions, after which this migration is safe to run.
-- =============================================================================

DO $$
DECLARE
    fn_signature text;
BEGIN
    -- -----------------------------------------------------------------------
    -- Sanity check — graphile_worker.add_job must exist
    -- -----------------------------------------------------------------------
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'graphile_worker' AND p.proname = 'add_job'
    ) THEN
        RAISE EXCEPTION 'graphile_worker.add_job() not found — start the worker services before applying migration 0002';
    END IF;

    -- -----------------------------------------------------------------------
    -- Ownership reassignment — handle prod-shape dumps
    --
    -- When restoring a pg_dump produced under a different role (typically
    -- dumps loaded by `postgres` superuser end up with `postgres` as the
    -- function owner), CREATE OR REPLACE FUNCTION below will fail with
    -- "must be owner of function". Try to take ownership; warn on failure
    -- so the operator can run the equivalent REASSIGN as a superuser.
    -- -----------------------------------------------------------------------
    FOR fn_signature IN
        SELECT format('%I.%I(%s)', n.nspname, p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid))
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        JOIN pg_authid a ON a.oid = p.proowner
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'graphile_worker')
          AND p.proname IN ('notify_embedding_queue', 'check_compaction_threshold', 'enqueue_idle_sessions')
          AND a.rolname IS DISTINCT FROM CURRENT_USER
    LOOP
        BEGIN
            EXECUTE format('ALTER FUNCTION %s OWNER TO CURRENT_USER', fn_signature);
            RAISE NOTICE 'Reassigned ownership of % to %', fn_signature, CURRENT_USER;
        EXCEPTION WHEN insufficient_privilege THEN
            RAISE WARNING 'Cannot reassign ownership of % to %. Run as a superuser: REASSIGN OWNED BY <prior_owner> TO %;', fn_signature, CURRENT_USER, CURRENT_USER;
        END;
    END LOOP;

    -- -----------------------------------------------------------------------
    -- Trigger Function: notify_embedding_queue
    --
    -- Replaces the previous version that wrote to ros_embedding_queue.
    -- Now enqueues a graphile-worker 'embed-target' job per row, with a
    -- dedup key so duplicate enqueues for the same row are coalesced.
    -- -----------------------------------------------------------------------
    CREATE OR REPLACE FUNCTION notify_embedding_queue() RETURNS trigger AS $func$
    BEGIN
        IF NEW.content IS NOT NULL AND LENGTH(NEW.content) > 20 THEN
            PERFORM graphile_worker.add_job(
                'embed-target',
                json_build_object('targetTable', TG_TABLE_NAME, 'targetId', NEW.id),
                job_key := 'embed-' || TG_TABLE_NAME || '-' || NEW.id::text,
                job_key_mode := 'preserve_run_at',
                max_attempts := 3
            );
        END IF;
        RETURN NEW;
    END;
    $func$ LANGUAGE plpgsql;

    -- -----------------------------------------------------------------------
    -- Trigger Function: check_compaction_threshold
    --
    -- Replaces the previous version that wrote to ros_compaction_queue.
    -- Now enqueues a graphile-worker 'compact-conversation' job when the
    -- conversation crosses the unsummarized-message threshold. Dedup via
    -- job_key=conversationId means at most one pending compaction per conv.
    -- -----------------------------------------------------------------------
    CREATE OR REPLACE FUNCTION check_compaction_threshold() RETURNS trigger AS $func$
    DECLARE
        unsummarized_count INTEGER;
        threshold INTEGER := 50;
    BEGIN
        SELECT COUNT(*) INTO unsummarized_count
        FROM ros_messages m
        LEFT JOIN ros_summary_sources ss ON ss.message_id = m.id
        WHERE m.conversation_id = NEW.conversation_id
          AND ss.summary_id IS NULL
          AND m.content IS NOT NULL
          AND LENGTH(m.content) > 10;

        IF unsummarized_count >= threshold THEN
            PERFORM graphile_worker.add_job(
                'compact-conversation',
                json_build_object('conversationId', NEW.conversation_id::text, 'triggerType', 'threshold'),
                job_key := NEW.conversation_id::text,
                job_key_mode := 'preserve_run_at',
                max_attempts := 3
            );
        END IF;

        RETURN NEW;
    END;
    $func$ LANGUAGE plpgsql;

    -- -----------------------------------------------------------------------
    -- Drop the bespoke queue tables and the helper SQL function
    --
    -- enqueue_idle_sessions() lives in TS now (services/compaction-worker
    -- enqueueIdleTask, scheduled by graphile-worker cron every 5 min).
    -- -----------------------------------------------------------------------
    DROP FUNCTION IF EXISTS enqueue_idle_sessions(INTEGER, INTEGER);
    DROP TABLE IF EXISTS ros_compaction_queue CASCADE;
    DROP TABLE IF EXISTS ros_embedding_queue CASCADE;
    DROP TABLE IF EXISTS ros_tool_synth_queue CASCADE;

    -- -----------------------------------------------------------------------
    -- Note: the existing triggers (trg_embed_message, trg_embed_summary,
    -- trg_compact_threshold) automatically use the new function bodies via
    -- CREATE OR REPLACE FUNCTION above. No trigger DROP/CREATE needed.
    -- -----------------------------------------------------------------------

END $$;
