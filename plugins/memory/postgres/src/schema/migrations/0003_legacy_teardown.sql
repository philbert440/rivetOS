-- 0003_legacy_teardown.sql — phase 1 g2a: retire the legacy orchestration
-- tables now that every writer runs on ros_tasks (subagent tools 1d,
-- delegation audit 1e, heartbeats 1f, mesh 1g1 — all deployed + smoked).
--
-- Backfill: ros_subagent_sessions rows become terminal ros_tasks rows
-- (origin 'tool', executor 'chat-loop', spec.subagent marker — the same
-- shape TaskBackedSubagentManager writes), so subagent_list/status history
-- predating the cutover stays queryable from the one table. In-flight
-- legacy rows (queued/running) cannot be resumed by the deleted engine and
-- are recorded as failed/engine_retired.
--
-- ros_delegation_runs is renamed, not dropped — it is an audit log with no
-- writer left; the archive keeps it queryable until someone deliberately
-- drops it.

-- 1. Backfill subagent sessions → terminal ros_tasks rows. Guarded so a
--    manual re-run after the drop is a no-op (the migration runner applies
--    each file once; the guard is belt-and-braces), and the id mapping makes
--    a re-run over existing rows a no-op via ON CONFLICT.
DO $do$
BEGIN
IF to_regclass('ros_subagent_sessions') IS NULL THEN
    RETURN;
END IF;
INSERT INTO ros_tasks
    (id, goal, context_refs, acceptance_criteria, spec, executor,
     agent_id, requested_by, origin, chain_depth, budget, usage,
     max_attempts, attempt, status, error, result, session_key,
     created_at, started_at, completed_at, duration_ms)
SELECT
    s.id,
    COALESCE(s.history->0->>'content', '(legacy subagent session)'),
    '[]'::jsonb,
    '[]'::jsonb,
    jsonb_build_object(
        'interactive', true,
        'subagent', true,
        'legacyBackfill', '0003',
        'toolsUsed', s.tools_used,
        'iterations', s.iterations,
        'provider', s.provider,
        'modelOverride', s.model_override,
        'history', s.history
    ),
    'chat-loop',
    s.child_agent,
    s.parent_agent,
    'tool',
    0,
    CASE WHEN s.timeout_ms IS NOT NULL
         THEN jsonb_build_object('maxWallClockMs', s.timeout_ms)
         ELSE '{}'::jsonb END,
    s.usage,
    1,
    1,
    CASE s.status
        WHEN 'completed' THEN 'completed'
        WHEN 'killed'    THEN 'killed'
        WHEN 'failed'    THEN 'failed'
        ELSE 'failed'   -- queued/running: the engine that could resume them is gone
    END,
    CASE WHEN s.status IN ('queued','running')
         THEN COALESCE(s.error, 'engine_retired')
         ELSE s.error END,
    jsonb_build_object(
        'verdict', CASE s.status WHEN 'completed' THEN 'completed'
                                 WHEN 'killed' THEN 'killed'
                                 ELSE 'failed' END,
        'summary', s.last_response,
        'output', s.last_response,
        'artifacts', '[]'::jsonb,
        'usage', jsonb_build_object(
            'inputTokens',  COALESCE((s.usage->>'promptTokens')::int, 0),
            'outputTokens', COALESCE((s.usage->>'completionTokens')::int, 0),
            'totalTokens',  COALESCE((s.usage->>'promptTokens')::int, 0)
                          + COALESCE((s.usage->>'completionTokens')::int, 0),
            'turns', s.iterations,
            'wallClockMs', COALESCE(s.duration_ms, 0)
        ),
        'error', s.error
    ),
    'task:' || s.id::text,
    s.created_at,
    s.started_at,
    COALESCE(s.completed_at, s.created_at),
    s.duration_ms
FROM ros_subagent_sessions s
ON CONFLICT (id) DO NOTHING;
END $do$;

-- 2. Drop the legacy subagent table (fully represented in ros_tasks now).
DROP TABLE IF EXISTS ros_subagent_sessions;

-- 3. Archive the delegation audit log (no writers left after step 1e).
ALTER TABLE IF EXISTS ros_delegation_runs RENAME TO ros_delegation_runs_archive;
