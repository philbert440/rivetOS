-- =============================================================================
-- 0007_wiki_article.sql — memory v7: Wikipedia-style Article + related graph
-- Design: /rivet-shared/plans/memory-v7-wikipedia-articles.md
-- Idempotent.
-- =============================================================================

ALTER TABLE ros_wiki_topics
    ADD COLUMN IF NOT EXISTS article TEXT NOT NULL DEFAULT '';

ALTER TABLE ros_wiki_topics
    ADD COLUMN IF NOT EXISTS related TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_ros_wiki_topics_related
    ON ros_wiki_topics USING gin (related);
