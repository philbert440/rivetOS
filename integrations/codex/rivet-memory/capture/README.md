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
│   ├── hook.test.ts
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

Capture is triggered by native Codex hooks (`UserPromptSubmit`, `Stop`,
`SessionEnd`) registered in `~/.codex/hooks.json` and, when sudo is available,
`/etc/codex/requirements.toml`. Each fire reads one JSON object on stdin and
tails `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl` from a
persisted per-file cursor.

Folding uses the same filter rules as den-server `codexTurnsFromLines` (drop
developer / injection wrappers), and upserts with:

| field | value |
|-------|--------|
| agent | `rivet-gpt` |
| channel | `codex` |
| session_key | `codex:<uuid>` |
| dedup | rollout item id (`rs_…` / `ctc_…` / `ctco_…`); else `codex:<uuid>:line:<n>` |

Truncation is 16K and only when the row carries `session_jsonl_path` +
`session_jsonl_line` so `memory_get_full` can re-read the rollout line.

A per-session `pg_advisory_xact_lock(hashtext(session_key))` serialises hook
ingest and the backfill tool. Pool size is 1.

State: `~/.rivetos/codex-capture-state.json` (`lastIngestAt`,
`lastIngestSource`, per-file cursors, closed sessions).

Non-managed hooks need a one-time `/hooks` → trust in the Codex TUI. Managed
hooks in `/etc/codex/requirements.toml` are trusted by policy.

## CLI

```
codex-rivet-memory-capture --hook
codex-rivet-memory-capture --ingest-file <rollout.jsonl>
codex-rivet-memory-capture --backfill [--days N] [--sessions-dir DIR]
codex-rivet-memory-capture --status
```

`--hook` never throws (log + exit 0). `--backfill` is the one-shot walk of
existing rollouts (history that accumulated before hooks were installed, or a
manual catch-up). `--status` prints last ingest time + counts from the state
file.

## Tests

```bash
npm test
# or: npx tsx test/smoke.test.ts && npx tsx test/hook.test.ts
```

No live Postgres required. An in-memory stub records INSERTs so a fixture
rollout lands as user + assistant + tool.
