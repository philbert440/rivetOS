# Rivet Cloud — connect, export, import

Rivet Cloud is hosted memory (`rivetos.cloud`) that any coding harness already
on your laptop can capture into and search. This page covers the public CLI:
`rivetos cloud connect`, `rivetos memory export`, and `rivetos memory import`.

No RivetOS runtime or PGlite is required on the laptop for cloud mode. The
harness hooks talk to Postgres and the embed endpoint directly.

## Connect

You get a customer bundle when the tenant is created:

```
RIVETOS_PG_URL=postgres://tenant_<slug>:<password>@rivetos.cloud:5432/tenant_<slug>?sslmode=require
RIVETOS_EMBED_URL=https://rivetos.cloud/embed/<embed_token>
RIVETOS_EMBED_MODEL=qwen3-embedding-0.6b
```

(`sslmode=require` is mandatory. node-pg verifies against system CAs. Do not
add `sslrootcert=system` — node-pg ENOENTs on that parameter.)

```bash
rivetos cloud connect 'postgres://tenant_demo:…@rivetos.cloud:5432/tenant_demo?sslmode=require' \
  --embed-url 'https://rivetos.cloud/embed/…'
```

What it does:

1. Validates the Postgres URL (`postgres` / `postgresql`, must include
   `sslmode=`) and that the embed URL is `https`.
2. Upserts `RIVETOS_PG_URL`, `RIVETOS_EMBED_URL`, and `RIVETOS_EMBED_MODEL`
   into `~/.rivetos/.env` (created `0600` if missing; other keys kept).
3. Smokes **before** installing hooks: `SELECT count(*) FROM ros_messages` and
   one `POST <embed-url>/v1/embeddings` with `{input:"ping", model}` expecting
   a 1024-d vector.
4. Runs `rivetos plugins install` for detected harnesses (or `--harness <id>`).
5. Prints a checklist:

```
DB ok (12 messages)
embed ok (1024 dims)
claude-code: installed
grok-build: skipped (not found)
next: open your harness and run one turn; then `rivetos memory search …`
```

Flags: `--embed-model` (default `qwen3-embedding-0.6b`), `--harness` (repeatable),
`--root`, `--dry-run` (print the env diff and the install plan; write nothing),
`--yes` (accepted for non-interactive scripts; connect does not prompt).

`rivetos cloud status` shows which env vars are set (**host and database only,
never the password**) and pings DB + embed.

## Export

```bash
rivetos memory export > mem.ndjson.gz
rivetos memory export --out mem.ndjson.gz --since 2026-09-01T00:00:00Z
```

Gzip NDJSON v1. Default destination is stdout so a shell redirect works. The
command refuses to write gzip to a TTY — redirect or pass `--out`.

`--since` filters tables that have `created_at` (or `cited_at` on
`ros_wiki_citations`). Junction rows without a timestamp (`ros_summary_sources`)
are exported in full so foreign keys stay intact.

Uses `RIVETOS_PG_URL` from the environment or `~/.rivetos/.env` (`loadRivetEnv`),
same as the other `rivetos memory` subcommands.

## Import

```bash
rivetos memory import mem.ndjson.gz
rivetos memory import mem.ndjson.gz --dry-run
```

Streaming gunzip → header check → batches of 500 per table:

```sql
INSERT INTO <t> (<cols>)
SELECT <cols> FROM json_populate_recordset(NULL::<t>, $1::json)
ON CONFLICT DO NOTHING
```

Unknown columns in a row are ignored (forward-compat). Before messages:
`SET rivet.defer_embed_enqueue = on` so the insert trigger does not enqueue
one embed job per row. After the file: one
`graphile_worker.add_job('enqueue-unembedded', '{}')` **if** the
`graphile_worker` schema exists (`pg_namespace`). Local-mode databases may
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
Every non-generated, non-vector column of migrations 0001–0016 is included.
**Omitted:** `embedding` and generated tsvector columns (`content_tsv`).
Importers re-embed. Timestamps are ISO-8601, UUIDs are strings, jsonb is
objects.

Not in the dump: `ros_message_chunks` (rebuilt by the embed worker),
`ros_tasks`, wiki provenance/extraction tables.

The same format is used by the cloud API (`GET/POST /api/t/:slug/export|import`).
A file exported from local mode (PGlite, PG18 schema identical) imports into
the cloud and vice versa.

## Local ↔ cloud portability

| Direction     | How                                                                                                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Local → cloud | `rivetos memory export --out dump.ndjson.gz` against the laptop `RIVETOS_PG_URL`, then `rivetos memory import dump.ndjson.gz` after `rivetos cloud connect …` (or the dashboard Import control). |
| Cloud → local | Export from the dashboard or `rivetos memory export` while pointed at the cloud URL, then import into the local store.                                                                           |
| Cloud → cloud | Same file; `ON CONFLICT DO NOTHING` so a re-import is idempotent.                                                                                                                                |

Embeddings are always rebuilt at the destination. After import, wait for the
embed worker (`enqueue-unembedded`) before hybrid search is complete; FTS and
trigram recall work immediately.
