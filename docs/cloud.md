# Rivet Cloud — connect, export, import

> **Note:** The `rivetos cloud` commands ship in the next RivetHub release and
> are not in the current installer yet.

Rivet Cloud is hosted memory (`rivetos.cloud`) that any coding harness already
on your laptop can capture into and search. This page covers the public CLI:
`rivetos cloud connect`, `rivetos cloud export`, `rivetos cloud import`,
`rivetos memory export`, and `rivetos memory import`.

No RivetOS runtime or PGlite is required on the laptop for cloud mode. The
harness hooks talk to Postgres and the embed endpoint directly.

## Connect

You get a customer bundle when the tenant is created:

```
RIVETOS_PG_URL=postgres://tenant_<slug>:<password>@rivetos.cloud:5432/tenant_<slug>?sslmode=require
RIVETOS_EMBED_URL=https://rivetos.cloud/embed/<embed_token>
RIVETOS_EMBED_MODEL=qwen3-embedding-0.6b
RIVETOS_CLOUD_TOKEN=<tenant_token>
```

(`sslmode` must be `require`, `verify-ca`, or `verify-full`. `disable`,
`allow`, `prefer`, and a missing sslmode are rejected. node-pg verifies
against system CAs. Do not add `sslrootcert=system` — node-pg ENOENTs on
that parameter.)

```bash
rivetos cloud connect 'postgres://tenant_demo:…@rivetos.cloud:5432/tenant_demo?sslmode=require' \
  --embed-url 'https://rivetos.cloud/embed/…' \
  --token '…'
```

What it does:

1. Validates the Postgres URL (`postgres` / `postgresql`, `sslmode` of
   `require` / `verify-ca` / `verify-full`) and that the embed URL is `https`.
2. Upserts `RIVETOS_PG_URL`, `RIVETOS_EMBED_URL`, `RIVETOS_EMBED_MODEL`, and
   (when `--token` is passed) `RIVETOS_CLOUD_TOKEN` into `$RIVETOS_ENV_FILE`
   if set, otherwise `~/.rivetos/.env` (created `0600` if missing; existing
   files are chmod'd `0600` even when contents do not change; other keys
   kept). The same path is passed to `plugins install` so a custom env file
   cannot keep old credentials.
3. Smokes **before** installing hooks: `SELECT count(*) FROM ros_messages` and
   one `POST <embed-url>/v1/embeddings` with `{input:"ping", model}` expecting
   a 1024-d vector.
4. Runs `rivetos plugins install` for detected harnesses (or `--harness <id>`)
   with `overrideEnv: true`, so an existing `~/.hermes/.env` is rewritten to
   the new `RIVETOS_PG_URL` / `RIVETOS_EMBED_URL` (other lines kept, file
   `0600`). Ordinary `rivetos plugins install` still preserves a nonempty
   Hermes `RIVETOS_PG_URL`.
5. Prints a checklist:

```
DB ok (12 messages)
embed ok (1024 dims)
claude-code: installed
grok-build: skipped (not found)
next: open your harness and run one turn; then use the memory_search tool
```

Flags: `--embed-model` (default `qwen3-embedding-0.6b`), `--token` (written as
`RIVETOS_CLOUD_TOKEN`), `--harness` (repeatable), `--root`, `--dry-run` (print
the env diff and the install plan; write nothing), `--yes` (accepted for
non-interactive scripts; connect does not prompt).

`rivetos cloud status` shows which env vars are set (**host and database only,
never the password**) and pings DB + embed.

## Which export/import command?

| Store                                               | Export                  | Import                  |
| --------------------------------------------------- | ----------------------- | ----------------------- |
| Local / self-hosted datahub (owner Postgres URL)    | `rivetos memory export` | `rivetos memory import` |
| Rivet Cloud (`RIVETOS_PG_URL` host `rivetos.cloud`) | `rivetos cloud export`  | `rivetos cloud import`  |

Tenant roles on Rivet Cloud can INSERT conversations/messages but cannot INSERT
summaries/wiki or enqueue graphile jobs. `rivetos memory import` against a
`rivetos.cloud` URL prints a hint to use `rivetos cloud import` and exits 2
without attempting a half-failed restore.

## Cloud HTTPS export / import

Host and slug come from `RIVETOS_PG_URL`: **hostname** (not the Postgres port)
and database name with a leading `tenant_` stripped (`tenant_demo` → `demo`).
The bearer token is `RIVETOS_CLOUD_TOKEN` (set by `rivetos cloud connect --token`).

```bash
rivetos cloud export --out mem.ndjson.gz
rivetos cloud export > mem.ndjson.gz
rivetos cloud import mem.ndjson.gz
```

- `GET https://<host>/api/t/<slug>/export` — `Authorization: Bearer <token>`,
  `Accept: application/gzip`. Uses `node:https` `request()` and streams the
  response to `--out` or stdout (does not buffer the gzip, no socket timeout).
  Default destination is stdout; refuses gzip to a TTY (redirect or `--out`).
  Progress (bytes received) is printed when writing to `--out`. An inactivity
  guard of 120 seconds applies to the response.
- `POST https://<host>/api/t/<slug>/import` — streams the gzip file with
  `fs.createReadStream` piped into `node:https` `request()`
  (`Content-Type: application/gzip`, `Content-Length` from `fs.stat`,
  `Authorization: Bearer <token>`). No socket timeout; an inactivity guard of
  120 seconds on the response is the only limit. Prints bytes sent from the
  read stream. On a server error, prints the JSON `committed` counts if present.

## Direct (local / datahub) export

```bash
rivetos memory export > mem.ndjson.gz
rivetos memory export --out mem.ndjson.gz --since 2026-09-01T00:00:00Z
```

Gzip NDJSON v1. Default destination is stdout so a shell redirect works. The
command refuses to write gzip to a TTY — redirect or pass `--out`.

Export pins one client, `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`,
and reads each table through a server-side cursor in pages of 1000 (backpressure
on the gzip writer is respected). The cursor and transaction are closed on
success and in `finally` on failure, so the dump is one snapshot.

Uses `RIVETOS_PG_URL` from the environment or `~/.rivetos/.env` (`loadRivetEnv`),
same as the other `rivetos memory` subcommands.

### `--since` closure

`--since` is not an independent timestamp filter per table. The dump is the
**dependency closure** of the selected rows so it restores into an empty schema:

- **messages** — `created_at >= --since`.
- **conversations** — the union of (1) rows with `created_at` or `updated_at`
  at or after `--since` and (2) the conversation of every exported message (and
  of selected summaries, including recursive parents). Older conversations are
  pulled in when a recent message needs them.
- **summaries** — `created_at >= --since`, plus each selected row's
  `parent_id` chain (recursive) so the DAG can be inserted.
- **summary_sources** — only rows whose `summary_id` is in the exported
  summaries **and** whose `message_id` is in the exported messages. Bound with
  `= ANY($1::uuid[])` over those id sets (chunks of 5k). Junction rows are
  never exported in full “to keep FKs”; dangling endpoints are omitted instead.
- **wiki** — when `--since` is **absent**, `ros_wiki_topics`,
  `ros_wiki_redirects`, and `ros_wiki_citations` are exported in full. When
  `--since` is **present**: topics with `created_at` or `updated_at` >= the
  cutoff, plus redirects whose `to_slug` is one of those topics, plus citations
  whose `topic_slug` is one of those topics.

## Direct (local / datahub) import

```bash
rivetos memory import mem.ndjson.gz
rivetos memory import mem.ndjson.gz --dry-run
```

Connects the pool client before consuming the gzip so a slow connect cannot
drop the header. Then `pipeline(source, gunzip)` with the readline iterator
already attached, so a missing file or truncated gzip rejects the import (not
an unhandled source error). Header check, then batches of 500 per table.

Each batch is grouped by the **exact present column set**. One `INSERT` per
shape names only those columns, so omitted keys take SQL defaults. An explicit
JSON `null` is a present key and is inserted as NULL. Empty column sets use
`DEFAULT VALUES`.

```sql
INSERT INTO <t> (<present-cols>)
SELECT <present-cols> FROM json_populate_recordset(NULL::<t>, $1::json)
ON CONFLICT DO NOTHING
```

Unknown columns in a row are ignored (forward-compat).

`ros_conversations` also has `UNIQUE (session_key, agent)`. After each
conversation batch the importer resolves destination ids with
`SELECT id, session_key, agent … WHERE (session_key, agent) IN (…)` and keeps
an `incoming id → destination id` map for the rest of the import. Messages
are rewritten through that map before insert. A natural-key hit on a different
id is counted in `merged.ros_conversations`. A message whose conversation is
not in the map and does not exist in the destination is counted in
`skipped.orphan_messages` and is not inserted. Wiki topics already merge on
PK `slug`; summaries still conflict on `id` only (their nullable
`conversation_id` is rewritten through the same map, or dropped if dangling).

Each messages and summaries batch runs in `BEGIN` … `COMMIT` with
`SET LOCAL rivet.defer_embed_enqueue = on` so the insert trigger does not
enqueue one embed job per row, the GUC does not leak to later pool borrowers,
and a summaries-only dump still defers. Failure `ROLLBACK`s that batch.

**Summaries** are two-pass (same as the cloud API importer): insert with
`parent_id` omitted (NULL), then `UPDATE` parent links after every summary in
the file is present. Unresolved parent ids (child inserted, parent missing) are
counted on the result as `unresolvedParentLinks`.

After the file: one `graphile_worker.add_job('enqueue-unembedded', '{}')` **if**
the `graphile_worker` schema exists (`pg_namespace`). Local-mode databases may
not have it yet — import then prints a hint and skips the enqueue.

`--dry-run` parses and validates the file without writing.

## What is exported

Line 1 is the header:

```json
{
  "type": "rivet-memory-export",
  "version": 1,
  "exported_at": "<iso>",
  "source": { "kind": "cloud|local|datahub", "id": "<slug|hostname>" },
  "tables": [
    "ros_conversations",
    "ros_messages",
    "ros_summaries",
    "ros_summary_sources",
    "ros_wiki_topics",
    "ros_wiki_redirects",
    "ros_wiki_citations"
  ]
}
```

Following lines are `{"t":"<table>","r":{…}}` in that table order (FK-safe).
Every non-generated, non-vector column of migrations 0001–0016 is included
except embed bookkeeping.
**Omitted:** `embedding`, generated tsvector columns (`content_tsv`), and
`embed_status` / `embed_error` / `embed_failures` (and any `embedded_at`-style
column) on `ros_messages`, `ros_summaries`, and `ros_wiki_topics`. Importers
get SQL defaults (NULL status) and re-embed; terminal status in a dump would
skip `enqueue-unembedded`. Timestamps are ISO-8601, UUIDs are strings, jsonb
is objects.

Not in the dump: `ros_message_chunks` (rebuilt by the embed worker),
`ros_tasks`, wiki provenance/extraction tables.

The same format is used by the cloud API (`GET/POST /api/t/:slug/export|import`).
A file exported from local mode (PGlite, PG18 schema identical) imports into
the cloud (via `rivetos cloud import`) and vice versa.

## Local ↔ cloud portability

| Direction     | How                                                                                                                                                             |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local → cloud | `rivetos memory export --out dump.ndjson.gz` against the laptop `RIVETOS_PG_URL`, then `rivetos cloud import dump.ndjson.gz` (or the dashboard Import control). |
| Cloud → local | `rivetos cloud export --out dump.ndjson.gz`, then `rivetos memory import dump.ndjson.gz` into the local store.                                                  |
| Cloud → cloud | Same file through `rivetos cloud import`; `ON CONFLICT DO NOTHING` so a re-import is idempotent.                                                                |

Embeddings are always rebuilt at the destination. After import, wait for the
embed worker (`enqueue-unembedded`) before hybrid search is complete; FTS and
trigram recall work immediately.
