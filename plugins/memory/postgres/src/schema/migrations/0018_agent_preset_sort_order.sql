-- =============================================================================
-- 0018_agent_preset_sort_order.sql — user-chosen order for agent presets.
--
-- Nullable `sort_order` on `ros_agent_presets`. RivetHub writes it when the
-- user reorders the sidebar. NULL rows sort after ordered rows, then by
-- created_at, so presets created before (or by a den that predates) this
-- migration keep their current position until someone reorders.
--
-- Additive only: older dens `SELECT *` and ignore the column. Idempotent
-- (IF NOT EXISTS) per migration conventions. PGlite-safe.
-- =============================================================================

ALTER TABLE ros_agent_presets ADD COLUMN IF NOT EXISTS sort_order INTEGER;
