# Codex Memory Capture

This directory is a workspace package (`@rivetos/codex-rivet-memory-capture`) that
writes Codex CLI rollout sessions into the shared RivetOS memory store under
`agent = 'rivet-gpt'`, `channel = 'codex'`.

## Layout

```
capture/
├── package.json          # @rivetos/codex-rivet-memory-capture (workspace member)
├── tsconfig.json         # extends ../../../../tsconfig.base.json
├── src/
│   └── codex-memory-capture.ts
├── test/
│   ├── smoke.test.ts
│   └── fixtures/
│       └── sample-rollout/          # synthetic rollout jsonl (den-adapter shape)
└── dist/                 # built by `npm run build` — gitignored
    └── codex-memory-capture.js
```

## Build

```bash
npm install
npm run build      # produces dist/codex-memory-capture.js
```

`bin/codex-memory-capture.sh` prefers `dist/codex-memory-capture.js` and falls
back to `npx --yes tsx` against the .ts source if the build is missing.

## Design

Codex has no Claude/kimi-style hooks. Capture is a file watcher over

```
$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl
```

(default `~/.codex/sessions`). New lines are tailed, folded with the same
filter rules as den-server `codexTurnsFromLines` (drop developer / injection
wrappers), and upserted with:

| field | value |
|-------|--------|
| agent | `rivet-gpt` |
| channel | `codex` |
| session_key | `codex:<uuid>` |
| dedup | rollout item id (`rs_…` / `ctc_…` / `ctco_…`); else `codex:<uuid>:line:<n>` |

Truncation is 16K and only when the row carries `session_jsonl_path` +
`session_jsonl_line` so `memory_get_full` can re-read the rollout line.

A per-session `pg_advisory_xact_lock(hashtext(session_key))` serialises the
watcher and the backfill tool. Pool size is 1.

## CLI

```
codex-rivet-memory-capture --watch [--sessions-dir DIR]
codex-rivet-memory-capture --once  [--sessions-dir DIR]
codex-rivet-memory-capture --ingest <rollout.jsonl>
```

`--watch` ingests existing files then tails. `--once` is the cron/backstop
path and what the backfill tool uses in spirit.

## Tests

```bash
npm test
# or: npx tsx test/smoke.test.ts
```

No live Postgres required. An in-memory stub records INSERTs so a fixture
rollout lands as user + assistant + tool.
