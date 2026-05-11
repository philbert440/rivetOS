-- =============================================================================
-- 0003_subagent_delegation.sql — durable subagent sessions + delegation runs.
--
-- Adds two tables consumed by the @rivetos/core subagent worker and
-- DelegationEngine:
--
--   ros_subagent_sessions — queryable across restart. Spawn rows here;
--     graphile-worker run-subagent-turn jobs reference them by id. On worker
--     startup, any session left in 'running' is marked 'failed' with
--     error='worker_restarted' (option 1a — turn-level resume is out of scope).
--
--   ros_delegation_runs — observability/audit log. DelegationEngine keeps its
--     in-memory result cache but records every run here so we can answer
--     "what did agent X ask Y to do, when, and how long did it take?" across
--     restarts. Insert-only from the engine; no FK to subagent sessions.
-- =============================================================================

CREATE TABLE IF NOT EXISTS ros_subagent_sessions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    parent_agent    TEXT NOT NULL,
    child_agent     TEXT NOT NULL,
    provider        TEXT NOT NULL,
    status          TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed','killed')),
    history         JSONB NOT NULL DEFAULT '[]'::jsonb,
    pending_message TEXT,
    iterations      INTEGER NOT NULL DEFAULT 0,
    tools_used      JSONB NOT NULL DEFAULT '[]'::jsonb,
    usage           JSONB,
    last_response   TEXT NOT NULL DEFAULT '',
    error           TEXT,
    model_override  TEXT,
    timeout_ms      INTEGER,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    duration_ms     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_ros_subagent_sessions_status
    ON ros_subagent_sessions (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ros_subagent_sessions_child_agent
    ON ros_subagent_sessions (child_agent, created_at DESC);

CREATE TABLE IF NOT EXISTS ros_delegation_runs (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    from_agent        TEXT NOT NULL,
    to_agent          TEXT NOT NULL,
    task              TEXT NOT NULL,
    model             TEXT,
    chain_depth       INTEGER NOT NULL DEFAULT 0,
    status            TEXT NOT NULL CHECK (status IN ('completed','failed','timeout','cached','blocked')),
    response          TEXT,
    iterations        INTEGER,
    prompt_tokens     INTEGER,
    completion_tokens INTEGER,
    tools_used        JSONB,
    duration_ms       INTEGER,
    cached            BOOLEAN NOT NULL DEFAULT false,
    started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ros_delegation_runs_from
    ON ros_delegation_runs (from_agent, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_ros_delegation_runs_to
    ON ros_delegation_runs (to_agent, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_ros_delegation_runs_started
    ON ros_delegation_runs (started_at DESC);
