-- =============================================================================
-- 0004_embedding_hnsw_index.sql — restore HNSW indexes for vector search.
--
-- The `embedding halfvec(4000)` columns on ros_messages / ros_summaries are
-- meant to be queried by approximate-nearest-neighbour (cosine) search. The
-- HNSW indexes exist on the live datahub DB (m=32, ef_construction=120,
-- halfvec_cosine_ops) but were never carried into schema-as-code — they were
-- created out-of-band (or by an older migration squashed during the rivetOS
-- rewrite). Without them, a fresh rebuild / disaster-recovery instance comes up
-- with NO vector index and silently sequential-scans every embedding.
--
-- This migration makes the schema match reality. Idempotent: IF NOT EXISTS +
-- the exact live index names, so it is a no-op on the existing datahub DB and
-- only does real work on a fresh build (where the tables are empty, so the
-- index builds instantly). Plain CREATE INDEX (not CONCURRENTLY) because the
-- migration runner wraps each file in a transaction.
--
-- halfvec is used (not vector) specifically because pgvector caps `vector` HNSW
-- at 2000 dims; halfvec supports up to 4000, which our embeddings need.
-- =============================================================================

CREATE INDEX IF NOT EXISTS ros_messages_embedding_hnsw
    ON ros_messages USING hnsw (embedding halfvec_cosine_ops)
    WITH (m = 32, ef_construction = 120);

CREATE INDEX IF NOT EXISTS ros_summaries_embedding_hnsw
    ON ros_summaries USING hnsw (embedding halfvec_cosine_ops)
    WITH (m = 32, ef_construction = 120);
