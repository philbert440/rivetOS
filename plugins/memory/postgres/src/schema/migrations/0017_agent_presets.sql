-- =============================================================================
-- 0017_agent_presets.sql — DataHub-hosted agent registry.
--
-- One `ros_agent_presets` row per RivetHub agent preset. The list lives on
-- the DataHub (shared Postgres) so every node and every RivetHub app reads
-- the same agents. A node is where an agent is hosted (`node` =
-- `mesh.node_name`), not the name a caller delegates to. den-server, the
-- task runner, and the hub reach the table through `@rivetos/agent-registry`.
--
-- No triggers and no CHECK on harness_id: adding a harness must not require
-- a migration. Idempotent (IF NOT EXISTS) per migration conventions.
-- PGlite-safe: no LISTEN/NOTIFY, no prepared-statement assumptions.
-- =============================================================================

CREATE TABLE IF NOT EXISTS ros_agent_presets (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    color         TEXT NOT NULL DEFAULT '',
    harness_id    TEXT,
    model         TEXT NOT NULL DEFAULT '',
    effort        TEXT NOT NULL DEFAULT '',
    system_prompt TEXT NOT NULL DEFAULT '',
    node          TEXT NOT NULL,
    directory     TEXT NOT NULL,
    shared_link   BOOLEAN NOT NULL DEFAULT true,
    node_base_url TEXT NOT NULL DEFAULT '',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ros_agent_presets_name ON ros_agent_presets (lower(name));
CREATE INDEX IF NOT EXISTS idx_ros_agent_presets_node ON ros_agent_presets (node);
