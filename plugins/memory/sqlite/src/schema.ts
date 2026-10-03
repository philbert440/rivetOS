/**
 * Phase-1 SQLite schema for the memory backend.
 *
 * Mirrors the postgres ros_conversations / ros_messages shape with TEXT
 * stand-ins for UUID/JSONB/timestamptz. FTS5 indexes content + tool_result
 * and stays in sync via AFTER INSERT/UPDATE/DELETE triggers on ros_messages.
 * ros_embed_queue is written on append for a later drain worker; phase 1
 * never reads it.
 *
 * SCHEMA_VERSION is stamped with PRAGMA user_version after apply. Bump it
 * when adding columns/tables and extend migrateSchema()'s switch.
 */

/** Current on-disk schema version. Bump when the DDL changes. */
export const SCHEMA_VERSION = 2

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
    updated_at    TEXT NOT NULL
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
    embed_status      TEXT
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

CREATE TABLE IF NOT EXISTS ros_embed_queue (
    id          TEXT PRIMARY KEY,
    message_id  TEXT NOT NULL UNIQUE REFERENCES ros_messages(id) ON DELETE CASCADE,
    enqueued_at TEXT NOT NULL,
    attempts    INTEGER NOT NULL DEFAULT 0,
    last_error  TEXT
);
CREATE INDEX IF NOT EXISTS idx_ros_embed_queue_enqueued
    ON ros_embed_queue (enqueued_at);

-- Session + summary tags (mirror of postgres 0019_tags.sql, same CHECKs).
-- entity_id is polymorphic, so no FK. Phase 1 has no ros_summaries table
-- here: entity_type 'summary' is accepted for parity but nothing backs it
-- until summaries land in SQLite. aliases is a JSON array in TEXT, and
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
    updated_at    TEXT NOT NULL
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
`
