-- 0008_message_tool_result_search.sql
--
-- Include tool_result in message FTS so memory_search can find payloads that
-- live only on tool rows (content is often just "[tool] name").
--
-- Context (daily 2026-08-06): ~85k tool rows store the real payload in
-- tool_result while hybrid search floor excluded role='tool' and content_tsv
-- was generated from content alone. Browse (#437) already shows tool_result
-- previews; search still could not match error strings / IPs / command output
-- that only exist in tool_result.
--
-- Also add a partial gin_trgm index on tool_result so explicit trigram mode
-- can match without a sequential scan of the payload column.

-- Drop dependent GIN first (DROP COLUMN would cascade the index, but be explicit).
DROP INDEX IF EXISTS idx_ros_messages_fts;

ALTER TABLE ros_messages
  DROP COLUMN IF EXISTS content_tsv;

-- Cap inputs before to_tsvector: Postgres hard-limits tsvector at 1,048,575
-- bytes. Live phil_memory already has content up to ~900k chars; combining
-- uncapped content+tool_result leaves only ~4.5% headroom, so a future
-- insert would fail at capture time (GENERATED ALWAYS recomputes on write).
-- FTS lexemes past ~300KB of content have negligible recall; trigram/regex
-- still scan the full columns. Max live tool_result is ~27k, so 32k is safe.
ALTER TABLE ros_messages
  ADD COLUMN content_tsv tsvector
  GENERATED ALWAYS AS (
    to_tsvector(
      'english',
      left(coalesce(content, ''), 300000) || ' ' || left(coalesce(tool_result, ''), 32768)
    )
  ) STORED;

CREATE INDEX idx_ros_messages_fts
  ON ros_messages USING gin (content_tsv);

-- Partial trgm index: only rows that actually carry a tool payload.
CREATE INDEX IF NOT EXISTS idx_ros_messages_tool_result_trgm
  ON ros_messages USING gin (tool_result gin_trgm_ops)
  WHERE tool_result IS NOT NULL AND length(tool_result) > 0;
