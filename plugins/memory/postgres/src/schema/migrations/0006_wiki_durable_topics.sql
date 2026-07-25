-- =============================================================================
-- 0006_wiki_durable_topics.sql — memory v6: citations + redirects for durable
-- topic identity. Design: /rivet-shared/plans/memory-v6-durable-topics.md
--
-- Content remains git-backed markdown; these tables index leaf citations and
-- slug redirects after consolidation merges near-duplicate topics.
-- Idempotent.
-- =============================================================================

-- Leaf (etc.) summary citations attached to a durable topic.
CREATE TABLE IF NOT EXISTS ros_wiki_citations (
    topic_slug   TEXT NOT NULL REFERENCES ros_wiki_topics(slug) ON DELETE CASCADE,
    summary_id   UUID NOT NULL,
    kind         TEXT,
    note         TEXT,
    cited_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (topic_slug, summary_id)
);

CREATE INDEX IF NOT EXISTS idx_ros_wiki_citations_summary
    ON ros_wiki_citations (summary_id);

-- After consolidation, loser slugs point at the canonical durable topic.
CREATE TABLE IF NOT EXISTS ros_wiki_redirects (
    from_slug    TEXT PRIMARY KEY,
    to_slug      TEXT NOT NULL REFERENCES ros_wiki_topics(slug) ON DELETE CASCADE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ros_wiki_redirects_to
    ON ros_wiki_redirects (to_slug);
