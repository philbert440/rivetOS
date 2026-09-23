# T3 Code Memory Capture

Host-side sidecar that reads T3's projection SQLite and upserts completed
turns into the shared RivetOS memory store the same way the OpenCode
capture kit does (direct `ros_conversations` / `ros_messages` inserts,
dedup on `metadata.event_id`).

This is **not** a T3 plugin. T3 has no capture hook. Run it beside
`t3 service` (or `t3 serve`).

| field       | value |
| --- | --- |
| agent       | `rivet-t3` (`RIVETOS_CAPTURE_AGENT`) |
| channel     | `t3code` |
| session_key | `t3code:<thread_id>` |
| source      | `t3code-sqlite` |
| dedup       | `message_id` / `activity_id` |
| cursor      | per-thread `(updated_at, message_id)` in `~/.rivetos/t3code-capture-state.json` |
| sqlite      | `~/.t3/userdata/state.sqlite` (override `T3_STATE_SQLITE`) |

## Run beside `t3 service`

```bash
# T3's own background server (writes the sqlite):
t3 service install
t3 service status

# This sidecar (read-only poll of the same db):
integrations/t3code-rivetos-memory/bin/t3code-memory-capture.sh --watch
```

One-shot catch-up:

```bash
integrations/t3code-rivetos-memory/bin/t3code-memory-capture.sh --backfill --days 14
integrations/t3code-rivetos-memory/bin/t3code-memory-capture.sh --status
```

`--watch` polls every 2.5s (override `--poll-ms`). It never writes the
SQLite file. Logs: `~/.rivetos/logs/t3code-capture.log`.

Needs `RIVETOS_PG_URL` (or postgres DataHub) in `~/.rivetos/.env`.

The launcher prefers `capture/dist/t3code-memory-capture.js` and falls
back to `node --experimental-strip-types` on the TypeScript source.
Root `package.json` `workspaces` includes this package
(`@rivetos/t3code-rivetos-memory-capture`). After adding it, the
lockfile must link the member (`npm install --package-lock-only`).

## What it reads

Completed turns only (`projection_turns.completed_at IS NOT NULL`) plus
idle sessions (`projection_thread_sessions.status` not `running`).
Streaming message rows (`is_streaming=1`) wait until the turn settles.

Tool fidelity comes from `projection_thread_activities` (`tone='tool'` /
`kind` like `tool.*`). Tools are **not** only in message text.

All T3 providers (Claude, Codex, Grok, OpenCode, …) land under
`agent=rivet-t3`. `provider_name` is stored in metadata.

Harness-native capture (Claude hooks, Codex rollouts, OpenCode db) is
**optional enrichment** — not required. This sidecar is the T3-wide
automatic path.

## Risks

**Schema churn.** T3 migrations keep adding columns to the projection
tables. The reader probes `PRAGMA table_info` and selects only columns
it knows. If a required table vanishes or is renamed, ingest logs
`schema-churn` and skips that tick instead of crashing `t3 service`.

**WAL.** T3 uses WAL + `busy_timeout`. We open the live
`state.sqlite` read-only (not an immutable URI, which would hide the
WAL) and set `PRAGMA busy_timeout = 5000` to match T3. `SQLITE_BUSY`
during a checkpoint is retried on the next poll. Never copy the db
without `-wal`/`-shm` and expect a consistent snapshot.

**16K message cap.** Bodies are capped at 16,000 chars only when the
row carries `session_sqlite_path` + `session_sqlite_message_id` (or
activity id) so a later `memory_get_full` could re-read SQLite.
`memory_get_full` does not yet know the T3 tables — truncated tails
are a known gap until that reader is wired.

## CLI

```
t3code-memory-capture --watch [--poll-ms N] [--db FILE]
t3code-memory-capture --backfill [--days N] [--db FILE]
t3code-memory-capture --once [--db FILE]
t3code-memory-capture --status
```
