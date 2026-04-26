-- ─────────────────────────────────────────────────────────────────────────────
-- cleanup-embedder-dead-letter.sql
--
-- One-shot cleanup for the embedder dead-letter rows that accumulated before
-- the classifyUnembeddable() pre-filter and embed_status column landed.
--
-- What it does:
--   1. Mark known-unembeddable rows ('unembeddable' status, removed from queue)
--   2. Mark anything else over the failure threshold as 'failed'
--   3. Drop matching ros_embedding_queue rows so the worker stops retrying
--
-- Run as the rivetos DB user (or whatever owns the tables):
--
--   psql "$RIVETOS_PG_URL" -f scripts/cleanup-embedder-dead-letter.sql
--
-- Idempotent. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

\echo '-- before:'
SELECT
    'ros_messages' AS tbl,
    COUNT(*) FILTER (WHERE embedding IS NULL AND COALESCE(embed_failures,0) >= 3) AS dead,
    COUNT(*) FILTER (WHERE embed_status = 'unembeddable') AS unembeddable,
    COUNT(*) FILTER (WHERE embed_status = 'failed') AS failed
FROM ros_messages
UNION ALL
SELECT 'ros_summaries',
    COUNT(*) FILTER (WHERE embedding IS NULL AND COALESCE(embed_failures,0) >= 3),
    COUNT(*) FILTER (WHERE embed_status = 'unembeddable'),
    COUNT(*) FILTER (WHERE embed_status = 'failed')
FROM ros_summaries
UNION ALL
SELECT 'ros_embedding_queue',
    COUNT(*) FILTER (WHERE attempts >= 3),
    NULL, NULL
FROM ros_embedding_queue;

BEGIN;

-- Make sure the columns exist (idempotent — embedder also runs these on boot).
ALTER TABLE ros_messages  ADD COLUMN IF NOT EXISTS embed_status TEXT;
ALTER TABLE ros_summaries ADD COLUMN IF NOT EXISTS embed_status TEXT;

-- ─── Pattern definitions ────────────────────────────────────────────────────
--
-- These mirror classifyUnembeddable() in services/embedding-worker/classify.js.
-- Keep in sync.

-- 1. Media markers (case-insensitive, anchored at start after optional whitespace)
WITH unembeddable_msgs AS (
    SELECT id FROM ros_messages
    WHERE embedding IS NULL
      AND embed_status IS DISTINCT FROM 'unembeddable'
      AND (
            content ~* '^\s*\[media attached:'
         OR content ~* '^\s*MEDIA:'
         OR content ~* 'data:image/[a-z]+;base64,'
         OR content ~  'iVBORw0KGgo[A-Za-z0-9+/=]{200,}'
         OR content ~  '/9j/[A-Za-z0-9+/=]{500,}'
      )
)
UPDATE ros_messages m
SET embed_status = 'unembeddable',
    embed_error  = COALESCE(embed_error, 'unembeddable: cleanup-script media/base64 match')
FROM unembeddable_msgs u
WHERE m.id = u.id;

WITH unembeddable_sums AS (
    SELECT id FROM ros_summaries
    WHERE embedding IS NULL
      AND embed_status IS DISTINCT FROM 'unembeddable'
      AND (
            content ~* '^\s*\[media attached:'
         OR content ~* '^\s*MEDIA:'
         OR content ~* 'data:image/[a-z]+;base64,'
         OR content ~  'iVBORw0KGgo[A-Za-z0-9+/=]{200,}'
         OR content ~  '/9j/[A-Za-z0-9+/=]{500,}'
      )
)
UPDATE ros_summaries s
SET embed_status = 'unembeddable',
    embed_error  = COALESCE(embed_error, 'unembeddable: cleanup-script media/base64 match')
FROM unembeddable_sums u
WHERE s.id = u.id;

-- 2. Long unbroken base64-ish runs (>1500 chars of base64 alphabet, no whitespace).
--    Postgres regex doesn't have a great way to express ">95% base64 alphabet",
--    so the run-length signal alone is conservative enough.
UPDATE ros_messages
SET embed_status = 'unembeddable',
    embed_error  = COALESCE(embed_error, 'unembeddable: cleanup-script base64-blob')
WHERE embedding IS NULL
  AND embed_status IS DISTINCT FROM 'unembeddable'
  AND content ~ '[A-Za-z0-9+/]{1500,}';

UPDATE ros_summaries
SET embed_status = 'unembeddable',
    embed_error  = COALESCE(embed_error, 'unembeddable: cleanup-script base64-blob')
WHERE embedding IS NULL
  AND embed_status IS DISTINCT FROM 'unembeddable'
  AND content ~ '[A-Za-z0-9+/]{1500,}';

-- 3. Anything left that's hit the failure cap → flip to 'failed' so it drops
--    out of the eligible queue cleanly (instead of relying on a count-based
--    exclusion query alone).
UPDATE ros_messages
SET embed_status = 'failed'
WHERE embedding IS NULL
  AND COALESCE(embed_failures, 0) >= 3
  AND embed_status IS NULL;

UPDATE ros_summaries
SET embed_status = 'failed'
WHERE embedding IS NULL
  AND COALESCE(embed_failures, 0) >= 3
  AND embed_status IS NULL;

-- 4. Drop matching rows from ros_embedding_queue so the worker stops retrying.
--    Anything whose target row is now marked unembeddable or failed is junk.
DELETE FROM ros_embedding_queue q
USING ros_messages m
WHERE q.target_table = 'ros_messages'
  AND q.target_id = m.id
  AND m.embed_status IN ('unembeddable', 'failed');

DELETE FROM ros_embedding_queue q
USING ros_summaries s
WHERE q.target_table = 'ros_summaries'
  AND q.target_id = s.id
  AND s.embed_status IN ('unembeddable', 'failed');

-- 5. Belt-and-suspenders: any queue entry whose target_id no longer exists
--    in either source table (orphaned), drop it too.
DELETE FROM ros_embedding_queue q
WHERE q.target_table = 'ros_messages'
  AND NOT EXISTS (SELECT 1 FROM ros_messages m WHERE m.id = q.target_id);

DELETE FROM ros_embedding_queue q
WHERE q.target_table = 'ros_summaries'
  AND NOT EXISTS (SELECT 1 FROM ros_summaries s WHERE s.id = q.target_id);

COMMIT;

\echo '-- after:'
SELECT
    'ros_messages' AS tbl,
    COUNT(*) FILTER (WHERE embedding IS NULL AND COALESCE(embed_failures,0) >= 3) AS dead,
    COUNT(*) FILTER (WHERE embed_status = 'unembeddable') AS unembeddable,
    COUNT(*) FILTER (WHERE embed_status = 'failed') AS failed
FROM ros_messages
UNION ALL
SELECT 'ros_summaries',
    COUNT(*) FILTER (WHERE embedding IS NULL AND COALESCE(embed_failures,0) >= 3),
    COUNT(*) FILTER (WHERE embed_status = 'unembeddable'),
    COUNT(*) FILTER (WHERE embed_status = 'failed')
FROM ros_summaries
UNION ALL
SELECT 'ros_embedding_queue',
    COUNT(*) FILTER (WHERE attempts >= 3),
    NULL, NULL
FROM ros_embedding_queue;
