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
export const SCHEMA_VERSION = 1

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
`
