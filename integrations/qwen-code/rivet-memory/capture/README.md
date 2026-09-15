# Qwen Code Memory Capture

This directory is a workspace package (`@rivetos/qwen-code-rivet-memory-capture`)
that writes Qwen Code CLI session jsonl into the shared RivetOS memory store
under `agent = 'rivet-qwen'`, `channel = 'qwen-code'`.

## Layout

```
capture/
├── package.json          # @rivetos/qwen-code-rivet-memory-capture
├── tsconfig.json         # src build (extends ../../../../tsconfig.base.json)
├── tsconfig.test.json    # noEmit check of src + test
├── src/
│   └── qwen-memory-capture.ts
├── test/
│   ├── smoke.test.ts
│   ├── hook.test.ts
│   ├── setup.test.ts
│   ├── state.test.ts
│   └── fixtures/
│       └── sample-session/   # scrubbed real transcript
└── dist/                 # built by `npm run build` — gitignored
    └── qwen-memory-capture.js
```

## Build

```bash
npm install
npm run build      # produces dist/qwen-memory-capture.js
```

`bin/qwen-memory-capture.sh` prefers `dist/qwen-memory-capture.js` and falls
back to `npx --yes tsx` against the .ts source if the build is missing.

## Design

Capture is triggered by native Qwen hooks (`UserPromptSubmit`, `Stop`,
`SessionEnd`). Setup registers them as a **qwen extension** (default) or
merges into `~/.qwen/settings.json` (`--mode settings`).

Each `--hook` fire reads one JSON object on stdin, then hands off to a
detached child (`--ingest-file <transcript_path> --delay-ms 400`; SessionEnd
also passes `--close-session`). The parent writes **nothing** to stdout and
always exits 0. The child tails the file under a Postgres session-level
advisory lock (`pg_advisory_lock(hashtext(key))`, `lock_timeout`,
`statement_timeout = 0` during acquisition).

Transcripts live at `~/.qwen/projects/<sanitized-cwd>/chats/<uuid>.jsonl`
(gemini-style `parts`). `*.runtime.json` sidecars are skipped.

| field       | value                                  |
| ----------- | -------------------------------------- |
| agent       | `rivet-qwen` (`RIVETOS_CAPTURE_AGENT`) |
| channel     | `qwen-code`                            |
| session_key | `qwen-code:<uuid>`                     |
| dedup       | `qwen-code:<sessionId>:<line uuid>`    |
| source      | `qwen-session`                         |

Truncation is 16K and only when the row carries `session_jsonl_path` +
`session_jsonl_line` so `memory_get_full` can re-read the jsonl line.

State: `~/.rivetos/qwen-code-capture-state.json` (`lastIngestAt`,
`lastIngestSource`, `hookInstalledAt`, per-file cursors). Log:
`~/.rivetos/logs/qwen-code-capture.log`.

## CLI

```
qwen-code-rivet-memory-capture --hook
qwen-code-rivet-memory-capture --ingest-file <session.jsonl> [--delay-ms N] [--close-session]
qwen-code-rivet-memory-capture --backfill [--days N] [--projects-dir DIR]
qwen-code-rivet-memory-capture --status
```
