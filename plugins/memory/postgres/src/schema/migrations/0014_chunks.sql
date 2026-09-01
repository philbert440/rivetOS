-- =============================================================================
-- 0014_chunks.sql — ros_message_chunks + content_hash + sibling embed trigger
--
-- Split from the former 0014_embedding_dims_and_chunks.sql so a refused
-- embedding-width ALTER (0015) cannot block this DDL. Per-user DBs that have
-- been capturing into halfvec(4000) still get the chunks table, trigger, and
-- content_hash; only the width recast is delayed.
--
-- a. ros_messages.content_hash TEXT — sha256 hex of composed embed text; the
--    worker skips delete-and-reinsert of chunks when it still matches.
--
-- b. ros_message_chunks: per-chunk content + halfvec(1024) for long messages.
--    Unique (message_id, idx); hnsw on embedding; btree on message_id.
--    char_start / char_end index the composed embed text (content + tool_result),
--    not ros_messages.content. M3b renders snippets from chunk.content.
--
-- c. Sibling trigger: a chunk row with NULL embedding enqueues embed-target
--    with targetTable='ros_message_chunks' (job_key embed-ros_message_chunks-<id>).
--    max_attempts => 5 is locked to embedding-worker config.sweepMaxAttempts
--    (EMBED_SWEEP_MAX_ATTEMPTS default 5). Same job_key as the unembedded
--    sweep, so trigger vs sweep dedupes.
--
-- Grants: not applied here (same as 0001). Ops bootstrap is
-- DEVICE_GROUP_GRANTS_SQL in services/den-server/src/devices.ts, which already
-- includes `GRANT SELECT ON ros_message_chunks TO rivet_device`. Devices do
-- not INSERT chunk rows (embedding-worker is the writer). Deployments that
-- ran the bootstrap SQL before this table existed still need a one-time:
--   GRANT SELECT ON ros_message_chunks TO rivet_device;
--
-- Idempotent: IF NOT EXISTS / CREATE OR REPLACE.
-- Schema-qualification-free (search_path), same as 0009–0013.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- a. content_hash for chunk-upsert idempotency
-- -----------------------------------------------------------------------------
ALTER TABLE ros_messages
    ADD COLUMN IF NOT EXISTS content_hash TEXT;

-- -----------------------------------------------------------------------------
-- b. ros_message_chunks
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ros_message_chunks (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id     UUID NOT NULL REFERENCES ros_messages(id) ON DELETE CASCADE,
    idx            INT NOT NULL,
    char_start     INT NOT NULL,
    char_end       INT NOT NULL,
    content        TEXT NOT NULL,
    embedding      halfvec(1024),
    embed_status   TEXT,
    embed_error    TEXT,
    embed_failures INT NOT NULL DEFAULT 0,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (message_id, idx)
);

-- Idempotent add for DBs that already created the table before these columns.
ALTER TABLE ros_message_chunks ADD COLUMN IF NOT EXISTS embed_status TEXT;
ALTER TABLE ros_message_chunks ADD COLUMN IF NOT EXISTS embed_error TEXT;
ALTER TABLE ros_message_chunks ADD COLUMN IF NOT EXISTS embed_failures INT NOT NULL DEFAULT 0;

COMMENT ON COLUMN ros_message_chunks.char_start IS 'offset into the composed embed text (content + tool_result), not ros_messages.content';
COMMENT ON COLUMN ros_message_chunks.char_end IS 'offset into the composed embed text (content + tool_result), not ros_messages.content';

CREATE INDEX IF NOT EXISTS ros_message_chunks_embedding_hnsw
    ON ros_message_chunks USING hnsw (embedding halfvec_cosine_ops)
    WITH (m = 32, ef_construction = 120);

CREATE INDEX IF NOT EXISTS idx_ros_message_chunks_message_id
    ON ros_message_chunks (message_id);

-- -----------------------------------------------------------------------------
-- c. Sibling trigger: enqueue embed-target for chunk rows without an embedding
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION notify_chunk_embedding_queue() RETURNS trigger AS $func$
BEGIN
    IF NEW.embedding IS NULL
       AND NEW.embed_status IS NULL
       AND NEW.content IS NOT NULL
       AND LENGTH(TRIM(NEW.content)) > 0 THEN
        PERFORM graphile_worker.add_job(
            'embed-target',
            json_build_object('targetTable', 'ros_message_chunks', 'targetId', NEW.id),
            job_key      => 'embed-ros_message_chunks-' || NEW.id::text,
            -- Lockstep with embedding-worker EMBED_SWEEP_MAX_ATTEMPTS / sweepMaxAttempts (default 5).
            max_attempts => 5
        );
    END IF;
    RETURN NEW;
END;
$func$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_embed_message_chunk ON ros_message_chunks;
CREATE TRIGGER trg_embed_message_chunk
    AFTER INSERT OR UPDATE OF embedding, content ON ros_message_chunks
    FOR EACH ROW
    WHEN (NEW.embedding IS NULL AND NEW.embed_status IS NULL)
    EXECUTE FUNCTION notify_chunk_embedding_queue();
