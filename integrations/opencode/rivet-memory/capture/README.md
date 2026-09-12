# OpenCode Memory Capture

This directory is a workspace package (`@rivetos/opencode-rivet-memory-capture`)
that writes OpenCode CLI sessions into the shared RivetOS memory store under
`agent = 'rivet-glm'`, `channel = 'opencode'`.

Sessions live in SQLite (`opencode.db`). The OpenCode plugin
(`plugin/rivet-memory.ts`) spawns `--ingest-session <id>` on `session.idle`
(debounced), `session.compacted`, `session.deleted`, and `session.error`.
`--backfill [--days N]` is the one-shot catch-up. There is no file watcher.

## Layout

```
capture/
├── package.json          # @rivetos/opencode-rivet-memory-capture (workspace member)
├── tsconfig.json         # extends ../../../../tsconfig.base.json
├── src/
│   └── opencode-memory-capture.ts
├── test/
│   └── smoke.test.ts
└── dist/                 # built by `npm run build` — gitignored
    └── opencode-memory-capture.js
```

## Build

```bash
npm install
npm run build      # produces dist/opencode-memory-capture.js
```

`bin/opencode-memory-capture.sh` prefers `dist/opencode-memory-capture.js` and
falls back to `npx --yes tsx` against the .ts source if the build is missing.

## Design

| field | value |
|-------|--------|
| agent | `rivet-glm` (override `RIVETOS_CAPTURE_AGENT`) |
| channel | `opencode` |
| session_key | `opencode:<ses_id>` |
| title | `session.title` |
| cwd | `session.directory` |
| dedup | `part.id` (`prt_…`) — never a content hash |
| cursor | per-session `part.time_updated` (30s overlap) / `message.time_updated` in `~/.rivetos/opencode-capture-state.json` |

Folding rules match den-server `opencodeTurnsFromMessages` (skip system /
step-start / step-finish; keep user text, assistant text, reasoning, tools)
but rows stay per-part so `memory_get_full` can re-read one SQLite part.

Truncation is 16K and only when the row carries `session_sqlite_path` +
`session_sqlite_part_id`.

A per-session `pg_advisory_xact_lock(hashtext(session_key))` serialises
ingest. Pool size is 1.

## CLI

```
opencode-rivet-memory-capture --ingest-session <id> [--db FILE]
opencode-rivet-memory-capture --backfill [--days N] [--db FILE]
opencode-rivet-memory-capture --status
```

`--ingest-session` loads that session's parts newer than the persisted
per-session cursor, upserts, and always exits 0. `--backfill` is the
one-shot catch-up (default 14 days; `--days 0` skips history). `--status`
prints `lastIngestAt` / `lastIngestSource` / counts from the state file.

## Tests

```bash
npm test
# or: npx tsx test/smoke.test.ts
```

No live Postgres required. An in-memory stub records INSERTs so a fixture
SQLite db lands as user + assistant + tool.
