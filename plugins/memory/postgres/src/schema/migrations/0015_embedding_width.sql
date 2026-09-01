-- =============================================================================
-- 0015_embedding_width.sql — #624 guarded recast halfvec(4000) → halfvec(1024)
--
-- Split out of the former combined 0014 so a refused ALTER cannot block
-- ros_message_chunks / content_hash / the chunk trigger (those live in 0014).
-- This file's RAISE only blocks itself and later migrations; 0014 already
-- applied. Operator signal: `rivetos doctor` `checkEmbeddingWidth`.
--
-- Guarded recast of ros_messages.embedding / ros_summaries.embedding from
-- the 0001 baseline halfvec(4000) to halfvec(1024) (fleet Qwen3-Embedding-0.6B
-- native width, same as 0005_wiki.sql). Decision matches decideWidthMigration:
--   skip   — atttypmod already 1024 (or column/table missing)
--   alter  — atttypmod ≠ 1024 AND count(embedding IS NOT NULL) = 0
--            drop ANY index on the embedding column, ALTER TYPE halfvec(1024),
--            recreate hnsw (m=32, ef_construction=120)
--   refuse — atttypmod ≠ 1024 AND non-null rows exist → RAISE EXCEPTION.
--            Never silently drop vectors. Manual procedure is re-embed from
--            scratch (option 1 only): halfvec(4000) cannot hold 1024-d values,
--            and pgvector's vector-slicing helper needs ≥ 0.8.
--
-- Idempotent: skip when already 1024.
-- Schema-qualification-free (search_path), same as 0009–0014.
-- =============================================================================

DO $width$
DECLARE
    rec     RECORD;
    typmod  INTEGER;
    nnull   BIGINT;
    idx     RECORD;
    idxname TEXT;
BEGIN
    FOR rec IN
        SELECT unnest(ARRAY['ros_messages', 'ros_summaries']) AS tbl
    LOOP
        IF to_regclass(rec.tbl) IS NULL THEN
            CONTINUE;
        END IF;

        SELECT a.atttypmod
          INTO typmod
          FROM pg_attribute a
         WHERE a.attrelid = rec.tbl::regclass
           AND a.attname = 'embedding'
           AND NOT a.attisdropped;

        -- skip: missing column or already halfvec(1024)
        IF typmod IS NULL OR typmod = 1024 THEN
            CONTINUE;
        END IF;

        EXECUTE format('SELECT count(*) FROM %I WHERE embedding IS NOT NULL', rec.tbl)
            INTO nnull;

        IF nnull > 0 THEN
            RAISE EXCEPTION '%', format(
                $err$%s.embedding is halfvec(%s) with %s non-null row(s); refusing to ALTER to halfvec(1024) (would silently drop or recast live vectors). Manual procedure: Re-embed from scratch: UPDATE %I SET embedding = NULL, embed_status = NULL, embed_error = NULL, embed_failures = 0 WHERE embedding IS NOT NULL; then re-run this migration and let enqueue-unembedded backfill. Never DROP the column while non-null rows exist. Operator signal: rivetos doctor checkEmbeddingWidth.$err$,
                rec.tbl, typmod, nnull, rec.tbl
            );
        END IF;

        -- alter: drop ANY index on the embedding column (not only hnsw), recast, recreate
        FOR idx IN
            SELECT c.relname AS idxname,
                   am.amname AS amname
              FROM pg_index i
              JOIN pg_class c ON c.oid = i.indexrelid
              JOIN pg_am am ON am.oid = c.relam
             WHERE i.indrelid = rec.tbl::regclass
               AND EXISTS (
                   SELECT 1
                     FROM pg_attribute a
                    WHERE a.attrelid = rec.tbl::regclass
                      AND a.attname = 'embedding'
                      AND a.attnum = ANY (i.indkey)
               )
        LOOP
            IF idx.amname <> 'hnsw' THEN
                RAISE NOTICE 'dropping non-hnsw index % (amname=%) on %.embedding',
                    idx.idxname, idx.amname, rec.tbl;
            END IF;
            EXECUTE format('DROP INDEX IF EXISTS %I', idx.idxname);
        END LOOP;

        EXECUTE format('ALTER TABLE %I ALTER COLUMN embedding TYPE halfvec(1024)', rec.tbl);

        idxname := rec.tbl || '_embedding_hnsw';
        EXECUTE format(
            'CREATE INDEX IF NOT EXISTS %I ON %I USING hnsw (embedding halfvec_cosine_ops) WITH (m = 32, ef_construction = 120)',
            idxname,
            rec.tbl
        );
    END LOOP;
END
$width$;
