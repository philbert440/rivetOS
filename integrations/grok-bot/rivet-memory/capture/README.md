# Grok Bot capture

Workspace package `@rivetos/grok-bot-rivet-memory-capture` (plugin **0.3.0**).
Normalizes Grok Bot transcripts onto `@rivetos/capture-core` (`capForStorage`,
`eventIdFromContent`, `CaptureMessage`) so grokbot rows match the fidelity of
claude-code / grok-build / cursor capture.

The node ingest path writes ingest jsonl (including per-row `metadata`,
`ordinal`, and `event_id`) and `ingestGrokbotSession()` stores that metadata,
the caller ordinal, and the event id. This CLI never DELETEs or UPDATEs
existing rows.

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
  Repeated routine / background fires stay distinct by position. Genuine
  same-minute user repeats stay distinct by position; only a replayed
  consecutive block that starts with a stamped user turn whose stamp
  repeats (page concat) is dropped. Repeated tool_use / tool_result
  pairs are kept. Hidden-body strip runs only
  when `[SAND_HIDDEN_PROMPT]` is present, so a normal user message that
  mentions `[event]` survives. `role=system` records stay system.
  `[agent]` messages keep the payload with `from_agent` / `from_agent_id`.
  `created_at` is clamped to `max(stamp, lastEmitted+1ms)`. A position
  that emits ≥1000 rows throws.
- Ingest ordinal is `position * 1000 + sub-index` (stable across overlapping
  pages). A position that emits ≥1000 rows throws. `event_id` hashes the
  ingest ordinal (`eventIdFromContent` `occurrence`), so the same content at
  two positions cannot collide and a mid-transcript page (Sep 15+, pull-bridge
  gap fill) produces the same id as a full run from position 0.
  `ingestGrokbotSession` honors `item.ordinal` / `item.event_id` and merges
  `item.metadata` (agent_id, kind, position, truncated, …). Tool results
  land in `ros_messages.tool_result`. The normalizer source is kept as
  `metadata.capture_source` (`grokbot-transcript` / `grokbot-readtranscript` /
  `grokbot-store` / `grokbot-voice`) because the grok-bot ingest writer stores
  the write tag in `metadata.source`.
- Live capture writes to `<session>-v3` by default (`GROKBOT_SESSION_SUFFIX`).
  Row-based re-clean (`--from-rows` / Postgres) writes `<session>-v3-rows`
  so stored-row positions never mix with source-transcript ordinals.
  `agents/<id>/store.db` `transcript_entries.seq` writes `<session>-v3-store`
  (seq is not the on-disk line index). `voice-calls/*.json` writes
  `<session>-v3-voice-<stem>` (turn index is not the line index).
  Watcher state is keyed by agent id plus the target suffix, so a copied
  unsuffixed `~/.rivetos/capture/state.json` cannot skip `-v3` ingest.
  Store cursors are `seq:N` under the same map. `run-once.sh` does not treat
  the watcher `state.json` as per-session stuck-policy. `RIVETOS_ROOT`
  defaults to `/opt/rivetos`.
- Search, browse, and session recall prefer a `-v3` or `-v3-rows` sibling
  over the unsuffixed and `-v2` copies at query time, but only when that
  sibling's last source position covers the legacy session's last
  position (incomplete `-v3` does not hide history). No rows are deleted
  and no completion marker is written.

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
└── models.json          # historical overrides + excludeNames (typed source: src/identity.ts)
```

Paths come from env (`GROKBOT_AGENTS`, `GROKBOT_TRANSCRIPTS` /
`GROKBOT_TRANSCRIPT_ROOT`, `GROKBOT_MODELS`, `GROKBOT_SESSION_SUFFIX`).
Nothing in this tree names a host, address, port, or lab layout.

## Session suffixes (do not mix formats)

| suffix | source | position |
| --- | --- | --- |
| `-v3` | on-disk jsonl / ReadTranscript pages | line index / page position |
| `-v3-rows` | Postgres / `--from-rows` reclean | stored ordinal |
| `-v3-store` | `agents/<id>/store.db` `transcript_entries` | `seq` |
| `-v3-voice-<stem>` | `voice-calls/*.json` | turn index |

`seq` and voice turn indices are **not** the on-disk line index. Ingesting
them into `-v3` would hit `ordinal exists, event_id differs, skip`.

Store schema (13 live stores, opened read-only):
`transcript_entries(seq INTEGER PRIMARY KEY, id TEXT, entry TEXT)`.
`entry` is JSON with `kind` (`message`, `send-message`, `event`,
`spend-initiation`, `user-attachment`, `feedback`) and integer
`timestampMs`. Other tables (`kv`, `blobs`, `automation_completion_inbox`)
are unused. Voice-call JSON has top-level `callId` + `startedAtMs`; each
turn has `speaker` and `atMs`. `toolCalls` is a call-level list
(`argumentsJson` + `result.atMs` / `result.json`); nudges are dropped.
Fixtures use that real shape with synthetic content only.

Node `parseArgs` rejects `--session-suffix -v3` and `--after-seq -1`.
Every spawn site uses the `=` form (`--session-suffix=-v3`,
`--after-seq=-1`). The CLI also rewrites the space form.

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

```bash
# store.db (read-only, seq cursor) → -v3-store
node integrations/grok-bot/rivet-memory/capture/dist/cli.js convert-store \
  path/to/agents/<id>/store.db spool/grokbot-bob-v3-store.jsonl \
  --agent-id <id> --after-seq=-1

# voice-calls/*.json (callId / speaker / atMs) → -v3-voice-<stem>
node integrations/grok-bot/rivet-memory/capture/dist/cli.js convert-voice \
  path/to/agents/<id>/voice-calls/call.json \
  spool/grokbot-bob-v3-voice-call.jsonl --agent-id <id>

# ReadTranscript header (used by pull-bridge.py)
node integrations/grok-bot/rivet-memory/capture/dist/cli.js parse-page page.txt
```

### Backfill Sep 15+ (both formats)

`--input` walks recursively, so the `agent-transcripts` root works. All pages
for one agent are merged by position into a single spool (overlapping or
out-of-order pages produce the same rows as a single pass). Files with no
`--agent-id`, page header id, or `<uuid>/<uuid>.jsonl` path are skipped
(not tagged `grokbot-unknown`). If overlapping pages disagree at a
position, the CLI prints `CONFLICT` and refuses `--write`.

```bash
# dry (default): stats only, zero writes
node integrations/grok-bot/rivet-memory/capture/dist/cli.js backfill \
  --input path/to/agent-transcripts --format ondisk --session-suffix=-v3

# write ingest jsonl (still no DB writes) — one file per agent
node integrations/grok-bot/rivet-memory/capture/dist/cli.js backfill \
  --input path/to/agent-transcripts --format ondisk --session-suffix=-v3 \
  --out spool --write
```

Newer content arrives as ReadTranscript pages. Save each page verbatim, then:

```bash
node integrations/grok-bot/rivet-memory/capture/dist/cli.js backfill \
  --input path/to/pages-dir --format page --session-suffix=-v3 --out spool --write

# or the pull bridge (stores by position, then converts through the same normalizer)
python3 integrations/grok-bot/rivet-memory/capture/pull-bridge.py add <agentId> /tmp/rt-page.txt
python3 integrations/grok-bot/rivet-memory/capture/pull-bridge.py ingest --dry-run --suffix -v3
python3 integrations/grok-bot/rivet-memory/capture/pull-bridge.py ingest --suffix -v3
```

Backfill writes **one spool per agent**. Ingest each spool with its own
`ingest-session.mjs` command. Session / agent / persona come from
`cli.js discover --json` (or the roster). Page backfill and `pull-bridge.py`
are alternatives for ReadTranscript pages — do not mix on-disk and page
rows into the same `-v3` session.

```bash
node integrations/grok-bot/rivet-memory/capture/dist/cli.js discover --json

# one ingest per agent (example: Rivet). Repeat for each discover --json model.
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

`--from-rows` and the Postgres path write `<session>-v3-rows`, not `-v3`.
Stored-row positions are the old sequential ingest ordinals and do not
match source-transcript positions; mixing them in one session would
collide. `--from-rows` cannot restore tool results: the old converter
ignored `result`, so stored tool rows have empty `tool_result` (legacy
rows average ~38 chars). Assistant rows keep the legacy `[tool X]` /
`[thinking]` text. Full fidelity needs a backfill from the source
transcripts.

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

# from a read-only dump of existing rows (SELECT output as jsonl) → -v3-rows
node integrations/grok-bot/rivet-memory/capture/dist/cli.js reclean \
  --session grokbot-rivet-grokbot --from-rows rows.jsonl --dry-run

# from Postgres (RIVETOS_PG_URL in env or ~/.rivetos/.env — never --pg-url) → -v3-rows
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

`src/identity.ts` is the typed source. `discover-models.mjs` is a thin
wrapper over `dist/identity.js`. Historical Rivet/eggbot (and other) tags
live only in `models.json` `overrides`. Discovery scans
`$GROKBOT_AGENTS/*/profile.json`, skips `group.json` and `excludeNames`
(default includes `New Bot`), and applies those overrides so historical
tags do not move. `identityFor` consults that roster before the subagent
fallback. `capture/ingest.mjs` is ingest-only (search/browse/stats are the
memory tools). `pull-bridge.py` calls `cli.js parse-page` instead of its
own header regex.

## Live capture

`watch.mjs` and `run-once.sh` write new-shape rows to `<session>-v3`
(`GROKBOT_SESSION_SUFFIX`, default `-v3`), watch `agents/<id>/store.db`
and `store.db-wal` (WAL mode; both debounce to the same agent) into
`<session>-v3-store` (persisted `seq` cursor), and
`agents/<id>/voice-calls/*.json` into `<session>-v3-voice-<stem>`.
The watcher exits with "build the capture package first" when
`dist/cli.js` / `dist/identity.js` is missing. Watcher state is keyed by
`id + suffix` so migrating `~/.rivetos/capture/state.json` (unsuffixed
size:mtime keys) does not skip the `-v3` sessions. `run-once.sh` stuck
state lives only under `~/.rivetos/grokbot-capture-state/` — it does not
copy the watcher's single `state.json`. `RIVETOS_ROOT` defaults to
`/opt/rivetos`. `capture/ingest.mjs` is a thin wrapper over
`bin/ingest-session.mjs`.

Current Grok Bot chats may be server-side, so local `transcript_entries`
can be empty. The reader still opens the DB read-only and no-ops.

### Deploy notes (no deploy from this PR)

- Rebuild `/opt/rivetos` (`memory-postgres` and
  `@rivetos/grok-bot-rivet-memory-capture`) **before** any `-v3` ingest.
  The grok-bot writer stores caller `ordinal` / `event_id` / `toolResult` /
  `metadata`. Search still prefers a `-v3` sibling inside memory-postgres.
- Enabling the new watcher ingests every on-disk transcript's **full
  history** into `<session>-v3` (there have been no new on-disk files
  since Sep 16). Stop the old watcher/converter first. Do not run both.
- Row-based re-clean (`-v3-rows`) is a separate session from source
  backfill (`-v3`). store.db and voice-calls have their own suffixes.
  Pick one format per session; do not mix.

## Tests

```bash
npx nx test @rivetos/grok-bot-rivet-memory-capture
```

Fixtures are redacted real samples (TEST-NET `192.0.2.1` only). No unredacted
transcripts.
