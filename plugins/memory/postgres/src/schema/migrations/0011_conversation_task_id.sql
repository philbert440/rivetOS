-- 0011_conversation_task_id.sql
--
-- Per-conversation task association, so a task's transcript is a query-time
-- JOIN instead of a shared write key.
--
-- Why: today a task executor spawns its harness with
-- RIVETOS_SESSION_KEY=task:<taskId>, which makes capture write EVERY spawn's
-- turns into one conversation keyed `task:<taskId>`. That buys multi-spawn
-- transcript unity at the cost of throwing away the canonical SessionId — the
-- harness control plane (docs/plans/harness-control-plane.md § Legacy keys,
-- "Write direction") requires the opposite: harness sessions ALWAYS write under
-- their canonical SessionId, and `task:<taskId>` becomes a read-side union.
--
-- Shape choice: a nullable `task_id` on ros_conversations, NOT a reuse of
-- ros_tasks.conversation_id. That column is a single UUID — one conversation per
-- task — which is exactly the cardinality the join has to break: a task spawns
-- many harness sessions, each with its own canonical conversation. The
-- association therefore has to live on the many side. A join table would carry
-- the same cardinality but adds a second write to every conversation-create on
-- the capture hot path for a strictly 1:N relation.
--
-- No FK to ros_tasks, deliberately: this mirrors the existing soft reference in
-- the other direction (ros_tasks.conversation_id has no FK either), keeps capture
-- writes independent of the task row's lifetime, and — since capture runs
-- out-of-process from a detached hook worker — means a task row deleted or not
-- yet visible can never fail an ingest. 0009/0010's unknown-FK guard scans for FKs
-- pointing AT ros_conversations, so this column is invisible to it either way.
--
-- NO data migration of existing `task:<taskId>` rows: they stay exactly as they
-- are and remain readable, because the union read matches on BOTH
-- `task_id = <id>` and `session_key = 'task:' || <id>`. Backfilling would mean
-- parsing a key namespace into a UUID column across a table we would have to lock,
-- for zero read-path benefit.
--
-- Schema-qualification-free (resolved through search_path), so it applies
-- identically to public and to a scratch schema under test. Idempotent:
-- IF NOT EXISTS on both statements, per migration conventions.

ALTER TABLE ros_conversations
    ADD COLUMN IF NOT EXISTS task_id UUID;

-- Partial: the overwhelming majority of conversations are not task-spawned, and
-- the only query shape is "every conversation for this task, oldest first".
CREATE INDEX IF NOT EXISTS idx_ros_conversations_task
    ON ros_conversations (task_id, created_at)
    WHERE task_id IS NOT NULL;
