# Kimi Transcript Backfill

One-shot recovery tool. Replays kimi-code's own on-disk `wire.jsonl` transcripts
into the shared RivetOS memory store as `agent = 'rivet-kimi'` rows, restoring
the conversation the hook capture worker never wrote.

## Why it exists

The hook capture (`../capture`) landed tool calls and lifecycle markers but
essentially no conversation. Counted on `phil_memory`, 2026-08-09:

| role | rows |
|------|------|
| `tool` | 1896 |
| `system` | 83 |
| `user` | 1 (a smoke-test row, not a real prompt) |
| `assistant` | 0 |

Two independent causes:

1. `UserPromptSubmit.prompt` arrives as an **array of content parts**, and the
   worker read it with a string-only accessor — every real prompt fell through.
   Fixed in the capture worker, but only for sessions from the fix onward.
2. kimi's `Stop` payload **carries no reply at all**, so assistant text was never
   capturable from hooks in the first place. No capture-side fix recovers it.

Neither is a data-loss problem: kimi-code writes every turn to disk. This tool
reads those files.

## Transcript layout and format

```
$KIMI_CODE_HOME/sessions/            # default ~/.kimi-code/sessions
  wd_<label>_<hash>/                 # one directory per workspace
    session_<uuid>/                  # the session id, verbatim
      agents/
        main/wire.jsonl
        agent-0/wire.jsonl           # subagents, same session
```

`wire.jsonl` is an append-only event log: one JSON object per line, each with a
`type` and a `time` (epoch ms). The lines that carry conversation:

| line | becomes |
|------|---------|
| `context.append_message`, `message.origin.kind = 'user'` | `role = user` |
| `context.append_message`, `origin = system_trigger/subagent` | `role = user` (a subagent's task prompt is its opening turn) |
| `context.append_loop_event` → `event.type = 'content.part'`, `part.type = 'text'` | `role = assistant` |
| …same, `part.type = 'think'` | `role = assistant`, content prefixed `[thinking] ` |
| `tool.call` + matching `tool.result` (by `toolCallId`) | `role = tool` — **off by default**, see below |

Deliberately dropped, counted in the summary as "not-a-message lines":
`origin.kind = injection` (permission-mode banners, todo reminders, goal
re-statements), `background_task` notifications, `skill_activation` preambles,
and `system_trigger/goal_continuation`. All machine-generated context noise that
would dilute recall. Also dropped: `llm.request`, `usage.record`, `step.begin` /
`step.end`, `goal.*`, `config.update`, `turn.*`, compaction events. A
`context.apply_compaction` line carries kimi's own summary of the turns it
dropped; the tool does not currently write it.

### Protocol version drift

The transcripts on ct116 span protocol `1.4` (68 files) and `1.5` (4 files). The
drift is purely additive and touches nothing this parser reads:

| | 1.4 | 1.5 |
|---|---|---|
| `message.id` on `context.append_message` | absent | present |
| `step.end.providerFinishReason` / `rawFinishReason` | absent | present |
| `turn.ended`, `profile.bind` line types | absent | present |
| `tool.call.description` / `display` | usually present | usually absent |

So there is **one code path for both**, and an unknown future version parses on
the same best-effort basis rather than being rejected. Fixtures cover 1.4 and
1.5 side by side, so a genuinely breaking version shows up as a test failure
rather than a silent under-count.

Structural facts worth knowing, all verified across the 72 real files:

- `content.part` events are **whole parts, not streaming deltas** — exactly one
  `text` part per step, up to ~30k characters.
- Every `content.part` has a globally unique `uuid` (1790 parts, 1790 uuids).
- Every message content is an array with exactly one block in practice, but the
  parser handles many (joined on a single space).

## Identity and dedup

The tool reuses the capture worker's identity scheme rather than inventing one:
`contentHashEventId` is byte-identical (a test asserts that against the capture
module itself), rows carry `metadata.event_id`, and the writer inserts only when
that id is absent from the conversation. Re-running is therefore a no-op.

Two deliberate consequences:

- **User rows collide with live-captured ones.** A backfilled prompt hashes with
  `sourceEvent = 'UserPromptSubmit'` and the same space-joined text-part
  rendering the fixed capture worker produces, so replaying a session that
  capture has since covered inserts nothing. A test pins this by hashing the
  same prompt through both code paths.
- **Assistant and thinking rows fold the wire event's `uuid` into the
  sourceEvent slot** (`wire:content.part:<uuid>`). Capture never writes these, so
  there is nothing to collide with, and the uuid keeps two subagents that emit
  identical text from collapsing into a single row — while replaying the same
  line twice still yields one.

Prompt *rendering* has to match too, not just the hash function: both paths trim,
on both shapes. A prompt arriving as a bare string on the hook and as a
one-element parts array in the transcript must produce the same bytes, or every
prompt with surrounding whitespace doubles up. The parity test covers the string
shape today and the array shape the moment the capture fix lands — that case is
feature-gated on whether the installed capture worker extracts from arrays at
all, so it reports as skipped until then rather than quietly passing.

Inherited from capture, and worth knowing: two *identical* user prompts in one
session hash the same and collapse to one row. The live dry run shows exactly
one such pair across 43 sessions.

### Why tool rows are off by default

Live capture already landed 1896 `role = tool` rows from `PostToolUse`, and the
wire log holds 2150 tool calls for the same sessions. The two renderings of a
tool *result* cannot be shown to serialize identically, so their hashes differ
and `--include-tools` would mostly add near-duplicates. Use it only for a
session capture never saw.

## Timestamps and ordering

Every wire line carries `time`, so rows get the transcript's own `created_at`
rather than ingest time — the recovered history sorts into the right place
against everything else in the store.

Session reads order by `created_at DESC, id DESC`, and `id` is a random uuid, so
rows tied on the millisecond would come back shuffled (this is what
`session-history-order.test.ts` guards for the live path). Wire timestamps *do*
tie — a `think` part and the `text` part that follows it routinely share a
millisecond. The parser therefore nudges each row to at least 1ms after its
predecessor within a file. The unmodified wire clock is always preserved in
`metadata.event_ts`, so nothing is lost, and the nudge does not enter the hash —
dedup is unaffected.

Rows from a session's several agent slots are merged and sorted on the wire
clock, with the slot name as a deterministic tiebreaker. The nudge is per-file,
so a run of tied rows in one slot can end up a few milliseconds past a row from
another slot whose true clock sat between them. Accepted: slots are concurrent
agents whose exact interleaving was never meaningful, within-slot order is the
part that reads as a conversation, and `metadata.event_ts` still carries every
untouched clock.

## Usage

```bash
npm run build                       # dist/kimi-transcript-backfill.js

# Dry run — the default. Reads transcripts, opens the DB read-only, reports
# exactly what a write would insert and skip.
node dist/kimi-transcript-backfill.js --dry-run

# Dry run with no database at all.
node dist/kimi-transcript-backfill.js --dry-run --offline

# Commit.
node dist/kimi-transcript-backfill.js --write
```

| flag | meaning |
|------|---------|
| `--dry-run` | report only, write nothing — **default** |
| `--write` (`--no-dry-run`) | actually insert |
| `--offline` | dry run without connecting to Postgres |
| `--sessions-dir DIR` | default `$KIMI_CODE_HOME/sessions`, else `~/.kimi-code/sessions` |
| `--pg-url URL` | default `$RIVETOS_PG_URL`, else `RIVETOS_PG_URL` in `~/.rivetos/.env` |
| `--session ID` | restrict to one session id, repeatable |
| `--no-thinking` | skip the `[thinking] …` rows |
| `--include-tools` | also emit `role = tool` rows (see above) |
| `--json` | machine-readable summary instead of the table |

A dry run is safe by construction: the filesystem is only read, and the
connection is pinned with `SET default_transaction_read_only = on` before any
query — the code path issues no `BEGIN`, `INSERT`, or `UPDATE`, and the server
would reject them if it did.

### Failure isolation

- A line that is not parseable JSON is counted (`bad` column) and skipped; the
  rest of the file still ingests. A session killed mid-write leaves a truncated
  final line, which is exactly this case.
- A file that cannot be read fails that file only; its siblings and the other
  sessions continue, and the session is reported `read-error(n)`.
- A database error fails that session only; the transaction rolls back and the
  run continues, reporting `db-error: …` and exiting non-zero at the end.
- Writes are one transaction per session, taken under
  `pg_advisory_xact_lock(hashtext(session_key))` — the same lock the capture
  worker takes, so a live session and a backfill cannot interleave on one
  conversation.

### How the conversation row is handled

Not quite capture's path, deliberately. Capture does SELECT-then-INSERT and never
touches an existing conversation row. This tool upserts on the
`(session_key, agent)` unique index from migrations 0009/0010 — the arbiter the
memory adapter's own `ensureConversation` uses — with
`ON CONFLICT DO UPDATE SET updated_at = NOW()`. One row per `(session_key, agent)`
is the invariant both share; bumping `updated_at` is the honest signal for a
conversation that just grew by 700 rows.

Two refinements on top of that:

- **A session with nothing to write opens no transaction at all**, so re-running
  the backfill over 43 already-ingested sessions leaves every conversation row
  byte-identical, `updated_at` included.
- **A conversation created cold by this tool gets `active = false`.** Unlike the
  adapter's upsert, this one never forces `active = true`: a transcript replayed
  from disk is finished history, not a resumed session, and flipping a session
  live would put it back in the adapter's `active = true` reads. The unlikely case
  is backfilling a session that is *still running*, where capture will re-activate
  the conversation on its next hook anyway.

## Operator runbook

Run on the kimi node (ct116, `rivet-kimi`), which has both the transcripts and
`RIVETOS_PG_URL` in `~/.rivetos/.env`.

```bash
cd /opt/rivetos/integrations/kimi/rivet-memory/backfill
npm run build

# 1. Dry run. Read the totals line and the per-session table.
node dist/kimi-transcript-backfill.js --dry-run

# 2. Snapshot the conversation list, for step 4.
#   SELECT session_key, count(*) FROM ros_conversations
#    WHERE agent='rivet-kimi' GROUP BY 1 ORDER BY 1;

# 3. Rehearse ONE session that capture already covered, end to end.
node dist/kimi-transcript-backfill.js --write --session session_<uuid>

# 4. Re-run the query from step 2 and diff it.
#   NO new session_key may appear, and the row count must not change.

# 5. Commit the rest. Re-running is safe — step 3's rows come back as skips.
node dist/kimi-transcript-backfill.js --write

# 6. Verify.
#   SELECT role, count(*) FROM ros_messages WHERE agent='rivet-kimi' GROUP BY 1;
```

Step 4 is the one check worth not skipping. Everything here assumes the session
id kimi puts in its hook payloads is the same string as its transcript directory
name — if it were not, the backfill would silently fork a *second* conversation
per session rather than filling in the existing one. The dry run's `skipped=1`
does not prove alignment (one skip could be an intra-batch duplicate). A rehearsal
against an already-captured session that adds rows and no conversation does.

Expected volumes, measured by a real dry run on ct116 on 2026-08-09 (73
transcripts, 44 sessions). The set grows every time kimi runs, so treat these as
the shape of the answer rather than exact figures:

```
totals: files=73 user=83 assistant=570 thinking=1039 tool=0 malformed=0
        would-insert=1691 skipped=1
not-a-message lines: tool:disabled=2162 part:empty=190 origin:injection=165
        origin:system_trigger:goal_continuation=22 origin:background_task=16
        origin:skill_activation=1
```

Note the side effect: ~1700 inserts enqueue ~1700 embedding jobs via the
`notify_embedding_queue` trigger. That is normal throughput for the embedding
worker, but expect the queue to be busy for a while after the run.

## Tests

```bash
npm test        # or: npx tsx test/backfill.test.ts
```

No database and no kimi install required. Fixtures under `test/fixtures/wire/`
are synthetic — real line shapes, invented content, no real paths or prompts.

Coverage: protocol 1.4 and 1.5 parsing, role mapping, injection filtering, tool
pairing (including a call whose result never arrived), `--no-thinking`,
timestamp preservation and the monotonic nudge, per-line error isolation against
a deliberately corrupted fixture, hash parity with the capture worker (the
function, a live-vs-backfill prompt collision, and a feature-gated array-shape
collision that activates when the capture fix lands), prompt-rendering parity
including trim on both shapes, dedup against a stubbed client (write twice →
inserted then skipped), greenfield dry-run counts matching what a write would do,
an empty plan issuing no query at all, a doubled transcript collapsing to one row
per event, dry-run issuing no write, discovery over a real directory layout, and
argument parsing.
