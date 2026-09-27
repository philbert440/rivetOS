# Grok Bot capture

Workspace package `@rivetos/grok-bot-rivet-memory-capture` (plugin **0.3.0**).
Normalizes Grok Bot transcripts onto `@rivetos/capture-core` (`capForStorage`,
`eventIdFromContent`, `CaptureMessage`) so grokbot rows match the fidelity of
claude-code / grok-build / cursor capture.

The node ingest path writes ingest jsonl (including per-row `metadata`,
`ordinal`, and `event_id`) and calls `ingestSession()`, which now preserves
that metadata and honors the caller ordinal / event_id. This CLI never
DELETEs or UPDATEs existing rows.

## What changed in 0.3.0

- Wrapper noise is stripped (`<timestamp>`, `<user_query>` unwrap, SAND
  markers, address tags, profile blobs, injected catalog blocks).
  `SIMILAR_BLOCK_RE` is an allowlist of known injected tags; pasted XML is
  kept. Profile blobs may include `-` and `_`.
- `<timestamp>` is parsed only from user or hidden turns — never from
  assistant or tool text (those are quotes). Assistant and tool rows inherit
  from the immediately preceding stamped user (+ N ms by source position).
  A later user turn with no stamp stops inheriting (`created_at` unset, or
  the stored time when re-cleaning rows).
- `tool_result` is read from `result` (ReadTranscript) and capped at 16,000
  UTF-16 units via `capForStorage` — no 4 KB chop, no inline marker.
- Each bot is tagged from the roster (`agent-data/agents/*/profile.json`)
  **before** the subagent fallback. Historical overrides stay stable: Rivet →
  `grokbot-rivet-grokbot` / `rivet-grokbot`; eggbot → `grokbot-eggbot` /
  `rivet-eggbot`. Un-overridden roster bots get real tags (e.g. Arch →
  `grokbot-arch` / `rivet-arch`). Unknown ids stay `rivet-grokbot-run` /
  `grokbot-run-<id>`. The agent UUID is in metadata.
- Hidden system turns are stored as `role=system` with `metadata.kind`.
  Repeated routine / background fires stay distinct by position. Identical
  user turns at the same timestamp are deduped. `[agent]` messages keep the
  payload with `from_agent` / `from_agent_id`.
- Ingest ordinal is `position * 1000 + sub-index` (stable across overlapping
  pages). `ingestSession` honors `item.ordinal` / `item.event_id` and merges
  `item.metadata` (agent_id, kind, position, truncated, …).
- Live capture writes to `<session>-v3` by default (`GROKBOT_SESSION_SUFFIX`).
  Watcher state stays at `~/.rivetos/capture/state.json` when that file
  already exists, otherwise `~/.rivetos/grokbot-capture-state.json` (old path
  is migrated). `RIVETOS_ROOT` defaults to `/opt/rivetos`.

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
`GROKBOT_TRANSCRIPT_ROOT`, `GROKBOT_MODELS`, `GROKBOT_SESSION_SUFFIX`).
Nothing in this tree names a host, address, port, or lab layout.

## Commands

Build first so `dist/cli.js` exists (or rely on `tsx` against `src/cli.ts`):

```bash
npx nx build @rivetos/grok-bot-rivet-memory-capture
```

### Convert one file (either input format)

On-disk agent-transcripts jsonl, or a ReadTranscript page (header + JSON lines
+ optional footer). Live / convert defaults to session suffix `-v3`.

```bash
node integrations/grok-bot/rivet-memory/capture/dist/cli.js convert \
  path/to/agent.jsonl spool/grokbot-rivet-grokbot-v3.jsonl \
  --agent-id 6a155e75-0dd5-4c8a-8391-994878ed683a

# same interface the watcher already calls
python3 integrations/grok-bot/rivet-memory/capture/convert-transcript.py \
  path/to/agent.jsonl spool/out.jsonl \
  --agent-id 6a155e75-0dd5-4c8a-8391-994878ed683a \
  --session grokbot-rivet-grokbot-v3
```

On-disk input without `--agent-id` or a page header takes the id from
`<uuid>/<uuid>.jsonl`.

### Backfill Sep 15+ (both formats)

`--input` walks recursively, so the `agent-transcripts` root works. All pages
for one agent are merged by position into a single spool (overlapping or
out-of-order pages produce the same rows as a single pass).

```bash
# dry (default): stats only, zero writes
node integrations/grok-bot/rivet-memory/capture/dist/cli.js backfill \
  --input path/to/agent-transcripts --format ondisk --session-suffix -v3

# write ingest jsonl (still no DB writes) — one file per agent
node integrations/grok-bot/rivet-memory/capture/dist/cli.js backfill \
  --input path/to/agent-transcripts --format ondisk --session-suffix -v3 \
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

Ingest the spool with the existing helper (INSERT only; skips event_ids /
ordinals already present on that **new** `-v3` session):

```bash
node integrations/grok-bot/rivet-memory/bin/ingest-session.mjs \
  --session-id grokbot-rivet-grokbot-v3 --agent rivet-grokbot --persona Rivet \
  spool/grokbot-rivet-grokbot-v3.jsonl
```

### Re-clean existing grokbot rows (`--dry-run` default)

Never DELETE or UPDATE. Dry-run performs **zero writes** and prints counts.
Do **not** pass the database URL on argv. The read-only rows source loads
`RIVETOS_PG_URL` from the environment or `~/.rivetos/.env`, then runs its
SELECTs inside `BEGIN TRANSACTION READ ONLY` and `ROLLBACK`. Rows are grouped
by `conversation_id` (prod has two conversation rows for
`grokbot-rivet-grokbot` with the same agent).

`--from-rows` cannot restore tool results: the old converter ignored
`result`, so stored tool rows average ~38 chars. Assistant rows keep the
legacy `[tool X]` / `[thinking]` text. Full fidelity needs a backfill from
the source transcripts.

```bash
# from a source transcript (preferred — full tool_result fidelity)
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
node integrations/grok-bot/rivet-memory/capture/dist/cli.js reclean \
  --session grokbot-rivet-grokbot --from-rows rows.jsonl --dry-run

# from Postgres (RIVETOS_PG_URL in env or ~/.rivetos/.env — never --pg-url)
node integrations/grok-bot/rivet-memory/capture/dist/cli.js reclean \
  --session grokbot-rivet-grokbot --agent rivet-grokbot --dry-run
```

The SELECT (read-only, per conversation):

```sql
SELECT c.id AS conversation_id, c.session_key, c.agent, count(m.id)::int AS n
  FROM ros_conversations c
  JOIN ros_messages m ON m.conversation_id = c.id
 WHERE c.channel = 'grokbot'
   AND c.session_key = $1
   AND ($2::text IS NULL OR c.agent = $2)
 GROUP BY c.id, c.session_key, c.agent;

SELECT m.role, m.content, m.tool_name, m.tool_args, m.tool_result, m.created_at, m.metadata,
       (m.metadata->>'ordinal')::int AS ordinal
  FROM ros_messages m
 WHERE m.conversation_id = $1
 ORDER BY COALESCE((m.metadata->>'ordinal')::int, 0), m.created_at
```

### Before/after comparison on the fixtures

The table reports per-role averages. Empty `tool_use` rows (assistant +
`tool_name`, no text) are excluded from the after average.

```bash
node integrations/grok-bot/rivet-memory/capture/dist/cli.js compare \
  --fixtures integrations/grok-bot/rivet-memory/capture/test/fixtures
```

## Models

`models.json` is not the live roster. Discovery scans
`$GROKBOT_AGENTS/*/profile.json`, skips `group.json` and `excludeNames`
(default includes `New Bot`), and applies `overrides` so historical tags do
not move. `identityFor` consults that roster before the subagent fallback.
A leftover `models[]` array is treated as more overrides so
`setup-grokbot-node.sh` / `run-once.sh` keep working.

## Live capture

`watch.mjs` and `run-once.sh` write new-shape rows to `<session>-v3`
(`GROKBOT_SESSION_SUFFIX`, default `-v3`). Watcher state: keep
`~/.rivetos/capture/state.json` if it exists (copied to
`~/.rivetos/grokbot-capture-state.json` on first run). `RIVETOS_ROOT`
defaults to `/opt/rivetos`.

## Tests

```bash
npx nx test @rivetos/grok-bot-rivet-memory-capture
```

Fixtures are redacted real samples (TEST-NET `192.0.2.1` only). No unredacted
transcripts.
