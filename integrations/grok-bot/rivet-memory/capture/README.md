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
- Every output line has `createdAt`. Times never go backwards in a session
  (`max(candidate, lastEmitted+1ms)`). `metadata.time_source` records the
  tier. Source order:
  1. `<timestamp>` wall-clock on user/hidden turns only — never from
     assistant or tool quotes (`tag`).
  2. Record-level `created_at` / `createdAt` / `timestampMs` (store.db / voice)
     (`stored`).
  3. Tool-result `result.success.timestamp` only (epoch ms). Loose
     `result.timestamp` / `part.timestamp` / `new Date(any)` are ignored
     (`tool_epoch`).
  4. Interpolate evenly between the previous and next real stamps
     (`interpolated`).
  5. After the last stamp, inherit at 1s per position (`inherited`).
  6. Before the first stamp, look ahead at −1s per position (`lookahead`).
  7. If the file has no stamps, use
     `file mtime − (lastPosition − position)` ms so the last row ≈ mtime
     (`mtime`).
  Clamp still enforces order. When it moves a time by more than 1s,
  `created_at_original` and `created_at_adjusted_ms` are stored.
  Postgres `NOW()` is never the fallback.
- `tool_result` is read from `result` (ReadTranscript). Content and
  `toolResult` are bounded at **256 KiB** (`CONTENT_LIMIT = 262_144`) after
  base64 / data-URI image payloads are replaced with
  `[image mime=… bytes=… sha256=…]`. 256 KiB is 16× the old 16K recap —
  enough for a long review — while keeping the trigram GIN index and the
  embedding queue off the 3.5M-char generate_image/shell dumps. A 1M cap
  would still have let the 104 mega-rows through. When a value is cut,
  `truncated: true`, `full_*_length`, and
  `session_jsonl_path` + `session_jsonl_line` (claude-code `pointerMeta`)
  let `memory_get_full` re-read the source line.
- Each bot is tagged from the roster (`agent-data/agents/*/profile.json`)
  **before** the subagent fallback. Persona is the profile name. Session is
  `grokbot-<slug>` (`GROKBOT_NODE_ID`, default `grokbot`). Agent is
  `<prefix>-<slug>` (`GROKBOT_AGENT_PREFIX` or `models.local.json`
  `agentPrefix`, default `grokbot`). Groups, unused-slot / placeholder
  profiles, and subagent transcripts are skipped by structure. Unknown ids
  stay `<prefix>-run` / `grokbot-run-<id>`. The agent UUID is in metadata.
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
  `GROKBOT_SESSION_SUFFIX=-v4` re-spools into a sibling of `-v3` (fresh
  state/cursor files; `-v3` rows stay). Row-based re-clean (`--from-rows` /
  Postgres) writes `<session>-v3-rows` so stored-row positions never mix
  with source-transcript ordinals. `agents/<id>/store.db`
  `transcript_entries.seq` writes `<session>${SUFFIX}-store` (seq is not the
  on-disk line index). `voice-calls/*.json` writes
  `<session>${SUFFIX}-voice-<stem>` (turn index is not the line index).
  Watcher state is a per-suffix file
  (`~/.rivetos/grokbot-capture-state${SUFFIX}.json`). `-v3` may inherit
  unsuffixed `state.json`; `-v4` starts empty.   Discovery merges
  `models.json` plus gitignored `models.local.json` overrides into the
  roster so a host can pin a legacy tag or add an override-only bot.
  Unmapped `<uuid>/<uuid>.jsonl` transcripts are reported
  (stderr / `unmappedTranscripts`), not dropped silently. Reclean follows
  `GROKBOT_SESSION_SUFFIX` and refuses already row-shaped sessions.
  Store cursors are `seq:N` under the same map. `run-once.sh` does not treat
  the watcher `state.json` as per-session stuck-policy. `RIVETOS_ROOT`
  defaults to `/opt/rivetos`.
- Re-ingest of the same session skips a row whose `event_id` is already
  stored, and skips an ordinal that is already taken. Dedup holds within
  one session only. After a full-history `-v3` backfill, search and
  recall return both the legacy session and the `-v3` copy until the
  legacy sessions are retired. Nothing is deleted or updated.

## Layout

```
capture/
├── src/                 # normalizer (capture-core)
├── test/fixtures/       # synthetic samples (fake UUIDs / invented text)
├── convert-transcript.py
├── pull-bridge.py
├── discover-models.mjs
├── watch.mjs
├── ingest.mjs
├── run-once.sh
├── models.json          # empty overrides (typed source: src/identity.ts)
├── models.local.example.json
└── models.local.json    # gitignored host overrides (optional)
```

Paths come from env (`GROKBOT_AGENTS`, `GROKBOT_TRANSCRIPTS` /
`GROKBOT_TRANSCRIPT_ROOT`, `GROKBOT_MODELS`, `GROKBOT_SESSION_SUFFIX`).
Nothing in this tree names a host, address, port, or lab layout.

## Session suffixes (do not mix formats)

| suffix             | source                                      | position                   |
| ------------------ | ------------------------------------------- | -------------------------- |
| `-v3` / `-v4`      | on-disk jsonl / ReadTranscript pages        | line index / page position |
| `-v3-rows`         | Postgres / `--from-rows` reclean            | stored ordinal             |
| `-v3-store` / `-v4-store` | `agents/<id>/store.db` `transcript_entries` | `seq`               |
| `-v3-voice-<stem>` / `-v4-voice-<stem>` | `voice-calls/*.json`       | turn index                 |

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

On-disk agent-transcripts jsonl, or a ReadTranscript page (header, JSON
lines, and optional footer). Live / convert defaults to session suffix
`-v3`.

```bash
node integrations/grok-bot/rivet-memory/capture/dist/cli.js convert \
  path/to/agent.jsonl spool/grokbot-alpha-v3.jsonl \
  --agent-id 00000000-0000-4000-8000-000000000001

# same interface the watcher already calls
python3 integrations/grok-bot/rivet-memory/capture/convert-transcript.py \
  path/to/agent.jsonl spool/out.jsonl \
  --agent-id 00000000-0000-4000-8000-000000000001 \
  --session grokbot-alpha-v3
```

On-disk input without `--agent-id` or a page header takes the id from
`<uuid>/<uuid>.jsonl`.

```bash
# store.db (read-only, seq cursor) → -v3-store
node integrations/grok-bot/rivet-memory/capture/dist/cli.js convert-store \
  path/to/agents/<id>/store.db spool/grokbot-beta-v3-store.jsonl \
  --agent-id <id> --after-seq=-1

# voice-calls/*.json (callId / speaker / atMs) → -v3-voice-<stem>
node integrations/grok-bot/rivet-memory/capture/dist/cli.js convert-voice \
  path/to/agents/<id>/voice-calls/call.json \
  spool/grokbot-beta-v3-voice-call.jsonl --agent-id <id>

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

# one ingest per agent (example: Alpha). Repeat for each discover --json model.
# Agent tags are <prefix>-<slug> (default prefix grokbot).
node integrations/grok-bot/rivet-memory/bin/ingest-session.mjs \
  --session-id grokbot-alpha-v3 --agent grokbot-alpha --persona Alpha \
  spool/grokbot-alpha-v3.jsonl
```

### Re-spool as `-v4` (leaves `-v3` rows and state alone)

On a deployed host (`/opt/rivetos`):

```bash
cd /opt/rivetos
npx nx run-many -t build -p @rivetos/capture-core @rivetos/memory-postgres \
  @rivetos/mcp-sidecar @rivetos/grok-bot-rivet-memory-capture

GROKBOT_SESSION_SUFFIX=-v4 GROKBOT_TRANSCRIPT_ROOT="$GROKBOT_TRANSCRIPT_ROOT" \
  RIVETOS_ROOT=/opt/rivetos \
  bash integrations/grok-bot/rivet-memory/capture/run-once.sh
```

Or convert + ingest one file (suffix `-v4`; agent from `discover --json`):

```bash
python3 integrations/grok-bot/rivet-memory/capture/convert-transcript.py \
  "$GROKBOT_TRANSCRIPT_ROOT/<id>/<id>.jsonl" \
  integrations/grok-bot/rivet-memory/capture/spool/grokbot-<slug>-v4.jsonl \
  --agent-id <id> --session grokbot-<slug>-v4 --session-suffix=-v4

node integrations/grok-bot/rivet-memory/bin/ingest-session.mjs \
  --session-id grokbot-alpha-v4 --agent grokbot-alpha --persona Alpha \
  integrations/grok-bot/rivet-memory/capture/spool/grokbot-alpha-v4.jsonl
```

### Re-clean existing grokbot rows (`--dry-run` default)

Never DELETE or UPDATE. Dry-run performs **zero writes** and prints counts.
Do **not** pass the database URL on argv. The read-only rows source loads
`RIVETOS_PG_URL` from the environment or `~/.rivetos/.env`, then runs its
SELECTs inside `BEGIN TRANSACTION READ ONLY` and `ROLLBACK`. Rows are grouped
by `conversation_id` (prod has two conversation rows for
`grokbot-alpha` with the same agent).

`--from-rows` and the Postgres path write `<session>${SUFFIX}-rows`.
Already row-shaped sessions (`*-vN-rows` or rows with `capture_source`)
are refused so tool calls are not split a second time.
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
  --session grokbot-alpha \
  --agent-id 00000000-0000-4000-8000-000000000001 \
  --from-transcript path/to/agent.jsonl \
  --dry-run

# same, then write ingest jsonl for the NEW session (suffix -v3)
node integrations/grok-bot/rivet-memory/capture/dist/cli.js reclean \
  --session grokbot-alpha \
  --agent-id 00000000-0000-4000-8000-000000000001 \
  --from-transcript path/to/agent.jsonl \
  --out spool --write

# from a read-only dump of existing rows (SELECT output as jsonl) → -v3-rows
node integrations/grok-bot/rivet-memory/capture/dist/cli.js reclean \
  --session grokbot-alpha --from-rows rows.jsonl --dry-run

# from Postgres (RIVETOS_PG_URL in env or ~/.rivetos/.env — never --pg-url) → -v3-rows
node integrations/grok-bot/rivet-memory/capture/dist/cli.js reclean \
  --session grokbot-alpha --agent grokbot-alpha --dry-run
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
wrapper over `dist/identity.js`. Committed `models.json` `overrides` stay
empty so real agent ids never land in git.

Slug rule: persona = `profile.json` `name`; session = `${GROKBOT_NODE_ID:-grokbot}-<slug>`;
agent = `${GROKBOT_AGENT_PREFIX:-grokbot}-<slug>`. A deployed host that
needs a non-default prefix or a one-off legacy tag copies
`models.local.example.json` to `models.local.json` (gitignored, same
directory). Discovery loads `models.json` then merges `models.local.json`
when present (local wins). `GROKBOT_MODELS` / `GROKBOT_MODELS_LOCAL` /
`GROKBOT_AGENT_PREFIX` override those paths and the prefix.

Discovery scans `$GROKBOT_AGENTS/*/profile.json` and skips, by structure:
`group.json` present; placeholder / unused-slot profiles (`placeholder`,
`unused`, `kind`, or the product unused-slot name with no extra identity);
subagent profiles (`parentId` / `subagent`). Optional `excludeNames` is
only for per-install local config. `identityFor` consults that roster
before the subagent fallback. Verify the resolved roster with
`discover --json` before a backfill. `-v4` state and cursor files stay
keyed by `id + suffix` / `grokbot-capture-state-v4.json` — they do not
depend on persona names. `capture/ingest.mjs` is ingest-only
(search/browse/stats are the memory tools). `pull-bridge.py` calls
`cli.js parse-page` instead of its own header regex.

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
  `@rivetos/grok-bot-rivet-memory-capture`) **before** any `-v4` ingest.
  The grok-bot writer stores caller `ordinal` / `event_id` / `toolResult` /
  `metadata`, and skips an `event_id` or ordinal already present in that
  session.
- `-v4` is a new sibling of `-v3`. Do not delete or migrate `-v3` rows.
  `GROKBOT_SESSION_SUFFIX=-v4` writes fresh spool/state/cursor files
  (`<session>-v4`, `<session>-v4-store`, `<session>-v4-voice-<stem>`).
  `-v3` state under `~/.rivetos/grokbot-capture-state/` is left alone.
- Row-based re-clean (`-v3-rows`) is a separate session from source
  backfill. store.db and voice-calls have their own suffixes.
  Pick one format per session; do not mix.
- Cutover: after `-v4` is the live writer, retire unsuffixed / `-v2` /
  `-v3` at query time. This package does not DELETE or UPDATE those rows.
  Until they are retired, search and recall show the older copies too.

## Tests

```bash
npx nx test @rivetos/grok-bot-rivet-memory-capture
```

Fixtures are synthetic (fake UUIDs, `example.com`, invented text). They
still cover hidden turns, `<timestamp>` shapes, `send_message` epochs,
tool calls/results, replay blocks, voice calls, and store.db entries.

CI `privacy-scan` hashes every UUID (and grok-bot emails) and compares
against `scripts/privacy-denylist.json`. Add a hash locally with
`node scripts/privacy-denylist-add.mjs '<value>'` — the value is never
written. Fixture `/home/<user>` and `agent-data/agents/<non-fake-uuid>`
paths fail the same job.
