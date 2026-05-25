# Grok Memory Capture

This directory is a workspace package (`@rivetos/grok-rivet-memory-capture`) that
writes Grok Build sessions into the shared RivetOS memory store under
`agent = 'rivet-grok'`.

## Layout

```
capture/
├── package.json          # @rivetos/grok-rivet-memory-capture (workspace member)
├── tsconfig.json         # extends ../../../../tsconfig.base.json
├── src/
│   └── grok-memory-capture.ts
├── test/
│   ├── smoke.test.ts
│   └── fixtures/
│       └── sample-session/      # mirrors a real ~/.grok/sessions/.../<sid>/
│           ├── updates.jsonl
│           └── summary.json
└── dist/                 # built by `npm run build` — gitignored
    └── grok-memory-capture.js
```

> **Workspace placement.** This is the only npm workspace currently living
> under `integrations/` — the others all sit at `packages/*` or `plugins/*/*`.
> The trade-off is intentional: keeping the capture next to the rest of the
> Grok integration (skills, hook scripts, MCP launcher, GROK.md) lets a reader
> grok (sorry) the entire plugin from one directory. If a future integration
> grows TS code of its own, a dedicated `integrations/*/.../<pkg>` convention
> may want generalizing.

## Build

```bash
npm install        # picks up this workspace, installs pg + @types/pg + tsx
npm run build      # nx run-many -t build — produces dist/grok-memory-capture.js
```

`bin/grok-memory-hook.sh` prefers `dist/grok-memory-capture.js` and falls back to
`npx --yes tsx` against the .ts source if the build is missing. The built path is
the supported production path; the tsx fallback exists for ergonomics on unbuilt
checkouts.

## Design Goals

- **Never block Grok**: hook scripts return in single-digit milliseconds.
- **Capture everything**: assistant responses, agent thoughts, full tool I/O,
  memory-flush markers — not just what hooks happen to carry.
- **Best effort**: failures are logged but never impact the user's Grok session.
- **Idempotent**: re-running an ingest does not duplicate rows.

## Architecture (JSONL ingestion)

The capture worker reads Grok's **own session transcript** rather than trying to
reconstruct content from hook payloads. This mirrors
`plugins/providers/claude-cli/src/transcript-capture.ts` and was adopted after
discovering that Grok's hook payloads are signals-only — the actual response
text, agent thoughts, and tool outputs are *not* in any hook payload.

The authoritative log lives at:

```
~/.grok/sessions/<urlencoded-cwd>/<sessionId>/updates.jsonl
```

Grok itself uses this file for `/load` and session restore, so reading it
directly is the supported way to recover full session content. Per `~/.grok/docs/user-guide/17-sessions.md`:

> `updates.jsonl` is the **authoritative conversation log** that drives
> `/load` and session restore. Sessions are stored as newline-delimited JSON,
> append-only during a session.

### Pipeline

```
Grok hook fires (Stop / SessionEnd / PreCompact / UserPromptSubmit / …)
  └── bin/grok-memory-hook.sh
      └── grok-memory-capture --hook <event>
          └── spools a CaptureOp { kind: 'ingest', sessionId, finalize?, sourceEvent }
              └── detached worker (--worker <spoolFile>)
                  └── ingestSession(op)
                      1. locate ~/.grok/sessions/.../<sessionId>/   (env hint + scan fallback)
                      2. read updates.jsonl, parse to a normalized PendingMessage[]
                      3. read summary.json (best-effort) for title/model/agent_name
                      4. acquire pg_advisory_xact_lock(hashtext(sessionKey))
                      5. find-or-create ros_conversations row
                      6. count existing ros_messages → slice → insert parsed[count:]
                      7. (finalize) flip ros_conversations.active = false
                      8. COMMIT
```

Hooks are pure **triggers** — they don't need to parse anything beyond the
session id (resolved from `$GROK_SESSION_ID` env, which Grok always injects).

### ACP event-type mapping

| `sessionUpdate`                | Internal row                                                                 |
|--------------------------------|------------------------------------------------------------------------------|
| `user_message_chunk`           | `role=user`, content = text                                                  |
| `agent_message_chunk`          | `role=assistant`, content = text                                             |
| `agent_thought_chunk`          | `role=assistant`, content = `"[thinking] " + text` (rivet-claude convention) |
| `tool_call` (collected)        | (no immediate row; waits for the matching completion)                        |
| `tool_call_update(completed)`  | `role=tool`, `tool_name = title`, `tool_args = rawInput`, `tool_result = stringified rawOutput` (preferred) or merged text content |
| `memory_flush_started`         | `role=system`, content = `"[grok.memory_flush_started]"`                     |
| `memory_flush_completed`       | `role=system`, content = `"[grok.memory_flush_completed]"`                   |
| `hook_execution`               | skipped (meta about our own hooks)                                           |
| `available_commands_update`    | skipped (slash-command catalog dumps)                                        |
| `tool_call_update(in_progress)`| skipped (only the final completed event becomes a row)                       |

Each emitted row carries the original `_meta.eventId` and `agentTimestampMs`
in its metadata for traceability.

### Idempotency: slice-by-count

Identical to Claude's transcript-capture model.

- The parser is **deterministic**: parsed message *k* always maps to the same
  row for the same input.
- `updates.jsonl` is **append-only**: any prefix is a stable prefix of the
  full file.
- A per-session `pg_advisory_xact_lock(hashtext(sessionKey))` serialises
  concurrent worker fires (Grok can burst many events).
- On each ingest the worker counts existing rows in
  `ros_messages WHERE conversation_id = X`, then inserts only
  `parsed.slice(count)`. Re-fires are no-ops.

The smoke test asserts both invariants directly (parser determinism and
prefix-stability) against a real captured `updates.jsonl` fixture.

A future migration adding a partial unique index on
`(conversation_id, (metadata->>'event_id'))` would let the worker switch to
`ON CONFLICT DO NOTHING` as a defence-in-depth layer, but slice-by-count is
the correctness contract and does not require it.

## Database Schema

Writes to the standard RivetOS tables:
- `ros_conversations` (with `agent = 'rivet-grok'`)
- `ros_messages` (with `metadata.event_id`, `metadata.event_ts`,
  `metadata.sessionUpdate`, `metadata.toolCallId` populated for traceability)

The same tables used by `rivet-claude` and `rivet-hermes`.

## Tests

```bash
npm test
```

The test suite has four layers:

1. **Parser tests** (no DB, no subprocess) against `fixtures/sample-session/updates.jsonl`
   — a real 76-event session captured from rivet-grok on 2026-05-25. Asserts
   the exact role/count breakdown, that tool results are populated (not just
   `{"status":"completed"}`), and the slice-by-count idempotency invariants
   (parser determinism, prefix-stability).
2. **summary.json reader** — verifies generated_title / current_model_id /
   agent_name are extracted.
3. **Session-dir resolver** — verifies `findSessionDir` returns null for
   unknown ids.
4. **`--hook` spool e2e** — runs the script via tsx (or built `dist/`),
   confirms it spools an `ingest` CaptureOp with the right
   sessionId/sourceEvent/finalize flag without spawning the detached worker
   (controlled by `GROK_CAPTURE_NO_WORKER=1`).

## Future Improvements

- Add a partial unique index on `(conversation_id, (metadata->>'event_id'))`
  via a memory-pipeline migration; lets the worker layer in
  `ON CONFLICT DO NOTHING` as belt-and-suspenders.
- Shared capture client library between this and `plugins/providers/claude-cli`.
- Surface `chat_history.jsonl` / `signals.json` content (token usage, raw
  model messages) as conversation-level settings.
- Wire the smoke test into the project's `vitest` runner.
