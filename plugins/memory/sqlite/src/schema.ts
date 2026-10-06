/**
 * Phase-1 SQLite schema for the memory backend.
 *
 * Mirrors the postgres ros_conversations / ros_messages shape with TEXT
 * stand-ins for UUID/JSONB/timestamptz. FTS5 indexes content + tool_result
 * and stays in sync via AFTER INSERT/UPDATE/DELETE triggers on ros_messages.
 * Embedding work is queued in ros_jobs and drained by the in-process runner
 * (jobs.ts); vectors are stored on the row (vectors.ts).
 *
 * SCHEMA_VERSION is stamped with PRAGMA user_version after apply. Bump it
 * when adding columns/tables and extend migrateSchema()'s switch.
 */

/** Current on-disk schema version. Bump when the DDL changes. */
export const SCHEMA_VERSION = 7

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS ros_conversations (
    id            TEXT PRIMARY KEY,
    session_key   TEXT NOT NULL,
    agent         TEXT NOT NULL,
    channel       TEXT NOT NULL DEFAULT 'unknown',
    channel_id    TEXT,
    bot_identity  TEXT,
    title         TEXT,
    settings      TEXT NOT NULL DEFAULT '{}',
    active        INTEGER NOT NULL DEFAULT 1,
    task_id       TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    -- v6: whose conversation this is (the user this store belongs to).
    owner_user_id TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ros_conversations_session_agent
    ON ros_conversations (session_key, agent);
CREATE INDEX IF NOT EXISTS idx_ros_conversations_session
    ON ros_conversations (session_key, active, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_ros_conversations_agent
    ON ros_conversations (agent, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_ros_conversations_task
    ON ros_conversations (task_id) WHERE task_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS ros_messages (
    id                TEXT PRIMARY KEY,
    conversation_id   TEXT NOT NULL REFERENCES ros_conversations(id) ON DELETE CASCADE,
    agent             TEXT NOT NULL,
    channel           TEXT NOT NULL,
    role              TEXT NOT NULL CHECK (role IN ('system','user','assistant','tool')),
    content           TEXT NOT NULL DEFAULT '',
    tool_name         TEXT,
    tool_args         TEXT,
    tool_result       TEXT,
    metadata          TEXT NOT NULL DEFAULT '{}',
    access_count      INTEGER NOT NULL DEFAULT 0,
    last_accessed_at  TEXT,
    created_at        TEXT NOT NULL,
    embed_status      TEXT,
    -- v3: the vector itself (little-endian float32, L2-normalized) and why
    -- the last attempt failed. See vectors.ts / embed.ts.
    embedding         BLOB,
    embed_error       TEXT,
    embed_failures    INTEGER NOT NULL DEFAULT 0,
    -- v6: who this row belongs to (the user this store is for).
    owner_user_id     TEXT
);
CREATE INDEX IF NOT EXISTS idx_ros_messages_conversation
    ON ros_messages (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ros_messages_agent
    ON ros_messages (agent, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ros_messages_created
    ON ros_messages (created_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS ros_messages_fts USING fts5(
    id UNINDEXED,
    content,
    tool_result,
    tokenize = 'porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS ros_messages_ai AFTER INSERT ON ros_messages BEGIN
  INSERT INTO ros_messages_fts(id, content, tool_result)
  VALUES (new.id, new.content, coalesce(new.tool_result, ''));
END;
CREATE TRIGGER IF NOT EXISTS ros_messages_ad AFTER DELETE ON ros_messages BEGIN
  DELETE FROM ros_messages_fts WHERE id = old.id;
END;
CREATE TRIGGER IF NOT EXISTS ros_messages_au AFTER UPDATE OF content, tool_result, id ON ros_messages BEGIN
  DELETE FROM ros_messages_fts WHERE id = old.id;
  INSERT INTO ros_messages_fts(id, content, tool_result)
  VALUES (new.id, new.content, coalesce(new.tool_result, ''));
END;

-- v3: the in-process job queue (jobs.ts). One row per pending unit of work;
-- job_key dedupes ("embed this row" is queued once). A finished job is
-- deleted, a job out of attempts stays as 'dead'.
CREATE TABLE IF NOT EXISTS ros_jobs (
    id            TEXT PRIMARY KEY NOT NULL,
    task          TEXT NOT NULL,
    job_key       TEXT UNIQUE,
    payload       TEXT NOT NULL DEFAULT 'null',
    run_at        TEXT NOT NULL,
    attempts      INTEGER NOT NULL DEFAULT 0,
    max_attempts  INTEGER NOT NULL DEFAULT 5,
    state         TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'dead')),
    last_error    TEXT,
    locked_at     TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ros_jobs_due
    ON ros_jobs (state, run_at);

-- v3: small key/value facts about the store (which embedding model wrote the
-- vectors, and how wide they are).
CREATE TABLE IF NOT EXISTS ros_meta (
    key    TEXT PRIMARY KEY NOT NULL,
    value  TEXT NOT NULL
);

-- Phase-1 queue, superseded by ros_jobs in v3. Kept so a v1/v2 file opens;
-- its rows are moved into ros_jobs by the v2 → v3 migration.
CREATE TABLE IF NOT EXISTS ros_embed_queue (
    id          TEXT PRIMARY KEY,
    message_id  TEXT NOT NULL UNIQUE REFERENCES ros_messages(id) ON DELETE CASCADE,
    enqueued_at TEXT NOT NULL,
    attempts    INTEGER NOT NULL DEFAULT 0,
    last_error  TEXT
);
CREATE INDEX IF NOT EXISTS idx_ros_embed_queue_enqueued
    ON ros_embed_queue (enqueued_at);

-- v4: summaries (mirror of the postgres ros_summaries / ros_summary_sources).
-- A leaf covers a batch of messages (ros_summary_sources); a branch covers
-- leaves and a root covers branches, linked through parent_id. Written by
-- compaction.ts; searched through ros_summaries_fts and the stored vector.
CREATE TABLE IF NOT EXISTS ros_summaries (
    id                TEXT PRIMARY KEY NOT NULL,
    conversation_id   TEXT REFERENCES ros_conversations(id) ON DELETE CASCADE,
    parent_id         TEXT REFERENCES ros_summaries(id) ON DELETE SET NULL,
    depth             INTEGER NOT NULL DEFAULT 0,
    content           TEXT NOT NULL,
    kind              TEXT NOT NULL DEFAULT 'leaf',
    message_count     INTEGER NOT NULL DEFAULT 0,
    earliest_at       TEXT,
    latest_at         TEXT,
    model             TEXT,
    pipeline_version  INTEGER NOT NULL DEFAULT 1,
    access_count      INTEGER NOT NULL DEFAULT 0,
    last_accessed_at  TEXT,
    created_at        TEXT NOT NULL,
    embed_status      TEXT,
    embedding         BLOB,
    embed_error       TEXT,
    embed_failures    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ros_summaries_conversation
    ON ros_summaries (conversation_id, kind, created_at);
CREATE INDEX IF NOT EXISTS idx_ros_summaries_parent
    ON ros_summaries (parent_id);
CREATE INDEX IF NOT EXISTS idx_ros_summaries_time
    ON ros_summaries (latest_at DESC);

CREATE TABLE IF NOT EXISTS ros_summary_sources (
    summary_id  TEXT NOT NULL REFERENCES ros_summaries(id) ON DELETE CASCADE,
    message_id  TEXT NOT NULL REFERENCES ros_messages(id) ON DELETE CASCADE,
    ordinal     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (summary_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_ros_summary_sources_message
    ON ros_summary_sources (message_id);

CREATE VIRTUAL TABLE IF NOT EXISTS ros_summaries_fts USING fts5(
    id UNINDEXED,
    content,
    tokenize = 'porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS ros_summaries_ai AFTER INSERT ON ros_summaries BEGIN
  INSERT INTO ros_summaries_fts(id, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS ros_summaries_ad AFTER DELETE ON ros_summaries BEGIN
  DELETE FROM ros_summaries_fts WHERE id = old.id;
END;
CREATE TRIGGER IF NOT EXISTS ros_summaries_au AFTER UPDATE OF content, id ON ros_summaries BEGIN
  DELETE FROM ros_summaries_fts WHERE id = old.id;
  INSERT INTO ros_summaries_fts(id, content) VALUES (new.id, new.content);
END;

-- Session + summary tags (mirror of postgres 0019_tags.sql, same CHECKs).
-- entity_id is polymorphic, so no FK. Phase 1 has no ros_summaries table
-- here: entity_type 'summary' is accepted for parity but nothing backs it
-- until summaries land in SQLite. Reads and writes are in tags.ts. aliases is a JSON array in TEXT, and
-- created_at / updated_at have no DEFAULT (like every table here, the writer
-- supplies ISO timestamps) where postgres defaults to now(). See
-- packages/types/src/tags.ts for the lifecycle.
CREATE TABLE IF NOT EXISTS ros_tags (
    id            TEXT PRIMARY KEY NOT NULL,
    entity_type   TEXT NOT NULL CHECK (entity_type IN ('conversation', 'summary')),
    entity_id     TEXT NOT NULL,
    key           TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 64 AND key NOT LIKE '%:%'),
    value         TEXT NOT NULL CHECK (length(value) BETWEEN 1 AND 128),
    display       TEXT NOT NULL DEFAULT '',
    source        TEXT NOT NULL,
    state         TEXT NOT NULL,
    confidence    REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    proposed_by   TEXT NOT NULL DEFAULT '',
    reason        TEXT NOT NULL DEFAULT '',
    decided_by    TEXT,
    decided_at    TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    -- v7: a model may suggest removing an accepted tag. NULL until then.
    -- The partial index is created after migrateSchema: an older file does
    -- not have the column until that migration runs.
    removal_state  TEXT CHECK (removal_state IS NULL OR removal_state IN ('suggested', 'rejected')),
    removal_reason TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ros_tags_entity_kv
    ON ros_tags (entity_type, entity_id, key, value);
CREATE INDEX IF NOT EXISTS idx_ros_tags_kv_state
    ON ros_tags (key, value, state);
CREATE INDEX IF NOT EXISTS idx_ros_tags_pending
    ON ros_tags (created_at DESC) WHERE state = 'suggested';

CREATE TABLE IF NOT EXISTS ros_tag_taxonomy (
    key           TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 64 AND key NOT LIKE '%:%'),
    value         TEXT NOT NULL CHECK (length(value) BETWEEN 1 AND 128),
    display       TEXT NOT NULL DEFAULT '',
    parent_value  TEXT CHECK (parent_value IS NULL OR length(parent_value) BETWEEN 1 AND 128),
    aliases       TEXT NOT NULL DEFAULT '[]',
    state         TEXT NOT NULL DEFAULT 'accepted',
    source        TEXT NOT NULL DEFAULT 'user',
    reason        TEXT NOT NULL DEFAULT '',
    decided_at    TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    PRIMARY KEY (key, value),
    CHECK (parent_value IS NULL OR parent_value <> value)
);
CREATE INDEX IF NOT EXISTS idx_ros_tag_taxonomy_parent
    ON ros_tag_taxonomy (key, parent_value);

-- v5: the wiki index. Page content lives in git-backed files under the wiki
-- directory; these tables are the search, provenance and idempotency index
-- over them. List columns (aliases, tags, entities, related, topics_touched)
-- hold JSON arrays.
CREATE TABLE IF NOT EXISTS ros_wiki_topics (
    slug              TEXT PRIMARY KEY NOT NULL,
    title             TEXT NOT NULL,
    aliases           TEXT NOT NULL DEFAULT '[]',
    tags              TEXT NOT NULL DEFAULT '[]',
    entities          TEXT NOT NULL DEFAULT '[]',
    related           TEXT NOT NULL DEFAULT '[]',
    current_state     TEXT NOT NULL DEFAULT '',
    article           TEXT NOT NULL DEFAULT '',
    search_text       TEXT NOT NULL DEFAULT '',
    history_count     INTEGER NOT NULL DEFAULT 0,
    git_sha           TEXT,
    last_verified_at  TEXT,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    embed_status      TEXT,
    embedding         BLOB,
    embed_error       TEXT,
    embed_failures    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ros_wiki_topics_updated
    ON ros_wiki_topics (updated_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS ros_wiki_topics_fts USING fts5(
    slug UNINDEXED,
    search_text,
    tokenize = 'porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS ros_wiki_topics_ai AFTER INSERT ON ros_wiki_topics BEGIN
    INSERT INTO ros_wiki_topics_fts (slug, search_text) VALUES (new.slug, new.search_text);
END;
CREATE TRIGGER IF NOT EXISTS ros_wiki_topics_ad AFTER DELETE ON ros_wiki_topics BEGIN
    DELETE FROM ros_wiki_topics_fts WHERE slug = old.slug;
END;
CREATE TRIGGER IF NOT EXISTS ros_wiki_topics_au AFTER UPDATE OF search_text ON ros_wiki_topics BEGIN
    DELETE FROM ros_wiki_topics_fts WHERE slug = old.slug;
    INSERT INTO ros_wiki_topics_fts (slug, search_text) VALUES (new.slug, new.search_text);
END;

CREATE TABLE IF NOT EXISTS ros_wiki_provenance (
    topic_slug       TEXT NOT NULL REFERENCES ros_wiki_topics(slug) ON DELETE CASCADE,
    source_kind      TEXT NOT NULL CHECK (source_kind IN ('summary', 'message', 'conversation', 'task')),
    source_id        TEXT NOT NULL,
    conversation_id  TEXT,
    git_sha          TEXT,
    created_at       TEXT NOT NULL,
    PRIMARY KEY (topic_slug, source_kind, source_id)
);

CREATE TABLE IF NOT EXISTS ros_wiki_extractions (
    summary_id        TEXT PRIMARY KEY NOT NULL REFERENCES ros_summaries(id) ON DELETE CASCADE,
    status            TEXT NOT NULL CHECK (status IN ('done', 'skipped', 'failed')),
    pipeline_version  INTEGER NOT NULL,
    topics_touched    TEXT NOT NULL DEFAULT '[]',
    git_sha           TEXT,
    error             TEXT,
    extracted_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ros_wiki_citations (
    topic_slug  TEXT NOT NULL REFERENCES ros_wiki_topics(slug) ON DELETE CASCADE,
    summary_id  TEXT NOT NULL,
    kind        TEXT,
    note        TEXT,
    cited_at    TEXT NOT NULL,
    PRIMARY KEY (topic_slug, summary_id)
);

CREATE TABLE IF NOT EXISTS ros_wiki_redirects (
    from_slug   TEXT PRIMARY KEY NOT NULL,
    to_slug     TEXT NOT NULL REFERENCES ros_wiki_topics(slug) ON DELETE CASCADE,
    created_at  TEXT NOT NULL
);
`
