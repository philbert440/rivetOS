# Grok Memory Capture

This directory is a workspace package (`@rivetos/grok-rivet-memory-capture`) that
writes Grok Build sessions into the shared RivetOS memory store.

## Layout

```
capture/
├── package.json          # @rivetos/grok-rivet-memory-capture (workspace member)
├── tsconfig.json         # extends ../../../../tsconfig.base.json
├── src/
│   └── grok-memory-capture.ts
├── test/
│   └── smoke.test.ts
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

Run from the repo root:

```bash
npm install        # picks up this workspace, installs pg + @types/pg + tsx
npm run build      # nx run-many -t build — produces dist/grok-memory-capture.js
```

`bin/grok-memory-hook.sh` prefers `dist/grok-memory-capture.js` and falls back to
`npx --yes tsx` against the .ts source if the build is missing. The built path is
the supported production path; the tsx fallback exists for ergonomics on unbuilt
checkouts.

## Design Goals

- **Never block Grok**: All hook handlers must return extremely fast.
- **Rich capture**: Turns, tool calls (with full input + result), and especially pre-compaction messages.
- **Best effort**: Failures are logged but must never impact the user's Grok session.
- **Dedup-safe**: Per-session advisory lock + content-hash `event_id` skip lets
  hook retries collapse without a schema migration. See below.

## Architecture

We use the proven "spool + detached worker" pattern (inspired by the Claude Code
implementation) combined with rich event support from the Hermes design.

1. Grok hook fires → `bin/grok-memory-hook.sh` is called with the event name.
2. The script pipes the payload to `grok-memory-capture --hook <event>`
   (built `.js` preferred, tsx fallback otherwise).
3. The capture process writes a small JSON file to a temp spool directory and
   immediately spawns a detached worker bound to that one spool file, then exits.
4. The worker (`--worker <spool>`) reads the file and performs the actual database
   writes using the same insert patterns as the Claude capture, plus dedup.

## Dedup model

Each candidate row is keyed by a stable `event_id`: a sha256 prefix over fields
that define what makes the row logically unique.

| Kind          | Hashed parts                                            |
|---------------|----------------------------------------------------------|
| `turn`        | sessionKey, `turn`, role, content                        |
| `tool`        | sessionKey, `tool`, tool_name, JSON(tool_input), tool_result |
| `pre_compact` | sessionKey, `pre_compact`, index, role, content          |

For each batch (`insertMessagesDeduped`):

1. Compute event_ids for all candidates.
2. Under the per-session `pg_advisory_xact_lock`, `SELECT metadata->>'event_id'`
   for existing rows in the conversation matching any candidate id.
3. Insert only the rows whose event_id isn't already present, storing the id
   in `ros_messages.metadata.event_id`.

This means a hook that fires twice for the same payload (timeout retry, dual
delivery) deduplicates cleanly. Two genuinely-distinct events with identical
text in the same session still produce distinct ids because the index / role /
tool_args differ — or, for adjacent pre_compact rows, the positional index.

### Why SELECT-then-INSERT rather than `ON CONFLICT`?

This is a deliberate choice, not a placeholder. The advisory lock
(`pg_advisory_xact_lock(hashtext(sessionKey))`) is held for the full
transaction, so no second worker for the same session can interleave between
the SELECT and the INSERT. There is no race window for a unique constraint to
catch — the lock *is* the contract. Adding a `(conversation_id,
metadata->>'event_id')` unique partial index would let the code switch to
`ON CONFLICT DO NOTHING` (one query instead of two) but would not improve
correctness.

It would also couple the core memory schema to a convention currently used
only by this integration: `rivet-claude` uses transcript-uuid + slice-by-count
idempotency, not `metadata.event_id`. If a second integration adopts the same
convention, promoting the index into `plugins/memory/postgres/src/schema/
migrations/` becomes well-motivated and the code change here is one line.
Until then, the partial index isn't worth pre-coupling for.

For very high-volume sessions where the SELECT cost shows up, an *operational*
(out-of-tree) index over the same expression is a safe pure-perf change that
doesn't require any code edits here.

## Current Supported Events

The hook launcher accepts any Grok lifecycle event name; the capture script
classifies it into one of four internal "kinds" by substring match on the
name. **Classifier precedence is last-match-wins** — see the comment in
`main()` for the rule order. Concretely:

| Grok event              | Internal kind     | What gets stored (under `agent='rivet-grok'`) |
|-------------------------|-------------------|------------------------------------------------|
| `PostToolUse`           | `tool`            | One tool message: `toolName` + `toolInput` + `toolResult` from the payload |
| `PostToolUseFailure`    | `tool`            | Same as PostToolUse, but `toolResult` may carry an `error` / `toolError` field instead |
| `UserPromptSubmit`      | `turn`            | One user message; reads `prompt` / `userPrompt` / `user` (first defined) |
| `Stop`                  | `turn`            | One assistant message; reads `response` / `finalResponse` / `assistant` (first defined). Field name not in Grok docs — verify before relying on. |
| `PreCompact`            | `pre_compact`     | Each item in payload `messages[]` as a separate row, dedup-keyed by position+role+content. Highest value event for long sessions. |
| `SessionStart`          | `turn`            | No message rows; the call still upserts the conversation row so downstream events have a parent |
| `SessionEnd`            | `session_end`     | Flips `ros_conversations.active = false`. No message rows. |

### Payload field-name handling

Grok emits **camelCase** keys per `~/.grok/docs/user-guide/10-hooks.md`
(`sessionId`, `toolName`, `toolInput`, `toolResult`, `hookEventName`, etc.).
Test fixtures and Claude-compat callers historically used snake_case. All
field access in the worker goes through a `pickField(payload, ...names)`
helper that tries multiple plausible names in order, so both styles work.
The session id additionally falls back to the `GROK_SESSION_ID` env var
(which Grok always injects into the hook process), so even a payload missing
the JSON field still groups correctly.

## Wiring into Grok

See the example in `../hooks/hooks.json`.

You will likely need to adjust event names as Grok's hook system evolves. The
important ones for memory are anything that gives you:
- User prompts
- Assistant responses
- Tool calls + results
- Pre-compaction / compaction events

## Database Schema

Writes to the standard RivetOS tables:
- `ros_conversations` (with `agent = 'rivet-grok'`)
- `ros_messages` (with `metadata.event_id` for dedup)

The same tables used by `rivet-claude` and `rivet-hermes`.

## Smoke Test

From the workspace dir:

```bash
npm test
```

Or from the repo root:

```bash
npx tsx integrations/grok/rivet-memory/capture/test/smoke.test.ts
```

The test prefers the built `dist/` artifact if present (mirroring production),
otherwise runs the .ts source under tsx. It points `RIVETOS_ENV_FILE` at
`/dev/null` so the detached worker fails fast and the spool file persists for
inspection — then asserts the spooled `CaptureOp` shape (kind, sessionKey,
payload field). Exits non-zero on failure.

## Future Improvements

- Add a partial unique index on `(conversation_id, (metadata->>'event_id'))`
  via a memory-pipeline migration; lets dedup use `ON CONFLICT DO NOTHING`
  instead of SELECT-then-INSERT.
- Shared capture client library with the Claude implementation.
- Optional direct (non-spool) path when running inside certain Grok contexts.
- Wire the smoke test into the project's `vitest` runner.
