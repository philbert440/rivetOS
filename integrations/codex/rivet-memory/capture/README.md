# Codex Memory Capture

This directory is a workspace package (`@rivetos/codex-rivet-memory-capture`) that
writes Codex CLI rollout sessions into the shared RivetOS memory store under
`agent = 'rivet-gpt'`, `channel = 'codex'`.

## Layout

```
capture/
├── package.json          # @rivetos/codex-rivet-memory-capture (workspace member)
├── tsconfig.json         # src build (extends ../../../../tsconfig.base.json)
├── tsconfig.test.json    # noEmit check of src + test
├── src/
│   └── codex-memory-capture.ts
├── test/
│   ├── smoke.test.ts
│   ├── hook.test.ts
│   ├── setup.test.ts
│   ├── state.test.ts
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
`SessionEnd`). Setup registers them in **exactly one** place:

- **Managed** (`/etc/codex/requirements.toml`) when `sudo -n` works and the
  write validates. Trusted by policy; no TUI prompt.
- **User** (`~/.codex/hooks.json`) otherwise. Needs a one-time `/hooks` →
  trust in the Codex TUI.

Never both — a prior user-level install is stripped if managed succeeds.
`--remove` cleans both.

Each `--hook` fire reads one JSON object on stdin, then hands off to a
detached child (`--ingest-file <transcript_path> --delay-ms 400`; SessionEnd
also passes `--close-session`). Codex clamps SessionEnd hooks to 3s
(`warning: clamping SessionEnd hook timeout to 3s`); inline ingest would be
killed on any non-trivial rollout, so the parent exits in milliseconds and
the child tails the file under the state lock. Missing `transcript_path` is
resolved in the parent (newest rollout for `session_id`) before the hand-off.

The child tails `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl`
from a persisted per-file cursor.

Folding uses the same filter rules as den-server `codexTurnsFromLines` (drop
developer / injection wrappers), and upserts with:

| field       | value                                                                       |
| ----------- | --------------------------------------------------------------------------- |
| agent       | `rivet-gpt`                                                                 |
| channel     | `codex`                                                                     |
| session_key | `codex:<uuid>`                                                              |
| dedup       | rollout item id (`rs_…` / `ctc_…` / `ctco_…`); else `codex:<uuid>:line:<n>` |

Truncation is 16K and only when the row carries `session_jsonl_path` +
`session_jsonl_line` so `memory_get_full` can re-read the rollout line.

A per-session `pg_advisory_xact_lock(hashtext(session_key))` serialises hook
ingest and the backfill tool. Pool size is 1.

State: `~/.rivetos/codex-capture-state.json` (`lastIngestAt`,
`lastIngestSource`, per-file cursors, closed sessions). Writers take a
cross-process `mkdir` lock on `<stateFile>.lock`, re-read + merge under that
lock, and replace the file via a unique temp name. `--delay-ms N` sleeps
before the read so overlapping hook children collapse into one ingest.

Hook stdout is discarded: `bin/codex-memory-capture.sh --hook` redirects the
node process's stdout and stderr to `~/.rivetos/logs/codex-capture.log`
(created if missing). Codex echoes hook stdout and parses JSON on it as
`hookSpecificOutput`; capture never writes there. Other launcher modes keep
normal stdout. The TypeScript `log()` helper appends to the same file.

## CLI

```
codex-rivet-memory-capture --hook
codex-rivet-memory-capture --ingest-file <rollout.jsonl> [--delay-ms N] [--close-session]
codex-rivet-memory-capture --backfill [--days N] [--sessions-dir DIR]
codex-rivet-memory-capture --status
```

`--hook` never throws (log + exit 0) and does not ingest inline. `--backfill`
is the one-shot walk of existing rollouts (history that accumulated before
hooks were installed, or a manual catch-up). `--status` prints one JSON line
then one human line from the state file. `files=` is the cursor count, not a
per-fire `1`.

## Tests

```bash
npm test
# or: npx tsx test/smoke.test.ts && npx tsx test/hook.test.ts && npx tsx test/setup.test.ts && npx tsx test/state.test.ts
npm run typecheck
```

No live Postgres required. An in-memory stub records INSERTs so a fixture
rollout lands as user + assistant + tool.
