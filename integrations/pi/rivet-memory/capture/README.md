# Pi Memory Capture

This directory is a workspace package (`@rivetos/pi-rivet-memory-capture`) that
writes pi CLI v3 session jsonl into the shared RivetOS memory store under
`agent = 'rivet-deepseek'`, `channel = 'pi'`.

The trigger is the pi extension at `../extension/rivet-memory.ts` (installed
to `~/.pi/agent/extensions/rivet-memory.ts`). This package is the ingest
core: `--ingest-file` tails a session from a persisted cursor; `--backfill`
walks existing files once.

## Layout

```
capture/
├── package.json          # @rivetos/pi-rivet-memory-capture (workspace member)
├── tsconfig.json         # extends ../../../../tsconfig.base.json
├── src/
│   └── pi-memory-capture.ts
├── test/
│   ├── smoke.test.ts
│   └── fixtures/
│       └── sample-session/          # synthetic v3 session jsonl (den-adapter shape)
└── dist/                 # built by `npm run build` — gitignored
    └── pi-memory-capture.js
```

## Build

```bash
npm install
npm run build      # produces dist/pi-memory-capture.js
```

`bin/pi-memory-capture.sh` prefers `dist/pi-memory-capture.js` and falls
back to `npx --yes tsx` against the .ts source if the build is missing.

## Design

Session files live at:

```
~/.pi/agent/sessions/<encoded-cwd>/<ISO-ts>_<uuid-v7>.jsonl
```

encoded cwd: `/home/rivet` → `--home-rivet--`. A custom `--session-dir` is
flat (no cwd bucket). New lines are tailed from the persisted per-file
cursor, folded with the same filter rules as den-server `piTurnsFromLines`
(copied, not imported), and upserted with:

| field       | value                                                                   |
| ----------- | ----------------------------------------------------------------------- |
| agent       | `rivet-deepseek` (override `RIVETOS_CAPTURE_AGENT`)                     |
| channel     | `pi`                                                                    |
| session_key | `pi:<uuid>`                                                             |
| dedup       | `pi:<uuid>:<lineId>` (8-hex line `id`); else `pi:<uuid>:line:<n>`       |
| title       | session `-n` name if present, else first user text                      |
| thinking    | `metadata.reasoning` on the assistant row                               |
| usage       | assistant `message.usage` (`input`/`output`/`cacheRead`/`cacheWrite`/…) |
| model       | last `model_change` (`provider` + `modelId`)                            |

Truncation is 16K and only when the row carries `session_jsonl_path` +
`session_jsonl_line` so `memory_get_full` can re-read the session line.

A per-session `pg_advisory_xact_lock(hashtext(session_key))` serialises
ingest. Pool size is 1.

`--ingest-file` / `--backfill` write `~/.rivetos/pi-capture-state.json`
(`lastIngestAt`, `lastIngestSource`, per-file cursors).

## CLI

```
pi-rivet-memory-capture --ingest-file <session.jsonl>
pi-rivet-memory-capture --backfill [--days N] [--sessions-dir DIR]
pi-rivet-memory-capture --status
```

`--ingest-file` tails from the persisted cursor and always exits 0.
`--backfill` / `--once` walk existing files and exit. `--days N` keeps
files whose mtime is within N days.

## Tests

```bash
npm test
# or: npx tsx test/smoke.test.ts
```

No live Postgres required. An in-memory stub records INSERTs so a fixture
session lands as user + assistant + tool.
