-- =============================================================================
-- 0020_tag_removals.sql — a model may suggest removing a tag already on an
-- entity. removal_state is NULL until then, 'suggested' while it waits in the
-- review queue, and 'rejected' once a person keeps the tag. Accepting the
-- suggestion sets the tag's own state to 'rejected' (it leaves the visible
-- set and is not proposed again) and clears removal_state. Never applied
-- without that decision. removal_reason is the model's one-line why.
-- Idempotent. PGlite-safe: no DO blocks, no triggers.
-- =============================================================================

ALTER TABLE ros_tags ADD COLUMN IF NOT EXISTS removal_state TEXT;
ALTER TABLE ros_tags ADD COLUMN IF NOT EXISTS removal_reason TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_ros_tags_removal_state
    ON ros_tags (removal_state) WHERE removal_state = 'suggested';
