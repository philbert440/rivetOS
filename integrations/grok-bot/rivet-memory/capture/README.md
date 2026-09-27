# Grok Bot capture

Workspace package `@rivetos/grok-bot-rivet-memory-capture` (plugin **0.3.0**).
Normalizes Grok Bot transcripts onto `@rivetos/capture-core` (`capForStorage`,
`eventIdFromContent`, `CaptureMessage`) so grokbot rows match the fidelity of
claude-code / grok-build / cursor capture.

Den POST `/api/capture` is still optional — the node ingest path writes ingest
jsonl and calls `ingestSession()` the same way as before. This CLI never
DELETEs or UPDATEs existing rows.

## What changed in 0.3.0

- Wrapper noise is stripped (`<timestamp>`, `<user_query>` unwrap, SAND
  markers, address tags, profile blobs, injected catalog blocks).
- User `<timestamp>… (UTC-4)</timestamp>` becomes absolute `created_at`. Later
  turns inherit that time + N ms per source position. If no time is known,
  `created_at` is left unset (DB default).
- `tool_result` is read from `result` (ReadTranscript) and capped at 16,000
  UTF-16 units via `capForStorage` — no 4 KB chop, no inline marker.
- Each bot is tagged from the roster (`agent-data/agents/*/profile.json`).
  Historical overrides stay stable: Rivet → `grokbot-rivet-grokbot` /
  `rivet-grokbot`; eggbot → `grokbot-eggbot` / `rivet-eggbot`. Subagents stay
  `rivet-grokbot-run` / `grokbot-run-<id>`. The agent UUID is in metadata.
- Hidden system turns (routines, first-run cues, profile updates, skipped
  prompts, reactions, `[event]`, background-task completions) are stored as
  `role=system` with `metadata.kind`. `[agent]` messages keep the payload as a
  system event with `from_agent` / `from_agent_id`.

## Layout

```
capture/
├── src/                 # normalizer (capture-core)
├── test/fixtures/       # redacted real samples
├── convert-transcript.py
├── pull-bridge.py
├── discover-models.mjs
├── watch.mjs
├── ingest.mjs
├── run-once.sh
└── models.json          # overrides + excludeNames (+ legacy models[] for setup)
```

Paths come from env (`GROKBOT_AGENTS`, `GROKBOT_TRANSCRIPTS` /
`GROKBOT_TRANSCRIPT_ROOT`, `GROKBOT_MODELS`). Nothing in this tree names a
host, address, port, or lab layout.

## Commands

Build first so `dist/cli.js` exists (or rely on `tsx` against `src/cli.ts`):

```bash
npx nx build @rivetos/grok-bot-rivet-memory-capture
```

### Convert one file (either input format)

On-disk agent-transcripts jsonl, or a ReadTranscript page (header + JSON lines
+ optional footer):

```bash
node integrations/grok-bot/rivet-memory/capture/dist/cli.js convert \
  path/to/agent.jsonl spool/grokbot-rivet-grokbot-v3.jsonl \
  --agent-id 6a155e75-0dd5-4c8a-8391-994878ed683a

# same interface the watcher already calls
python3 integrations/grok-bot/rivet-memory/capture/convert-transcript.py \
  path/to/agent.jsonl spool/out.jsonl \
  --agent-id 6a155e75-0dd5-4c8a-8391-994878ed683a
```

### Backfill Sep 15+ (both formats)

On-disk files end around 2026-09-15. Put those jsonl files in a directory and
run:

```bash
# dry (default): stats only, zero writes
node integrations/grok-bot/rivet-memory/capture/dist/cli.js backfill \
  --input path/to/ondisk-dir --format ondisk --session-suffix -v3

# write ingest jsonl (still no DB writes)
node integrations/grok-bot/rivet-memory/capture/dist/cli.js backfill \
  --input path/to/ondisk-dir --format ondisk --session-suffix -v3 \
  --out spool --write
```

Newer content arrives as ReadTranscript pages. Save each page verbatim, then:

```bash
node integrations/grok-bot/rivet-memory/capture/dist/cli.js backfill \
  --input path/to/pages-dir --format page --session-suffix -v3 --out spool --write

# or the pull bridge (stores by position, then converts through the same normalizer)
python3 integrations/grok-bot/rivet-memory/capture/pull-bridge.py add <agentId> /tmp/rt-page.txt
python3 integrations/grok-bot/rivet-memory/capture/pull-bridge.py ingest --dry-run --suffix -v3
python3 integrations/grok-bot/rivet-memory/capture/pull-bridge.py ingest --suffix -v3
```

Ingest the spool with the existing helper (INSERT only; skips ordinals already
present on that **new** `-v3` session):

```bash
node integrations/grok-bot/rivet-memory/bin/ingest-session.mjs \
  --session-id grokbot-rivet-grokbot-v3 --agent rivet-grokbot --persona Rivet \
  spool/grokbot-rivet-grokbot-v3.jsonl
```

### Re-clean existing grokbot rows (`--dry-run` default)

Never DELETE or UPDATE. Dry-run performs **zero writes** and prints counts.

```bash
# from a source transcript (preferred)
node integrations/grok-bot/rivet-memory/capture/dist/cli.js reclean \
  --session grokbot-rivet-grokbot \
  --agent-id 6a155e75-0dd5-4c8a-8391-994878ed683a \
  --from-transcript path/to/rivet.jsonl \
  --dry-run

# same, then write ingest jsonl for the NEW session (suffix -v3)
node integrations/grok-bot/rivet-memory/capture/dist/cli.js reclean \
  --session grokbot-rivet-grokbot \
  --agent-id 6a155e75-0dd5-4c8a-8391-994878ed683a \
  --from-transcript path/to/rivet.jsonl \
  --out spool --write

# from a read-only dump of existing rows (SELECT output as jsonl)
# SQL is printed by: reclean --pg-url <redacted> --session grokbot-rivet-grokbot --dry-run
node integrations/grok-bot/rivet-memory/capture/dist/cli.js reclean \
  --session grokbot-rivet-grokbot --from-rows rows.jsonl --dry-run
```

The SELECT (read-only) used for a row dump:

```sql
SELECT m.role, m.content, m.tool_name, m.tool_args, m.tool_result, m.created_at, m.metadata,
       (m.metadata->>'ordinal')::int AS ordinal
  FROM ros_messages m
  JOIN ros_conversations c ON c.id = m.conversation_id
 WHERE c.channel = 'grokbot'
   AND c.session_key = $1
 ORDER BY COALESCE((m.metadata->>'ordinal')::int, 0), m.created_at
```

### Before/after comparison on the fixtures

```bash
node integrations/grok-bot/rivet-memory/capture/dist/cli.js compare \
  --fixtures integrations/grok-bot/rivet-memory/capture/test/fixtures
```

## Models

`models.json` is not the live roster. Discovery scans
`$GROKBOT_AGENTS/*/profile.json`, skips `group.json` and `excludeNames`
(default includes `New Bot`), and applies `overrides` so historical tags do
not move. A leftover `models[]` array is treated as more overrides so
`setup-grokbot-node.sh` / `run-once.sh` keep working.

## Tests

```bash
npx nx test @rivetos/grok-bot-rivet-memory-capture
```

Fixtures are redacted real samples (TEST-NET `192.0.2.1` only). No unredacted
transcripts.
