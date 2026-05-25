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

No schema migration is required. For high-volume sessions, a partial index on
`(conversation_id, (metadata->>'event_id'))` would make the existence check
O(1); that can be added later without code changes here.

## Current Supported Events

- `PostToolUse` / tool-related events → Captures tool name + input + result
- `TurnAfter` / turn completion → Captures user + assistant content
- `CompactBefore` → Captures messages about to be discarded during compaction (highest value for long sessions)
- `SessionEnd` → Marks the conversation as inactive

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
