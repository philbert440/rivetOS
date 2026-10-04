# `@rivetos/memory-sqlite`

SQLite implementation of the RivetOS `Memory` contract. Opt-in via:

```yaml
memory:
  sqlite:
    path: ~/.rivetos/memory.sqlite
```

WAL file store, append + session/task history, FTS5 + vector search,
summaries, wiki, tags, one file per user.

Embeddings and hybrid search: set `embed_endpoint` + `embed_model` (or
`RIVETOS_EMBED_URL` / `RIVETOS_EMBED_MODEL`). An in-process job loop
(`ros_jobs`, `jobs.ts`) embeds messages in the background, vectors are stored
on the row as float32 BLOBs, and `search` fuses full-text, literal-match and
vector arms with the policy shared with Postgres (`@rivetos/memory-core`).
Vector search is an exact scan behind the `VectorIndex` interface — no native
extension. Without an endpoint search stays full-text and nothing is queued;
rows written meanwhile are embedded by a sweep once an endpoint is set.

Summaries: set `compactor_endpoint` + `compactor_model` (or
`RIVETOS_COMPACTOR_URL` / `RIVETOS_COMPACTOR_MODEL`). The job loop compacts
conversations into leaf, branch and root summaries (`ros_summaries`,
`compaction.ts`) with the prompts and batch policy shared with the Postgres
compaction worker. Summaries are full-text indexed, embedded when an embedding
endpoint is set, and returned by `search` for scope `summaries` or `both`.
Without an endpoint nothing is summarized and no text leaves the machine.

Wiki: `wiki_extraction: true` (or `WIKI_EXTRACTION=1`) with a compactor
endpoint mines each leaf summary into wiki pages (`wiki.ts`). Pages are
markdown files under `wiki_dir/topics` in a git repository, written by the
`WikiWriter` shared with the Postgres pipeline (`@rivetos/wiki-core`); the
SQLite file holds the topic index (`ros_wiki_topics` + FTS, provenance,
citations, redirects, per-summary extraction marks). Topic search fuses
full-text, a literal slug/title/alias match and, with an embedding endpoint,
a vector leg. The turn context gets a wiki section and the den serves
`/api/wiki` and `/wiki` from this index. The on-demand `consolidate-wiki`
and `recompile-wiki` tasks are in `wiki-maintenance.ts`.

Session tags: `memory.tags()` reads and writes `ros_tags` with the same
lifecycle as the Postgres backend (`add` is born accepted, `propose` writes
suggestions, `decide` accepts or rejects, a rejected tag is never
re-proposed, `forSessionKeys` resolves a session through its key aliases).
Tags are served over HTTP and through the `memory_tags` tool (below).

Tagging on the loop (`tagging.ts`, `tag-vocabulary.ts`): a captured session
gets the rule-based `project:` tag from its working directory, each leaf
summary gets tag suggestions from the tagger (same prompt and parser as
Postgres) on the summary and on its session, and the vocabulary
(`ros_tag_taxonomy`) can be added to, decided and merged. A tag on a summary
counts for its conversation in tag filters and counts.

HTTP and tools: `memory.backend()` implements `MemoryBackend`
(`@rivetos/types`), and the runtime mounts the den's `/api/capture` and
`/api/memory/*` routes on it. Harness capture hooks, the hub's Memory pages
(search, browse, stats, health, tags) and the MCP sidecar's den transport
work on a SQLite node with the same wire contract as Postgres. The agent
gets `memory_search`, `memory_browse`, `memory_stats`, `memory_get_full` and
a read-only `memory_tags` (adding and deciding tags is a person's call, over
HTTP).

Users (`routing.ts`): the configured file is the node owner's. Every other
user in the users registry gets `users/<userId>/memory.sqlite` beside it,
opened as a full store of its own (job loop, wiki directory, tags). Turns,
captures, memory requests and tool calls that den resolved to such a user go
to their file and never to the owner's; one whose file cannot be opened is
refused. Every conversation and message carries `owner_user_id`, the user
whose store it was written to. `per_user_files: false` turns the per-user
files off: other users then get no memory here.

A session the node spawns for another user (a claude-cli turn, a hub
terminal) reaches that user's file through the den with a per-user token
(`RIVETOS_USER_TOKEN`; see `packages/types/src/user-tokens.ts`).

Moving memory: `rivetos memory export` and `import` read and write the gzip
NDJSON v1 dump that the Postgres backend uses (`portability.ts`), so a store
moves between SQLite and Postgres in either direction. Vectors are not in
the file; the importing node re-embeds. One file per command: on a node
with other users, each user's file under `users/<userId>/` is exported
separately (`--sqlite <file>`).

Local mode: `rivetos local init --db sqlite` sets up a node whose memory and
tasks are SQLite files, with no database process.

Uses Node's built-in `node:sqlite` (`DatabaseSync`). No native addons.
