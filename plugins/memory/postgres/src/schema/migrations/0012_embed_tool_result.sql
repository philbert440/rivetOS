-- 0012_embed_tool_result.sql
--
-- Enqueue embeddings when tool_result carries the real payload.
--
-- Context (daily 2026-08-09): FTS/trigram already index tool_result (#440 /
-- migration 0008), but the insert trigger only looked at `content`. Tool rows
-- often store a short placeholder in content (`[tool] name`) with the real
-- text in tool_result — those rows were either never enqueued (content too
-- short after trim edge cases) or embedded as the placeholder alone, so the
-- hybrid vector arm stayed blind to tool payloads.
--
-- This replaces notify_embedding_queue() to fire when either content OR
-- tool_result is non-empty on ros_messages. Summaries still key on content
-- only (no tool_result column). The embedding worker composes both fields
-- at embed time (see services/embedding-worker composeMessageEmbedText).
--
-- Historical tool rows that already have a placeholder-only embedding are
-- NOT bulk-reset here (would spike the embed queue). Ops can re-queue with:
--   UPDATE ros_messages
--      SET embedding = NULL, embed_status = NULL, embed_error = NULL, embed_failures = 0
--    WHERE role = 'tool'
--      AND embedding IS NOT NULL
--      AND length(btrim(coalesce(tool_result, ''))) > 40
--      AND length(btrim(coalesce(content, ''))) < 80;

CREATE OR REPLACE FUNCTION notify_embedding_queue() RETURNS trigger AS $func$
BEGIN
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
