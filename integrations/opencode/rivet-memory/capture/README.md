# OpenCode Memory Capture

This directory is a workspace package (`@rivetos/opencode-rivet-memory-capture`)
that writes OpenCode CLI sessions into the shared RivetOS memory store under
`agent = 'rivet-glm'`, `channel = 'opencode'`.

OpenCode has no Claude/kimi-style hooks and no jsonl transcript. Sessions live
in SQLite (`opencode.db`, WAL mode). Capture is a read-only poller plus
`fs.watch` on `opencode.db` / `opencode.db-wal`.

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
| cursor | `part.time_updated` (30s overlap) / `message.time_updated` in `~/.rivetos/opencode-capture-state.json` |

Folding rules match den-server `opencodeTurnsFromMessages` (skip system /
step-start / step-finish; keep user text, assistant text, reasoning, tools)
but rows stay per-part so `memory_get_full` can re-read one SQLite part.

Truncation is 16K and only when the row carries `session_sqlite_path` +
`session_sqlite_part_id`.

A per-session `pg_advisory_xact_lock(hashtext(session_key))` serialises
ingest. Pool size is 1.

## CLI

```
opencode-rivet-memory-capture --watch [--db FILE] [--backfill DAYS]
opencode-rivet-memory-capture --once  [--db FILE] [--backfill DAYS]
```

`--watch` backfills sessions updated in the last N days on the first pass
(default 14; `--backfill 0` skips history) then polls with the incremental
cursor. `--once` is the cron/backstop path.

## Tests

```bash
npm test
# or: npx tsx test/smoke.test.ts
```

No live Postgres required. An in-memory stub records INSERTs so a fixture
SQLite db lands as user + assistant + tool.
