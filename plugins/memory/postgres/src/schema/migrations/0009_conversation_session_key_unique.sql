-- 0009_conversation_session_key_unique.sql
--
-- Make (session_key, agent) a real uniqueness domain on ros_conversations, so
-- the capture path can upsert instead of select-then-insert.
--
-- Why: the harness control plane (docs/plans/harness-control-plane.md, collision
-- rule 3) requires "one SessionId + agent => exactly one conversation". Today the
-- adapter does SELECT ... LIMIT 1 then INSERT with no constraint behind it, so two
-- concurrent appends for the same session both miss the SELECT and both INSERT.
-- Live phil_memory carries 5 such duplicate pairs (10 rows) produced exactly this
-- way. Without a DB constraint, `session_id_collision` is unimplementable and the
-- transcript for a session can silently fork in two.
--
-- NULL semantics (deliberate):
--   session_key is declared NOT NULL in 0001_baseline and holds zero NULLs and zero
--   empty strings on live phil_memory (2115 rows checked). A partial index
--   (WHERE session_key IS NOT NULL) would therefore cover exactly the same rows as a
--   plain unique index, while forcing every writer to repeat the predicate in its
--   ON CONFLICT clause for the index to be usable as an arbiter. So: PLAIN unique
--   index, no predicate. Note that even if the NOT NULL were ever dropped, Postgres
--   treats NULLs as distinct in a unique index by default (no NULLS NOT DISTINCT
--   here), so NULL session_keys would still never collide — the behaviour a partial
--   index would have given us, without the arbiter friction. The adapter's defensive
--   `OR c.session_key IS NULL` in getContextForTurn is dead code against this schema.
--
-- Dedup strategy (runs before the index, or the index cannot be created):
--   survivor  = OLDEST row per (session_key, agent), ties broken by id, so the
--               conversation id with the most history/provenance behind it survives.
--   metadata  = merged onto the survivor rather than dropped: active is OR-ed (any
--               live duplicate keeps the session live — otherwise merged messages
--               would vanish from the active=true reads), created_at = min,
--               updated_at = max, and title/settings/channel/channel_id/bot_identity
--               are backfilled from the most recently updated duplicate that has a
--               value when the survivor does not.
--   children  = every reference to a dropped id is repointed at the survivor:
--                 ros_messages.conversation_id        (FK, ON DELETE CASCADE)
--                 ros_summaries.conversation_id       (FK, NO ACTION)
--                 ros_tasks.conversation_id           (soft ref, no FK)
--                 ros_wiki_provenance.conversation_id (soft ref, no FK)
--                 ros_wiki_provenance.source_id       (soft ref when
--                                                      source_kind='conversation')
--               The soft references carry no FK, so a plain DELETE would leave them
--               dangling — they are handled explicitly. A guard below aborts the
--               migration if a hard FK to ros_conversations exists that this file
--               does not know about, rather than letting ON DELETE CASCADE quietly
--               destroy rows.
--   delete    = only after every child is repointed, so nothing cascades.
--
-- Everything is schema-qualification-free and resolved through search_path, so the
-- file applies identically to public and to a scratch schema under test.
-- Idempotent: with no duplicates the dedup block is a no-op and the index creation
-- is IF NOT EXISTS.

-- -----------------------------------------------------------------------------
-- 1. Map every duplicate row to the survivor it merges into.
-- -----------------------------------------------------------------------------
CREATE TEMP TABLE _ros_conv_dedup_map ON COMMIT DROP AS
WITH ranked AS (
    SELECT id,
           first_value(id) OVER (
               PARTITION BY session_key, agent
               ORDER BY created_at, id
           ) AS survivor_id
    FROM ros_conversations
)
SELECT id AS dup_id, survivor_id
FROM ranked
WHERE id <> survivor_id;

-- -----------------------------------------------------------------------------
-- 2. Safety guard: refuse to dedup if some table we do not know about holds a
--    hard FK to ros_conversations(id). Only fires when there is actually
--    something to merge.
-- -----------------------------------------------------------------------------
DO $guard$
DECLARE
    unhandled TEXT;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM _ros_conv_dedup_map) THEN
        RETURN;
    END IF;

    SELECT string_agg(format('%s.%s', con.conrelid::regclass, att.attname), ', ')
      INTO unhandled
      FROM pg_constraint con
      JOIN unnest(con.conkey) AS k(attnum) ON true
      JOIN pg_attribute att
        ON att.attrelid = con.conrelid AND att.attnum = k.attnum
     WHERE con.contype = 'f'
       AND con.confrelid = 'ros_conversations'::regclass
       AND NOT (con.conrelid = 'ros_messages'::regclass  AND att.attname = 'conversation_id')
       AND NOT (con.conrelid = 'ros_summaries'::regclass AND att.attname = 'conversation_id');

    IF unhandled IS NOT NULL THEN
        RAISE EXCEPTION
            'ros_conversations dedup: unhandled foreign key reference(s): % — extend 0009 before applying',
            unhandled;
    END IF;
END
$guard$;

-- -----------------------------------------------------------------------------
-- 3. Merge duplicate metadata onto the survivor.
-- -----------------------------------------------------------------------------
WITH merged AS (
    SELECT m.survivor_id,
           bool_or(COALESCE(c.active, false))                                            AS any_active,
           min(c.created_at)                                                             AS min_created,
           max(c.updated_at)                                                             AS max_updated,
           (array_agg(c.title        ORDER BY c.updated_at DESC, c.id)
              FILTER (WHERE c.title IS NOT NULL))[1]                                     AS best_title,
           (array_agg(c.settings     ORDER BY c.updated_at DESC, c.id)
              FILTER (WHERE c.settings IS NOT NULL AND c.settings <> '{}'::jsonb))[1]    AS best_settings,
           (array_agg(c.channel      ORDER BY c.updated_at DESC, c.id)
              FILTER (WHERE c.channel IS NOT NULL AND c.channel <> 'unknown'))[1]        AS best_channel,
           (array_agg(c.channel_id   ORDER BY c.updated_at DESC, c.id)
              FILTER (WHERE c.channel_id IS NOT NULL))[1]                                AS best_channel_id,
           (array_agg(c.bot_identity ORDER BY c.updated_at DESC, c.id)
              FILTER (WHERE c.bot_identity IS NOT NULL))[1]                              AS best_bot_identity
      FROM _ros_conv_dedup_map m
      JOIN ros_conversations c ON c.id = m.dup_id
     GROUP BY m.survivor_id
)
UPDATE ros_conversations s
   SET active       = COALESCE(s.active, false) OR merged.any_active,
       created_at   = least(s.created_at, merged.min_created),
       updated_at   = greatest(s.updated_at, merged.max_updated),
       title        = COALESCE(s.title, merged.best_title),
       settings     = CASE
                          WHEN s.settings IS NULL OR s.settings = '{}'::jsonb
                              THEN COALESCE(merged.best_settings, s.settings)
                          ELSE s.settings
                      END,
       channel      = CASE
                          WHEN s.channel = 'unknown' AND merged.best_channel IS NOT NULL
                              THEN merged.best_channel
                          ELSE s.channel
                      END,
       channel_id   = COALESCE(s.channel_id, merged.best_channel_id),
       bot_identity = COALESCE(s.bot_identity, merged.best_bot_identity)
  FROM merged
 WHERE s.id = merged.survivor_id;

-- -----------------------------------------------------------------------------
-- 4. Repoint children — hard FKs first.
-- -----------------------------------------------------------------------------
UPDATE ros_messages t
   SET conversation_id = m.survivor_id
  FROM _ros_conv_dedup_map m
 WHERE t.conversation_id = m.dup_id;

UPDATE ros_summaries t
   SET conversation_id = m.survivor_id
  FROM _ros_conv_dedup_map m
 WHERE t.conversation_id = m.dup_id;

-- -----------------------------------------------------------------------------
-- 5. Repoint children — soft references (no FK, so nothing would flag these).
--    Guarded by to_regclass so the file still applies to a database that was
--    baselined without ros_tasks (0002) or the wiki tables (0005).
-- -----------------------------------------------------------------------------
DO $soft$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM _ros_conv_dedup_map) THEN
        RETURN;
    END IF;

    IF to_regclass('ros_tasks') IS NOT NULL THEN
        EXECUTE '
            UPDATE ros_tasks t
               SET conversation_id = m.survivor_id
              FROM _ros_conv_dedup_map m
             WHERE t.conversation_id = m.dup_id';
    END IF;

    IF to_regclass('ros_wiki_provenance') IS NOT NULL THEN
        -- conversation_id is plain payload — repoint directly.
        EXECUTE '
            UPDATE ros_wiki_provenance p
               SET conversation_id = m.survivor_id
              FROM _ros_conv_dedup_map m
             WHERE p.conversation_id = m.dup_id';

        -- source_id doubles as a conversation id when source_kind = ''conversation'',
        -- and it is part of the primary key: drop rows that would collide with the
        -- survivor''s own provenance row before repointing the rest.
        EXECUTE '
            DELETE FROM ros_wiki_provenance p
             USING _ros_conv_dedup_map m
             WHERE p.source_kind = ''conversation''
               AND p.source_id = m.dup_id
               AND EXISTS (
                   SELECT 1 FROM ros_wiki_provenance q
                    WHERE q.topic_slug = p.topic_slug
                      AND q.source_kind = ''conversation''
                      AND q.source_id = m.survivor_id
               )';
        EXECUTE '
            UPDATE ros_wiki_provenance p
               SET source_id = m.survivor_id
              FROM _ros_conv_dedup_map m
             WHERE p.source_kind = ''conversation''
               AND p.source_id = m.dup_id';
    END IF;
END
$soft$;

-- -----------------------------------------------------------------------------
-- 6. Drop the merged-away rows. Every child now points at a survivor, so the
--    ON DELETE CASCADE on ros_messages has nothing left to take with it.
-- -----------------------------------------------------------------------------
DELETE FROM ros_conversations c
 USING _ros_conv_dedup_map m
 WHERE c.id = m.dup_id;

-- -----------------------------------------------------------------------------
-- 7. The constraint itself. Named so the adapter can probe for it by name before
--    choosing the upsert path (a node that boots before `rivetos db migrate` has
--    run falls back to the legacy select-then-insert instead of erroring 42P10).
-- -----------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS ux_ros_conversations_session_agent
    ON ros_conversations (session_key, agent);
