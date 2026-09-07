# Codex Transcript Backfill

One-shot recovery tool. Replays Codex CLI rollout jsonl files into the shared
RivetOS memory store as `agent = 'rivet-gpt'` / `channel = 'codex'` rows.

Live capture is a watcher over the same files (`../capture`). This tool exists
to ingest history that accumulated before the watcher was installed. Identity
matches capture so a re-run is a no-op.

## Transcript layout

```
$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl
```

Default `$CODEX_HOME` is `~/.codex`. Native id is the bare UUID (no `session_`
prefix). `session_key` is `codex:<uuid>`.

## Usage

```bash
npm run build

# Dry run — the default.
node dist/codex-transcript-backfill.js --dry-run

# Dry run with no database.
node dist/codex-transcript-backfill.js --offline

# Commit.
node dist/codex-transcript-backfill.js --write
```

Writes take `pg_advisory_xact_lock(hashtext(session_key))` — the same lock the
capture watcher takes.

## Tests

```bash
npm test
```

No database required. Fixtures are the capture sample rollout plus a tiny
directory layout for discovery.
