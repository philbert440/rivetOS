-- =============================================================================
-- 0004_task_eval.sql — phase 2 (evaluation), step 2a: contract + storage.
--
-- Adds the evaluation surface to ros_tasks. Ships DARK: nothing writes these
-- columns until tasks.eval.enabled flips (PR 2d+). Design: phase-2 consult,
-- /rivet-shared/plans/modernization-followups.md §Phase 2.
--
--   eval          JSONB   — EvalOutcome (verdict verified|refuted|escalated,
--                           attempts, verifierTaskIds, criteriaReport,
--                           diverged, escalatedAt). NULL = unevaluated.
--   eval_attempt  INTEGER — verifier-driven retry counter; DISTINCT from
--                           `attempt` (crash-recovery CAS) by design.
--   origin 'eval'         — child verifier task rows (parent_task_id set,
--                           spec.role='verifier'); excluded from outcome
--                           aggregates, joinable for drill-down.
--
-- Idempotent per migration conventions.
-- =============================================================================

ALTER TABLE ros_tasks ADD COLUMN IF NOT EXISTS eval JSONB;
ALTER TABLE ros_tasks ADD COLUMN IF NOT EXISTS eval_attempt INTEGER NOT NULL DEFAULT 0;

-- Widen the origin CHECK to admit verifier child tasks.
ALTER TABLE ros_tasks DROP CONSTRAINT IF EXISTS ros_tasks_origin_check;
ALTER TABLE ros_tasks ADD CONSTRAINT ros_tasks_origin_check
    CHECK (origin IN ('heartbeat','chat','tool','mesh','api','eval'));

-- Outcomes view (scoreboard reads this — PR 2g). Rows with no acceptance
-- criteria are UNEVALUATED and excluded; verifier child rows and audit-only
-- terminal inserts likewise. `diverged` = executor claimed completed but the
-- verifier refuted — the scoreboard's headline honesty metric.
CREATE OR REPLACE VIEW ros_task_outcomes_v AS
SELECT
    t.id,
    t.agent_id,
    t.executor,
    t.executor_target,
    t.origin,
    date_trunc('day', t.completed_at AT TIME ZONE 'UTC') AS day,
    t.status,
    t.result->>'verdict'                    AS executor_verdict,
    t.eval->>'verdict'                      AS eval_verdict,
    COALESCE((t.result->>'verdict') = 'completed'
             AND (t.eval->>'verdict') = 'refuted', false) AS diverged,
    (t.usage->>'costUsd')::numeric          AS cost_usd,
    t.eval_attempt,
    t.duration_ms
FROM ros_tasks t
WHERE t.status IN ('completed','failed','killed','timeout')
  AND t.origin <> 'eval'
  AND (t.spec->>'auditOnly') IS DISTINCT FROM 'true'
  AND jsonb_array_length(t.acceptance_criteria) > 0;
