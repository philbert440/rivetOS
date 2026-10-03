-- =============================================================================
-- 0019_tags.sql — key:value tags on sessions and summaries, plus the taxonomy.
--
-- a. ros_tags: one row per (entity, key, value). `entity_type` is
--    'conversation' or 'summary'; `entity_id` points at ros_conversations.id
--    or ros_summaries.id. No foreign key on purpose — the column is
--    polymorphic. Rows whose entity is gone are reaped by the compaction
--    worker's hourly reap task (reapOrphanTagsSql, added with the tagger service), and readers that join
--    the entity filter orphans out. `state` is the review loop: a tagger
--    (rule or model) inserts `suggested`, a user flips it to `accepted` or
--    `rejected`. Rejected rows are kept: every tagger writes with
--    ON CONFLICT DO NOTHING against the unique index, so a rejected tag is
--    never proposed twice. `value` is the normalized slug (NFKC, lowercased,
--    see normalizeTagValue); `display` keeps the first-seen casing for the
--    UI and is never a lookup key.
--
-- b. ros_tag_taxonomy: the vocabulary. One row per (key, value), optional
--    `parent_value` under the same key (a tree, not a DAG: flat until a tag
--    earns nesting). The CHECK rules out self-parenting; longer cycles are
--    refused by the writer (upsertTaxonomy, added with the tag routes, walks the
--    ancestors and requires the parent to exist). `aliases` holds values merged into this one so old tags
--    keep resolving. Consolidation and hierarchy proposals from the tagger
--    land here as `suggested` rows and go through the same review loop.
--
-- Session tags are inherited by summaries at read time via
-- ros_summaries.conversation_id; a summary row in ros_tags is a tag that
-- applies to that summary only.
--
-- CHECKs cover only what is closed or structural: entity_type (two kinds of
-- entity exist; a typo would write rows no query finds), key/value length
-- (the btrees reject oversized tuples with 54000 — bound key, value and
-- parent_value up front), no ':' in a key (it separates key from value in a
-- literal), confidence in 0..1, and self-parenting. `source` and `state` stay open text: a new tagger or
-- review state must not require a migration. No triggers. Idempotent
-- (IF NOT EXISTS). PGlite-safe.
-- =============================================================================

CREATE TABLE IF NOT EXISTS ros_tags (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_type   TEXT NOT NULL CHECK (entity_type IN ('conversation', 'summary')),
    entity_id     UUID NOT NULL,
    key           TEXT NOT NULL CHECK (char_length(key) BETWEEN 1 AND 64 AND key NOT LIKE '%:%'),
    value         TEXT NOT NULL CHECK (char_length(value) BETWEEN 1 AND 128),
    display       TEXT NOT NULL DEFAULT '',
    source        TEXT NOT NULL,
    state         TEXT NOT NULL,
    confidence    DOUBLE PRECISION CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    proposed_by   TEXT NOT NULL DEFAULT '',
    reason        TEXT NOT NULL DEFAULT '',
    decided_by    TEXT,
    decided_at    TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ros_tags_entity_kv
    ON ros_tags (entity_type, entity_id, key, value);
CREATE INDEX IF NOT EXISTS idx_ros_tags_kv_state
    ON ros_tags (key, value, state);
CREATE INDEX IF NOT EXISTS idx_ros_tags_pending
    ON ros_tags (created_at DESC) WHERE state = 'suggested';

CREATE TABLE IF NOT EXISTS ros_tag_taxonomy (
    key           TEXT NOT NULL CHECK (char_length(key) BETWEEN 1 AND 64 AND key NOT LIKE '%:%'),
    value         TEXT NOT NULL CHECK (char_length(value) BETWEEN 1 AND 128),
    display       TEXT NOT NULL DEFAULT '',
    parent_value  TEXT CHECK (parent_value IS NULL OR char_length(parent_value) BETWEEN 1 AND 128),
    aliases       TEXT[] NOT NULL DEFAULT '{}',
    state         TEXT NOT NULL DEFAULT 'accepted',
    source        TEXT NOT NULL DEFAULT 'user',
    reason        TEXT NOT NULL DEFAULT '',
    decided_at    TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (key, value),
    CHECK (parent_value IS NULL OR parent_value <> value)
);
CREATE INDEX IF NOT EXISTS idx_ros_tag_taxonomy_parent
    ON ros_tag_taxonomy (key, parent_value);
