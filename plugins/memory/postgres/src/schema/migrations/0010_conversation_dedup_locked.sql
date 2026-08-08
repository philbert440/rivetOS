-- 0010_conversation_dedup_locked.sql
--
-- Re-runs 0009's dedup under ACCESS EXCLUSIVE, because 0009 took no lock.
--
-- The bug in 0009: it repoints children and then deletes the merged-away
-- conversation rows, all without excluding writers. ros_messages.conversation_id
-- is ON DELETE CASCADE, so a capture write that lands on a duplicate row after
-- the repoint scan but before the DELETE is silently destroyed by the cascade —
-- the message is inserted, committed, and then cascade-deleted when 0009 drops
-- its parent. The same missing lock also makes 0009 flaky: a duplicate created
-- mid-run makes the unique index build fail and roll the whole file back (safe,
-- but it means migrate can just fail under load).
--
-- 0009 is already recorded on some databases and not others, so it cannot be
-- edited — this file carries the FULL logic instead of a patch, and is written to
-- be correct under both histories:
--
--   * 0009 already applied. The unique index exists, so no duplicate can have
--     appeared since; the dedup finds nothing and this file is a pure no-op
--     (plus IF NOT EXISTS on the index, which repairs a database whose 0009 index
--     build was rolled back).
--   * 0009 has NOT been applied. The runner applies 0009 and then 0010 in the
--     same `rivetos db migrate` invocation but in SEPARATE transactions, so 0009
--     still does its dedup unlocked and 0010 cannot retroactively protect that
--     window. What 0010 does cover in that case: any duplicate 0009 raced past,
--     and the window between 0009's COMMIT and 0010's lock. The residual exposure
--     is confined to a populated database that has never run 0009 — a brand new
--     install has no conversations, so 0009's dedup is a no-op there and the
--     window does not exist. The operational mitigation for a populated database
--     is to quiesce capture writers across the migrate; see the deploy note in
--     the pull request.
--
-- Everything else — survivor choice, metadata merge, the set of references that
-- get repointed, the unknown-FK guard — is identical to 0009 by design. The logic
-- is idempotent by construction: with no duplicates the map is empty and every
-- statement matches zero rows.

-- -----------------------------------------------------------------------------
-- 0. Exclude writers BEFORE reading anything, so the map cannot go stale.
--
--    ros_conversations at ACCESS EXCLUSIVE is the load-bearing one: it also stops
--    inserts into every table that has a real FK to it, because the FK check takes
--    a KEY SHARE row lock on the parent and therefore needs ACCESS SHARE on the
--    parent table. That covers ros_messages and ros_summaries without locking them
--    directly — worth avoiding, since ACCESS EXCLUSIVE on ros_messages would stall
--    every search and embedding read for the duration.
--
--    ros_tasks and ros_wiki_provenance are different: their conversation_id is a
--    soft reference with no FK, so nothing would stop a worker from writing a
--    reference to a row we are about to delete. They get locked explicitly.
--
--    This statement is deliberately top-level rather than inside the DO block
--    below: LOCK TABLE outside a transaction block is an error, so running this
--    file statement-at-a-time (psql without -1) fails loudly instead of silently
--    releasing the lock at the end of an implicit single-statement transaction.
--    The migration runner wraps every file in BEGIN/COMMIT, and node-postgres
--    sends the file as one multi-statement simple query, which is itself an
--    implicit transaction — both hold the lock through the final statement.
-- -----------------------------------------------------------------------------
LOCK TABLE ros_conversations IN ACCESS EXCLUSIVE MODE;

DO $lock$
BEGIN
    -- Same order as the repoint below, so a concurrent worker cannot invert it.
    IF to_regclass('ros_tasks') IS NOT NULL THEN
        EXECUTE 'LOCK TABLE ros_tasks IN ACCESS EXCLUSIVE MODE';
    END IF;
    IF to_regclass('ros_wiki_provenance') IS NOT NULL THEN
        EXECUTE 'LOCK TABLE ros_wiki_provenance IN ACCESS EXCLUSIVE MODE';
    END IF;
END
$lock$;

-- -----------------------------------------------------------------------------
-- 1. Map every duplicate row to the survivor it merges into. Read AFTER the lock,
--    so READ COMMITTED gives us a snapshot that includes everything a blocked
--    writer committed on its way in, and nothing can be added behind us.
-- -----------------------------------------------------------------------------
CREATE TEMP TABLE _ros_conv_dedup_map_0010 ON COMMIT DROP AS
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
-- 2. Refuse to dedup if some table we do not know about holds a hard FK to
--    ros_conversations — ON DELETE CASCADE would take its rows with it.
-- -----------------------------------------------------------------------------
DO $guard$
DECLARE
    unhandled TEXT;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM _ros_conv_dedup_map_0010) THEN
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
            'ros_conversations dedup: unhandled foreign key reference(s): % — extend 0010 before applying',
            unhandled;
    END IF;
END
$guard$;

-- -----------------------------------------------------------------------------
-- 3. Merge duplicate metadata onto the survivor (oldest row of each group).
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
      FROM _ros_conv_dedup_map_0010 m
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
-- 4. Repoint children — hard FKs.
-- -----------------------------------------------------------------------------
UPDATE ros_messages t
   SET conversation_id = m.survivor_id
  FROM _ros_conv_dedup_map_0010 m
 WHERE t.conversation_id = m.dup_id;

UPDATE ros_summaries t
   SET conversation_id = m.survivor_id
  FROM _ros_conv_dedup_map_0010 m
 WHERE t.conversation_id = m.dup_id;

-- -----------------------------------------------------------------------------
-- 5. Repoint children — soft references (no FK, nothing else would flag these).
-- -----------------------------------------------------------------------------
DO $soft$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM _ros_conv_dedup_map_0010) THEN
        RETURN;
    END IF;

    IF to_regclass('ros_tasks') IS NOT NULL THEN
        EXECUTE '
            UPDATE ros_tasks t
               SET conversation_id = m.survivor_id
              FROM _ros_conv_dedup_map_0010 m
             WHERE t.conversation_id = m.dup_id';
    END IF;

    IF to_regclass('ros_wiki_provenance') IS NOT NULL THEN
        EXECUTE '
            UPDATE ros_wiki_provenance p
               SET conversation_id = m.survivor_id
              FROM _ros_conv_dedup_map_0010 m
             WHERE p.conversation_id = m.dup_id';

        -- source_id doubles as a conversation id when source_kind = ''conversation''
        -- and is part of the primary key: drop rows that would collide with the
        -- survivor''s own provenance row before repointing the rest.
        EXECUTE '
            DELETE FROM ros_wiki_provenance p
             USING _ros_conv_dedup_map_0010 m
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
              FROM _ros_conv_dedup_map_0010 m
             WHERE p.source_kind = ''conversation''
               AND p.source_id = m.dup_id';
    END IF;
END
$soft$;

-- -----------------------------------------------------------------------------
-- 6. Drop the merged-away rows. Every child points at a survivor and no writer
--    can have slipped in behind us, so the ON DELETE CASCADE takes nothing.
-- -----------------------------------------------------------------------------
DELETE FROM ros_conversations c
 USING _ros_conv_dedup_map_0010 m
 WHERE c.id = m.dup_id;

-- -----------------------------------------------------------------------------
-- 7. The constraint. Already present when 0009 applied cleanly; IF NOT EXISTS
--    covers the database whose 0009 index build lost the race and rolled back.
-- -----------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS ux_ros_conversations_session_agent
    ON ros_conversations (session_key, agent);
