-- 0016_defer_embed_enqueue.sql
--
-- Allow a writer to skip notify_embedding_queue()'s in-transaction
-- graphile_worker.add_job by SET LOCAL rivet.defer_embed_enqueue = on.
-- Compaction's summary INSERT used to fire embed-target inside the same
-- transaction that also locked ros_messages / ros_summaries — the pair
-- that deadlocked against the embedding worker (510 dead compact-conversation
-- jobs on phil_memory, 2026-09-01). The worker now defers the enqueue until
-- after COMMIT and calls add_job itself.
--
-- Custom GUC: current_setting(..., missing_ok=true) is NULL when unset, so
-- live capture INSERTs keep enqueueing as before.

CREATE OR REPLACE FUNCTION notify_embedding_queue() RETURNS trigger AS $func$
BEGIN
    IF current_setting('rivet.defer_embed_enqueue', true) = 'on' THEN
        RETURN NEW;
    END IF;

    IF TG_TABLE_NAME = 'ros_messages' THEN
        IF (NEW.content IS NOT NULL AND LENGTH(TRIM(NEW.content)) > 0)
           OR (NEW.tool_result IS NOT NULL AND LENGTH(TRIM(NEW.tool_result)) > 0) THEN
            PERFORM graphile_worker.add_job(
                'embed-target',
                json_build_object('targetTable', TG_TABLE_NAME, 'targetId', NEW.id),
                job_key      => 'embed-' || TG_TABLE_NAME || '-' || NEW.id::text,
                max_attempts => 5
            );
        END IF;
    ELSE
        -- ros_summaries (and any future content-only table using this trigger)
        IF NEW.content IS NOT NULL AND LENGTH(TRIM(NEW.content)) > 0 THEN
            PERFORM graphile_worker.add_job(
                'embed-target',
                json_build_object('targetTable', TG_TABLE_NAME, 'targetId', NEW.id),
                job_key      => 'embed-' || TG_TABLE_NAME || '-' || NEW.id::text,
                max_attempts => 5
            );
        END IF;
    END IF;
    RETURN NEW;
END;
$func$ LANGUAGE plpgsql;
