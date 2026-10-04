# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Compaction worker

- A burst of errors from the compactor's LLM provider no longer stalls compaction until a restart. `RIVETOS_COMPACTOR_TRANSIENT_STATUSES` (e.g. `403,404`) lists the 4xx codes the primary returns while overloaded; they retry like a 5xx and fail as retryable, not terminal.
- `RIVETOS_COMPACTOR_FALLBACKS`: ordered `url|model|KEY_ENV|STATUSES` endpoints tried when the primary fails, each with its own key variable and transient codes. After an outage the worker stays on the endpoint that answered for `RIVETOS_COMPACTOR_FALLBACK_COOLDOWN_MINUTES` (default 15); a request-scoped 400/413/422 or an unparseable wiki answer moves only that call. An endpoint with a fallback after it times out per attempt after `RIVETOS_COMPACTOR_FALLBACK_ATTEMPT_TIMEOUT_SECONDS` (default 300). When every endpoint fails, the error names each one and stays retryable if any endpoint's failure was. Truncation is not failed over. Summaries record the model that wrote them. Both `extract-wiki` and `recompile-wiki` send unparseable JSON to the next endpoint. Retry backoff gains ±20% jitter. The Docker compose service forwards the new variables. See docs/CONFIG-REFERENCE.md → Compaction worker.
- Invalid compactor settings exit at startup instead of being dropped: a non-4xx transient code, a non-http(s) URL, a fallback entry with more than four fields, a cooldown or timeout that is not a positive integer.

### Phone pairing

- Pair RivetHub for Android by scanning a QR code instead of copying a certificate file: Settings → Pair a phone (desktop or browser, owner only), `rivetos pair <name>` on a node that is already set up, or `rivetos local --device <name>`. The QR carries the gateway URL, a one-time token (10 minutes, one use, rotated on every re-show) and the SHA-256 of den's TLS leaf, which the phone pins to redeem the token at the new `POST /api/devices/pair` for its PKCS#12 and passphrase. That route sits above the mTLS gate; `GET/POST /api/phone-pairing` (behind it, owner only) back the Settings card. Den reloads `users.json` after a Settings pairing so the phone works without a restart.
- `rivetos pair` never writes `config.yaml` and never creates a `users.json`. It refuses a name that already has a device certificate; the certificate stays in `issued/` so `rivet-ca.sh revoke device:<name>` can find it. The QR points at `--host`, else a concrete `den.host`, else the first LAN address. `rivetos pair --check` reports whether the node can pair, and Settings uses it to decide whether to offer the button.
- `rivetos local --device` with `--no-lan` (or no LAN address) prints the p12 path and passphrase for a manual import, as before.
- New den env: `RIVETOS_DEN_PAIRING_DIR` (default `~/.rivetos/devices/pairing`) and `RIVETOS_DEN_PAIR_CLI` (the in-process gateway passes the install's CLI).
- `apps/rivethub-android`: Enroll → Scan pairing QR (CameraX + ZXing core, Apache-2.0); the certificate-file flow stays. Android 16+ asks for the local-network (Nearby devices) permission before redeeming. If the code redeemed but connecting failed, the phone keeps its certificate and Connect retries without a new code.

### Capture redaction

- Optional write-path redaction in `@rivetos/capture-core` (`createCaptureWriter`).
  Off by default: with `redaction` unset and `RIVETOS_CAPTURE_REDACTION` unset,
  posted/spooled bytes are unchanged. When enabled (options or
  `RIVETOS_CAPTURE_REDACTION=1`), built-in detectors plus optional operator
  regexes run on message `content`, `tool_result`, and `tool_args` before the
  16k cap; logs report a span count only. Config surface:
  `memory.capture.redaction` (`enabled`, `builtins`, `patterns`) — validated in
  boot and documented in CONFIG-REFERENCE. YAML→hook injection is not wired yet;
  use the env flag or pass `redaction` explicitly.

### Memory

- New package `@rivetos/memory-core`: the backend-neutral half of the memory system (relevance scoring and RRF, the hybrid fusion policy, compaction prompts and formatters, wiki extraction prompts and patch parsing), with no database or network dependency. `@rivetos/memory-postgres` re-exports everything it exported before, so nothing changes for existing imports; the SQLite backend can now share the same ranking and prompts.
- SQLite memory backend: the wiki. With `memory.sqlite.wiki_extraction` (or `WIKI_EXTRACTION=1`) and a summarization endpoint, leaf summaries are mined into wiki pages on the in-process job loop with the prompts, patch parser, tag rules and page writer of the Postgres pipeline; pages are git-backed markdown files under `wiki_dir` (default: the shared `wiki` directory) and the SQLite file holds the topic index, provenance, citations, redirects and per-summary extraction marks (schema version 5). Topic search fuses full-text, a literal slug/title/alias match and a vector leg; topics are embedded when an embedding endpoint is set. The turn context gains a wiki section, and the den's `/api/wiki` and `/wiki` routes are served from the SQLite index on a SQLite node (`MemoryBackend.wiki()`). `WikiWriter` moved from the compaction worker into `@rivetos/wiki-core`, and the pure wiki tag rules into `@rivetos/memory-core`; both are re-exported under their old paths. The manual consolidate and recompile tasks are not ported.
- SQLite memory backend: capture, the hub's Memory pages and the memory tools. A new `MemoryBackend` interface in `@rivetos/types` describes what a memory store offers beyond the core `Memory` contract (capture batches, search/browse/stats/health responses, tags, tools), and backend-neutral `/api/capture` and `/api/memory/*` routes in `@rivetos/core` serve it with the wire contract of the Postgres routes. The SQLite plugin implements it (`memory.backend()`), the runtime mounts the routes when the registered memory offers a backend, and the plugin registers `memory_search`, `memory_browse`, `memory_stats`, `memory_get_full` and `memory_tags` with the agent. Harness capture hooks and the MCP sidecar's den transport therefore work against a SQLite-only node. Requests stamped for a routed user are refused (the file is the owner's), the agent's tools refuse a turn that belongs to another user, and the agent's `memory_tags` cannot add or decide; vocabulary edits answer 501. Booting with `memory.sqlite` and no `memory.postgres` block no longer throws while resolving the Postgres URL. The relative time-window helpers moved from the Postgres plugin into `@rivetos/memory-core`.
- SQLite memory backend: summaries. With `memory.sqlite.compactor_endpoint` and `compactor_model` (or `RIVETOS_COMPACTOR_URL` / `RIVETOS_COMPACTOR_MODEL`) set, the in-process job loop compacts conversations into leaf, branch and root summaries with the prompts and batch policy of the Postgres compaction worker, including the shrink-on-truncation rule and the stale-tail flush. Summaries are full-text indexed, embedded when an embedding endpoint is set, and returned by `search` for scope `summaries` and `both` (they also feed the turn context). The file schema moves to version 4 on open (`ros_summaries`, `ros_summary_sources`, `ros_summaries_fts`). The batch policy (`leafFloorFor`, `shrinkLeafBatch`, thresholds) moved from the compaction worker into `@rivetos/memory-core`.
- SQLite memory backend: embeddings and hybrid search. With `memory.sqlite.embed_endpoint` (or `RIVETOS_EMBED_URL`) set, messages are embedded by a job loop inside the runtime — no worker service — and stored in the file; `search` fuses full-text, a literal-match arm and a vector arm with the same ranking policy and quality floor as Postgres, and falls back to the other arms when a query embedding fails. Vector search is an exact scan behind a `VectorIndex` interface (no native extension). Changing the embedding model re-embeds. The file schema moves to version 3 on open (new `ros_jobs` and `ros_meta` tables, vector columns); the phase-1 embed queue is carried over. Text composition, chunking and the unembeddable-content classifier moved from the embedding worker into `@rivetos/memory-core` so both backends embed the same text.
- Opt-in SQLite memory backend (`plugins/memory/sqlite`, `@rivetos/memory-sqlite`) behind the
  `Memory` contract: WAL file store, append, session/task history, settings, and FTS5 search.
  Config: `memory.sqlite.path`. Mutually exclusive with `memory.postgres`. With the block
  unset, behaviour is unchanged. Phase 1 implements the in-process `Memory` write/search path
  (chat append works); HTTP `/api/capture` and memory MCP/HTTP tool parity remain Postgres-gated
  and are deferred with vectors, compaction, wiki, multi-user routing, and Postgres import/export.

### Providers and embeddings — `token_command`, wire-shape, model catalog

- New leaf package `@rivetos/token-command`: argv-only bearer mint with TTL cache and invalidate-on-401 (`createTokenSource`, `createAuthorizedFetch`), embeddings wire-shape helpers (`openai` / `native`), and a model catalog with a static floor plus background endpoint refresh. Dual-consume leaf (no `"type": "module"`, same shape as `@rivetos/types`) so CJS-compiled plugins can import it.
- Providers `anthropic`, `xai`, `vllm`, and `llama-server` accept optional `token_command` / `token_ttl_ms` / `token_command_timeout_ms`. Unset keeps today's static `api_key` path. When set, the mint wins over `api_key`, is never logged, and AI SDK / availability probes remint once on HTTP 401.
- `vllm` and `llama-server` accept optional `models` (static floor) and `models_ttl_ms`; `listModels()` returns floor + discovered ids from the models endpoint (last-known on outage). Building block: no den-server / web roster consumer reads the merge yet.
- Embedding worker and `memory.postgres` query-time embed support `embed_api_key` / `embed_token_command`, `embed_wire_shape` (`openai` default, or `native` passthrough), and optional `embed_expected_dims` (must equal the `halfvec(1024)` column width when set; longer vectors null out rather than silent-slice). Worker env: `RIVETOS_EMBED_API_KEY`, `RIVETOS_EMBED_TOKEN_COMMAND` (JSON argv), `RIVETOS_EMBED_WIRE_SHAPE`, `RIVETOS_EMBED_EXPECTED_DIMS`. No `OPENAI_API_KEY` fallback (opt-in only).
- Config validation and `docs/CONFIG-REFERENCE.md` cover the new keys. Opt-in: with these keys unset, behaviour is unchanged.

### Den URL guards

- A plain-http den URL is no longer dropped when the CA file is missing. `rivetos_resolve_den` unset `RIVET_DEN_URL` whenever the CA path did not exist, including for `http://` URLs that never use a CA, so on a den without TLS and a node with no shared CA the hooks and sidecars lost the den and fell back or spooled. The CA check (and the `NODE_EXTRA_CA_CERTS` export) now apply only to URLs that are not `http://`. One trade to know: a stale `http://` line left in `~/.rivetos/.env` on a node with no den at all used to be dropped by that same check and is now kept, so captures would target the dead port instead of falling back; `rivetos doctor` reports a preset `RIVET_DEN_URL`. An http loopback URL only reaches that point when the den really serves http: the https rewrite for a TLS den runs first (#1053).
- A pre-set `RIVET_DEN_URL` is checked before the memory sidecar and the capture hooks dial it. A comma list (the old den-hook fallback form) is not one origin: the first entry is used. A plain-http loopback URL against a den that serves https is rewritten to https. Each guard prints one line to stderr naming the value to put in `~/.rivetos/.env`, or says to remove the line. Shared between the shell launcher (`rivetos_guard_den_url` in `integrations/shared/rivet-paths.sh`) and `@rivetos/capture-core` (`guardDenUrl`; `resolveCaptureTransport` returns the warnings and the claude-cli hook logs them). "Serves https" mirrors boot's `resolveDenTls`: `den.tls_cert`/`tls_key`, then `RIVETOS_DEN_TLS_CERT`/`KEY`, then the mesh issue-node files for `mesh.node_name`. A non-loopback http URL is left alone. Background: `~/.rivetos/.env` on three nodes kept `RIVET_DEN_URL=http://127.0.0.1:5174` from before gateway TLS; nothing dialed it until #1012 and #1013/#1014 moved the sidecar and every hook onto den transport, and the launcher loads that file after the den-injected env, so the stale line overrode the correct https the den hands its own sessions. Reads failed on every call and captures spooled for four hours with nothing else showing red.
- `rivetos doctor` gains a `den` group: `RIVET_DEN_URL` present in `~/.rivetos/.env` is reported (fail on a comma list or an http scheme against a TLS den, warn when redundant or a differing override; the den injects the URL and the launcher derives it, so the line is drift by definition), the den is dialed once at `/healthz` with the CA and a failure that the other scheme answers is named a scheme mismatch, and the capture spool is reported (warn when batches wait, fail when the oldest is over an hour old, dead-lettered count included).
- `memory_stats` reports the local capture spool in the alerts block, right after queue health: `✅ empty`, or the waiting count, oldest age, dead-lettered count and the `RIVET_DEN_URL` / `rivetos doctor` hint. `createStatsTool` takes `captureSpool` (a reader, or `null` to omit the block).

### Agent registry

- Killing a running task now stops it. The runner aborts the in-flight turn when the row flips to `killed` (it used to let the turn finish and discard the result, so a killed task kept running tools and spending tokens), and re-checks the row at each turn boundary so a kill issued from another node is caught too. The `claude-cli` task spawn leads its own process group and is signalled as a group (SIGTERM, then SIGKILL after 3 s, plus one sweep when the CLI exits), so the CLI's own children — stdio MCP servers, Bash tool shells — no longer outlive a killed or timed-out task; the sweep runs when the CLI exits, so a descendant holding its output pipe can no longer hang the turn (#1053). The capture hook worker is unaffected: it detaches into its own session by design. The CLI now runs in its own session (every `claude -p` spawn, the model path included), so a signal aimed at the runtime's process group no longer reaches it directly; the runtime kills its live CLI groups when it shuts down instead, and its lifecycle now treats SIGHUP (a closed terminal) as a shutdown like SIGINT and SIGTERM, since Node's default handling of a signal runs no exit hook. POSIX only: on Windows the pid is signalled as before. The Kimi, OpenCode, Pi and Qwen executors still signal the pid alone. When a user kill and a budget trip land in the same turn, the recorded verdict is `killed`.
- `POST /api/tasks` (the route a den-transport `delegate_task` uses): a preset with no harness configured no longer shadows a runtime agent of the same name, and `agent@node` pins a runtime agent to an online node that hosts it (400 otherwise). #1052 fixed the same shadowing in the in-process mesh engine and the Postgres-transport sidecar but missed this third path, so `delegate_task` from a CLI harness session still answered `preset "Grok" has no harness configured` for runtime agents. With no runtime agent of that name the preset still answers with its own refusal. The den-transport tool description now advertises `agent@node`.
- `delegate_task`: a preset wins over a runtime agent of the same name only when it can run. A preset with no harness configured no longer shadows a same-named runtime agent (every runtime agent tends to have one — "Deepseek" next to runtime `deepseek` — which made those agents unreachable by bare name); with no runtime agent of that name the preset still answers with its own "no harness configured" refusal. Applies to the in-process mesh engine and the MCP sidecar; `agent@node` (#1039) still pins a node explicitly.
- `POST /term { agentId }` spawns that preset's harness in its directory (materialized, with the `rivet-shared` link) and uses the preset's roster command, model, and effort unless the request sets them. Per-agent cwd for interactive sessions: a session cwd store records a non-default directory and a later resume starts there. PTY drivers accept `cwd`. `SessionSummary.cwd` is filled for every PTY harness. One `defaultSpawnCwd` rule is shared by the term manager and the harness roster getter. Clients never send a raw cwd.
- `@rivetos/agent-registry` (tagged `domain:shared`) is the shared preset store den, core, and the hub will import: file and Postgres backends, directory materialization, a short-lived cache, and a one-shot `agents.json` importer. Migration `0017_agent_presets.sql` adds the DataHub table `ros_agent_presets`. `AgentPreset` gains optional `node`, `directory`, and `sharedLink` (`nodeBaseUrl` is optional and deprecated); roster-command helpers move into `@rivetos/types` so den and RivetHub share one map. No runtime behaviour change.
- den serves presets from the DataHub (`ros_agent_presets` on `config.pgUrl` / `RIVETOS_PG_URL`) and falls back to the per-node `agents.json` when Postgres is absent or the table is not ready yet. The first time the table answers ready, that file is imported once and renamed aside; imported rows get a directory on disk. A name that already exists (case-insensitively) is imported as `"<name> (<node>)"`, then `"<name> (<node> 2)"`, and if those are taken `"<name> (<node> <first 8 of id>)"`, instead of being dropped. Only an id conflict is skipped. A row that still cannot be imported leaves the source file in place and is reported as `unresolved`. The import result counts `renamed` disambiguations next to `imported` and `skipped`. Preset names are unique case-insensitively on every den, including file-only dens.
- Presets carry `node`, `directory`, and `sharedLink`. The hosting den materializes the directory (mode 0700) and a `rivet-shared` symlink to the shared directory. `sharedLink: false` does not create that symlink. On PATCH, `sharedLink: false` removes an existing `rivet-shared` link only when this patch flips it off and the directory stays the same; a directory move with `sharedLink: false` skips creating the link and does not unlink a different directory. Turning it back on links it again. The directory is not deleted with the preset.
- `nodeBaseUrl` is optional and deprecated — placement is `node` + `directory`; kept only for rows written by pre-registry dens (ones that answer 400 `nodeBaseUrl is required`). Create stores a client's trimmed `nodeBaseUrl` (at most 512 characters) when one is sent and does not require it. A create that omits it, including from a new hub, writes an empty URL (Postgres included; no migration). Update does not patch it. List and GET still echo the URL on a legacy file row written by a pre-registry den. A client `node` other than this den's is rejected; `node` cannot be changed later.
- `RIVETOS_DEN_NODE_NAME` (then `RIVETOS_DEN_NODE_ID`, then the hostname) is this den's mesh node name. Boot sets it from `nodeNameFor(config)` (`mesh.node_name`, then `HOSTNAME`, then `local`) after prefix passthrough, so the config-derived name wins for an embedded den and a process-env `RIVETOS_DEN_NODE_NAME` is ignored there. The mesh registrar registers that same string: a whitespace-padded `mesh.node_name` is trimmed, and when `mesh.node_name` is unset the fallback is the hostname, not `'unknown'`. `RIVETOS_DEN_AGENTS_DIR` overrides the default preset directory root (`~/.rivetos/agents`). `/mesh.json` attaches `latest` using that same `config.nodeName`. On this box the hostname is `rivet-claude` and the mesh id is `node-f`; matching the hostname left `latest` on the wrong roster entry.
- `/healthz` includes `node` (the mesh node name) next to `name` (the hostname).
- Presets are `delegate_task` targets (by id or name) from both delegation engines. A hit runs as a durable `ros_tasks` row (`executor: harness-session`, `executorTarget` the preset harness, pinned to the hosting node) with the preset's directory, model, effort, and system prompt. The caller never names a node. A harness with no headless executor on that node fails pre-flight with the gap text and creates no row. The task runner forwards `workingDir`, `effort`, and `systemPromptAppend`. It materialises the directory and the `rivet-shared` symlink only for a preset the runner resolved (`resolvePreset`, boot passes the preset resolver's `find`) — not from a client `presetId` or `workingDir` — so a workflow step's case directory is not given a symlink into the shared tree. A `workingDir` that disagrees with that preset fails the task (`working_dir_mismatch`) and creates nothing. Chat-loop workflow steps still run with `workspaceDir` set to that case directory. `POST /api/tasks` for a preset (when the body does not set `executor`) creates that same harness-session row; no harness or an unimplemented one is 400, and a hosting node that is offline or unknown is 409. An explicit `executor` is left alone. The HTTP mesh fallback carries `toAgent`. The catalog lists presets (`kind: 'preset'`), and nodes advertise `metadata.harnessExecutors`.
- `POST /api/tasks` strips client `presetId`, `presetName`, `sharedLink`, `delegation`, and `meshFrom` unless the route itself resolved a preset (the preset branch writes them back). On that branch a non-blank body `model` wins, a blank `model` is omitted, and the preset owns `effort` and the system prompt; API rows are not delegations. Fresh roster reads (`rosterEntriesFresh({ timeoutMs })`, default 2s) and the catalog race the preset store and mesh registry against that bound and fall back to the last-known list and mesh snapshot, so a hung read cannot pin the request.
- The task runner bounds each preset lookup at 2s (the same window as roster reads). A timeout or a rejection materialises nothing and runs with the spec working directory, and the liveness heartbeat starts before that lookup so a hung resolver cannot strand the claimed task.
- A mesh node with no `node_name` takes its registry id, TLS cert lookup name, and task affinity from `nodeNameFor` (`HOSTNAME`, then `local`) instead of the literal `unknown`.
- MCP sidecar `delegate_task` / `list_agents` for CLI harnesses. With `RIVETOS_PG_URL` set, a preset name or id becomes the same `harness-session` row the runtime engine creates (Postgres direct — no gateway mTLS client), and a runtime agent id becomes a `chat-loop` row pinned to the newest online mesh node that hosts it. `RIVETOS_TASK_ID` is the chain guard (refuse when the next depth would pass 3) and is stored as `parentTaskId`. `RIVETOS_MCP_ENABLE_DELEGATE=0` turns both tools off. A row nobody claims is killed, and the reply names the node whose runtime never picked it up. `PresetDelegationEngine.delegate` takes an optional `parentTaskId` so that sidecar row can record its parent; in-process callers omit it.
- MCP sidecar `delegate_task` accepts `agent@node` to pin a runtime agent to one online mesh node when several host the same id. The full `to_agent` string is matched against presets first, so a preset whose name is exactly `agent@node` still wins; with no node, a preset name or id still wins over a runtime agent with the same id and the newest online host is still chosen. The den HTTPS delegate tool does not parse `agent@node` (the gateway is given `to_agent` verbatim) and keeps the pre-pin description.
- Migration `0018` adds a nullable `sort_order`. `AgentPreset.sortOrder` is the user-chosen sidebar position. `PATCH /api/agents/:id` accepts `{ sortOrder }` as an integer 0–1,000,000 or `null`; anything else is 400 `sortOrder must be an integer 0-1000000 or null`. A DataHub without 0018 still lists presets, and saving an order there fails with an error naming the migration.

### Den

- `den.allowed_harnesses` — optional allow-list of harness ids this node offers for new launches. Unset = every registered harness (unchanged). When set, `GET /api/harnesses` stamps `allowed` on each row; Agents preset create/PATCH, `POST /term` (fresh spawn), control-plane session create, and harness-session task create refuse off-list ids with `harness_not_allowed` (HTTP 403). Existing sessions / real resumes still work (`sessionId`/`nativeSessionId` on session create when the target exists; `/term` resume of the same harness). A never-seen resume key on either path does not mint an off-list spawn. The task runner re-checks on the claiming node (pre-list rows including legacy `claude-cli` targets, internal `store.create`, peer affinity). `/api/catalog` omits off-list harness-session executors; `/term/config` drops off-list roster commands. RivetHub web and Android **new-conversation / Agents** pickers filter on `installed` and `allowed` together (absent = true); existing-session drawers still list off-list harnesses so resumes stay visible.
- The 202 from `POST /api/harness-sessions/:enc/turns` and the legacy `POST /term/inject` carries `dismissedDialog: true` when the inject button's send found an open dialog and queued Esc ahead of the paste. The flag has the same delivery guarantee as the turn: accepted into the inject path (it may still be sitting in the pre-ready buffer), not proven written to the pane. Flag only — no pane text leaves the node.
- `AgentPreset.nodeBaseUrl` is deprecated — placement is `node` + `directory`; kept only for rows written by pre-registry dens (ones that answer 400 `nodeBaseUrl is required`). The den stops requiring or patching it. On create it stores a client's trimmed `nodeBaseUrl` (at most 512 characters) when one is sent, and an empty URL when the client sends none (the Postgres column stays; there is no migration). Update does not patch the field. List and GET still echo whatever URL a legacy file row carries.
- The gateway enforces a browser origin policy. A request or WebSocket upgrade that carries an `Origin` is answered only when that origin is the gateway itself, the RivetHub desktop app, another den in the mesh roster, or listed in the new `den.allowed_origins`; anything else gets `403`. Responses echo the allowed origin instead of `Access-Control-Allow-Origin: *`. Clients that send no `Origin` (Android, hooks, CLI, mesh peers) are unaffected. A plain-HTTP gateway also requires loopback callers to use a loopback `Host` name or one listed in the new `den.allowed_hosts`. The mesh agent channel now refuses requests that carry an `Origin`. See CONFIG-REFERENCE → `den` → Browser origin policy.
- `POST /term/inject` writes only into sessions whose roster entry is an agent harness (`room: true`). Terminal-only sessions (`room: false`) answer 409 `session is not an agent harness` and nothing is written to the PTY (#810). Custom harness entries must set `room: true` to receive chat; terminal-only entries are typed through the terminal. Typing into a shell remains the terminal websocket.
- When a herdr-backed coding agent exits, den reaps the PTY and mux session after a short grace so chat inject 409s instead of writing into the leftover shell (#791). Adopted harness panes stay closed to inject until a pane-scoped `pane list`/`agent list` probe (or a working|idle|blocked frame, or `pane.agent_detected` with a live agent) proves a live agent; a fresh create stays not-ready and re-probes instead of killing a still-booting harness; `POST /term` during the grace mints a new pty immediately.
- Term ready-gate waits for output quiescence or herdr agent-idle (not first-chunk + delay). The first buffered inject on an agent pane is confirmed only by a herdr `working` frame; unconfirmed turns are recorded on the pty and never retried (#796).
- Claude transcript adapter strips Claude Code's `<pasted_content id="…">…</pasted_content id="…">` framing from a parsed user turn before it reaches the transcript, and from the session drawer title (#818). The den injects chat as a bracketed paste, which Claude Code wraps and stores verbatim; left as-is the wrapper showed as raw tags in the user bubble and, because the web client retires an optimistic bubble by exact-text match with no id, duplicated the turn. The strip is paired and id-anchored, so literal user text that merely mentions the tag is left untouched.
- The herdr agent kind is resolved from the roster entry's own `argv[0]` instead of its key, so a renamed entry (`claude-code` running `claude`) keeps the agent-idle ready-gate and first-turn confirm instead of silently falling back to output quiescence. The restart sweep (status subscription only) lets the `@rivet_agent_pane` stamp — written at create and on adopt — win and, with no stamp, retains a survivor when its `@rivet_command` tag is a kind or its roster entry's `argv[0]` is a kind. Reattach lets the stamp win too; a session with no `@rivet_agent_pane` stamp (created by an older den) keeps the previous key-based rule — the kind comes from the roster key and `argv[0]` must equal it — so a renamed-key or pinned-path plain pane is not reclassified and ended. Wrapper scripts and absolute paths remain plain panes by design — `--kind` would launch herdr's own PATH binary rather than the pinned one — and a `room: true` entry that resolves to a plain pane now logs once at spawn.
- The harness model/effort sheet carries an explicit `launchModel` flag, and the PTY driver stamps it onto the advertised capabilities: `claude-code` sets it (its `--model` is the launch-time switch and the sheet's alias set is what the CLI accepts). A sheet with `models` + `modelFlag` does NOT imply it — the pre-spawn picker gates on the flag, not the sheet's shape (#814). `POST /term` still validates the model/effort tokens against the resolved sheet either way.
- Model and effort flags are only added when the roster entry still runs the built-in program for that key.
- Chat inject refuses to paste a turn onto unsent text in Claude Code's input box (`reason: 'harness_draft'`, 409 `turn_in_flight`). Claude only: the PTY driver's `dialogGate`, and `POST /term/inject` when the roster command is `claude` or `claude-code`. The inject button is refused too. Empty-box ghost text (the eight `Try "…"` examples and the other Claude Code 2.1.280 placeholders, read from that version's bundle: `Message @<agent>…`, `Press Enter to edit the selected message, or up again for history`, `Press Enter to edit the selected message, or up again for an older one`, `Press up to select a queued message to edit, or Enter to send them now`, `Press up to edit queued messages, Enter to send them immediately`, `Press up to select a queued message, then Enter to edit it`, and `Press up to edit queued messages`) is treated as an empty box, because the pre-send capture is plain text and cannot see dim SGR. A draft that wraps past the pane width still fails open.
- Model ids may contain `~` after the first character (OpenRouter aliases such as `openrouter/~z-ai/glm-latest`): `POST /term` and preset spawns no longer answer 400 `model must be a 1-64 token`, and harness model sheets keep those ids. A leading `~` is still rejected.

### RivetHub client

- `apps/rivethub-web`: Files editor prompts before discarding unsaved edits — pane close, opening another file, breadcrumb/`../` navigation, leaving via the sidebar or browser Back/Forward (`useBlocker`), and tab close/reload. Same-path crumb clicks are a no-op so an accepted discard cannot disarm the guard while the pane stays open. Whole-row click opens a file or folder (checkbox cell excluded; ignores double-click follow-ups and drag-select of a filename).
- `apps/rivethub-electron`: when the renderer cancels unload for unsaved edits, show a Stay / Discard changes dialog on window close, tray Quit, and Reload (`will-prevent-unload`) instead of silently doing nothing.
- `apps/rivethub-android`: Omarchy-style redesign to match the desktop: `rivethub` wordmark and `rh` monogram (also the launcher, themed and notification icons, now vectors), JetBrains Mono throughout, square corners, and Settings → Appearance → Omarchy with the 14 built-in palettes. The menu drawer follows the finger from the left edge and settles by fling or position; on the hub home under gesture navigation the edge zone reaches past the Back inset and a mid-bezel band is excluded from Back while the drawer is closed; Back gets a predictive preview. Settings → Conversations → Default view (Terminal | Chat) defaults to Chat, so upgrading moves no conversation; a conversation's own switch still wins.
- `apps/rivethub-web`: when a send's 202 carries `dismissedDialog`, the composer shows "sent: a picker or prompt was open in the Terminal; it is cancelled (Esc) before the paste" for 8 seconds.
- Copying an agent no longer seeds `nodeBaseUrl`. The hub still resolves a legacy preset URL when `node` and the roster cannot name the den, until no pre-registry den (one that 400s `nodeBaseUrl is required`) remains on the roster. Creating an agent still retries once with `nodeBaseUrl` when an old den answers `nodeBaseUrl is required`.
- Agents: the sidebar shows each preset's hosting node by name, edits its working directory and the `rivet-shared` link, and opening it sends `agentId` on `POST /term` so the den spawns in that directory with the preset's command, model, and effort. An explicit per-thread model or effort still wins. Settings shows the connected node's registry backend, node name, directory root, and shared directory (from `RIVETOS_SHARED_DIR` / `mesh.storage_dir`). An old den that still answers `nodeBaseUrl is required` is retried once with that field. A file-only preset with no `node` still resolves through `nodeBaseUrl`. A harness-less preset spawns without `agentId` (the node's default directory). A 404 `agent not found` for a preset that is no longer in the active agents queries clears that id and opens once without it, with the notice "Preset not found on this node; opened without it"; a preset that is still listed there is not recovered, the 404 stays the thread error, and those queries are refreshed so the next attempt is not stuck on a stale snapshot. The command-404 fallback now also carries the thread's model and effort (it used to send the session only). A `nodeBaseUrl`-only row opens only when that URL is on the saved roster.
- Composer model picker for conversations whose harness supports choosing a model per turn.
- `apps/rivethub-web`: the composer autofocuses on landing in a conversation and when switching to another, so you can type without clicking first. Waits for the socket (the textarea is disabled while reconnecting) and fires once per session. It never pulls focus from something you're already using — an inline rename, a filter, a dialog (unless the dialog has closed and gone inert), or the terminal — and skips touch devices so a tap can't raise the keyboard over the transcript.
- A model picker appears before a harness's first launch in a conversation. The choice is then fixed for that harness in that conversation. Switching the conversation's agent clears it and offers the new agent's models. claude-code only today (#814).
- `apps/rivethub-web`: prevent sidebar and composer node pickers flashing while discovery is pending or failed with one saved node; keep multiple saved nodes available immediately (#809).
- `apps/rivethub-web`: hide node pickers only when connected to the sole saved node (or the app origin with no saved nodes) and mesh discovery confirms no peers; keep discovery and first-peer saving available.
- `apps/rivethub-web`: a send refused because the Terminal input holds unsent text (`reason: 'harness_draft'`) shows `DRAFT_NOTE`. The outbound pump retries that 409 up to six times (about 57s) and then leaves the turn queued; press the inject button again after the draft is sent or cleared.
- Agents: drag a row, or Alt+↑/↓ on a focused row, to reorder. The order is saved per preset on its hosting den. A den that does not support ordering is reported.
- Sidebar Agents: the agent bound to the active chat is marked (accent bar, ringed swatch and highlighted name; a folded list or the collapsed rail keeps a dot for it, and the row carries `aria-current`).
- Ctrl+Tab / Ctrl+Shift+Tab cycle agents in the sidebar roster order; Ctrl+Shift+E toggles the rail (wide) or the narrow drawer. Capture-phase listeners handle the chords before the terminal sees them. Agent cycling works in the RivetHub desktop app only (browsers reserve Ctrl+Tab).

### Harness integrations

- Grok Bot capture (`integrations/grok-bot/rivet-memory`, plugin 0.3.0): one normalizer on `@rivetos/capture-core` for on-disk jsonl and ReadTranscript pages. Strips wrapper noise, stamps real message times (UTC offset + N ms inheritance), tags each bot from its profile name (historical session keys unchanged), stores hidden turns as `role=system`, reads `tool_result.result`, and caps at `capForStorage` 16,000. Re-clean writes new `-v3` sessions only — never DELETE/UPDATE.
- `opencode` harness (id `opencode`, provider `opencode-cli`, roster `opencode`) surfaced in RivetHub web, Android, and docs. Default `model` is `zai/glm-5.3-flash`. The installed OpenCode CLI owns backend, endpoint, and credentials.
- `pi` memory capture (`integrations/pi/rivet-memory`): v3 session jsonl watcher under `agent=rivet-deepseek` / `channel=pi`, systemd user unit `pi-memory-capture.service` / launchd `dev.rivetos.pi-capture`, wired into `rivetos plugins install` and doctor.

### Tooling

- `scripts/worktree-reap.sh`: the post-merge cleanup step. Lists (and with `--apply` removes) worktrees whose branch's PR is merged or closed, or whose detached HEAD is on `origin/main` or belongs to a merged `wt-pr-NNNN` review checkout, when the tree is clean and no process is inside; then deletes those branches and prunes remote refs. Dirty trees and open PRs are skipped and listed. Added after an audit found ~200 abandoned worktrees (~25 GB) across two checkouts.

### Harness

- `claude-code` task isolation, opt-in: `tasks.harnesses.claude-code.isolation` is `inherit` (default, unchanged) or `isolated`, and a task can tighten it with `spec.isolation: isolated` (the node setting is a floor: a spec cannot loosen an isolated node). A delegated run used to load the service user's whole personal Claude Code setup — settings, permission rules and default mode, hooks, plugins and their MCP servers, and the user-level `CLAUDE.md`. `isolated` drops all of it (`--setting-sources project`), loads only the embedded RivetOS bridge (`--strict-mcp-config`), supplies the RivetOS capture hooks itself so task transcripts keep working, and denies every permission prompt explicitly when `permission_prompts` is unset — which closes the gap where MCP tool prompts escaped the auto-deny through the operator's allow rules. `tasks.harnesses.claude-code.allowed_tools` is passed as `--allowedTools` for what a headless run may call without a prompt. See CONFIG-REFERENCE → `tasks.harnesses` → Task isolation (#1053).
- Harness model lists are discovered from the harness itself, with config able to override or supply them. Codex's sheet now comes from the CLI's own catalog (`codex debug models`, run in the background with a bounded timeout, with `<codex home>/models_cache.json` as the floor until the listing lands): listed models in priority order, per-model reasoning efforts (`max` / `ultra` where the catalog has them), and `config.toml`'s `model` as the default (added as a row when the catalog does not know it, the custom-gateway case). The Codex sheet carries `--model <id>` and `-c model_reasoning_effort=<effort>` so a model picked for a Codex agent reaches a term-spawned TUI, and declares `launchModel`; the old placeholder `default` row is gone. Async sources (the Hermes endpoint, the Codex listing) share one background cache with its own deadline (the subprocess is SIGKILLed at the timeout): a hung or failing listing leaves `/api/harnesses` serving the last-known or static list, is retried on the next TTL, and logs one line per outage. `tasks.harnesses.<id>.models_mode` is `discover` (default), `replace`, or `merge` (discovered plus config entries, deduped by id, config winning on label / default / efforts); a `models` list with no `models_mode` keeps today's replace meaning. `capabilities.modelsSource` (`discovered` | `config` | `merged` | `static`) says where the list came from. An agent preset naming a model that is not on the resolved list is refused (400) under a non-empty `replace` list (`modelsSource: config`) and stored with one warning otherwise (only when the harness/model pair changes, so a round-tripped form save is never refused), and the spawn log names the harness and the list's source when it omits `--model`. **Behavior change for existing configs:** a `tasks.harnesses.<id>.models` list was always a replace and now also pins preset saves to it. For Codex, the legacy placeholder id `default` means "the CLI's own default" (no flag, never vetted). A config-supplied Codex list declares `launchModel` even before discovery has rows, and on the Codex app-server driver a config `default: true` is the only default. A Codex preset's effort now reaches the TUI as `-c model_reasoning_effort=<effort>`, overriding `config.toml`'s value for that session (presets default to `medium`). See CONFIG-REFERENCE → `tasks.harnesses` → Model lists.
- `cursor` harness (id `cursor`, roster command `cursor`) in RivetHub web and Android. The den spawns `agent --force --trust` and resumes with `agent --resume <chatId>`. Transcripts are read from `~/.cursor/projects/<slug>/agent-transcripts/`. No pin flag and no headless task executor.
- `grok-cli` provider: `max_turns` defaults to unset, so `--max-turns` is only passed when configured (#951). The old default of `1` ended every tool-using grok turn as `error_max_turns` — grok heartbeats and mesh tasks failed with a bare `grok result is_error`. A failed result now carries grok's `subtype` in the error (e.g. `grok result is_error: error_max_turns`).
- `claude-cli` provider: the `claude --version` availability probe is bounded (15 s, then SIGKILL, reported unavailable) and shared between concurrent callers. It had no timeout, and `Runtime.start()` awaits `router.healthCheck()` before starting channels, so a `claude` that never exits (e.g. a wrapper script whose `exec claude` resolves back to itself) held the gateway channel and health endpoint down indefinitely.
- `pi` harness (earendil-works/pi, provider `pi-cli`, roster command `pi`) on RivetHub web + Android, with a commented `@rivetos/provider-pi-cli` config example (recommended default backend z.ai GLM).
- feat(harness): add qwen-code — Qwen Code CLI as the eighth first-class harness (driver, provider, executor, hooks-driven memory capture via a qwen extension, web + Android).
- `hermes-cli`: `model` is still passed to `hermes chat -m`, except `custom:<provider>:<model>`, which is sent as `--provider <provider> -m <model>` before `--in` and `--resume`. The model part keeps further colons (`custom:local:qwen3.5:27b` is provider `local` and model `qwen3.5:27b`). `-m` of the whole `custom:…` string is a model name on the default endpoint, which does not resolve it.
- Den-spawned Hermes (interactive PTY, `appendModelEffortArgv` on the hermes sheet) applies the same `custom:<provider>:<model>` split. Other harness sheets are unchanged, including qwen-code, which also uses `-m`.
- RivetHub client — new chats and registered harness sessions open in Chat; legacy sessions wait for registry resolution and fall back to Terminal on failure, with the settled view remembered across navigation.

### RivetHub client

- Sidebar Agents: pre-fill the existing create form from unsaved edits when a preset’s node fails to load harnesses, validate settings against another reachable node, and create a copy; the original stays on its node and can be deleted when it is reachable again. Surface save and delete failures.

### RivetHub client

- Chat: preserve in-flight sends, ordering, and visible failure/retry across draft adoption and native-id rotation (#795).
- Chat: a committed user turn retires the optimistic bubble of the send it confirms — by item id when the echo carries one, otherwise the accepted/sending bubble before a failed twin of the same text — so repeating a message can no longer retire the wrong bubble or strand the committed send's own.

### Breaking

- Per-user memory routing reads only the users.json registry (`RIVETOS_USERS_FILE`, else `$RIVETOS_SHARED_DIR/rivetos/users.json`, else `~/.rivetos/users.json`). The `RIVETOS_USER_DBS` and `RIVETOS_DEN_DEVICE_USERS` env maps are removed — leftover values do not route.
- Removed the `deepseek-harness` (dsh) harness — `HARNESS_IDS` token, `@rivetos/harness-deepseek`, `integrations/deepseek` capture plugin, and the `deepseek`/`dsh` preset aliases (presets using them no longer map to a harness); nodes with a `dsh` roster entry in `~/.rivetos/den-term.json` need `rivetos plugins install --force` or a hand edit.

## [0.5.0] - 2026-08-30

First stable release. Everything since the 0.4.0 public beta: gateway + RivetHub, den, harness control plane, memory wiki, device mTLS, and per-user tenancy. Workspace packages align at 0.5.0 (RivetHub Electron keeps its own 0.5.4 updater cadence).

### Runtime / mesh

- Self-registering plugin manifests (`PluginManifest` + `register(ctx)`); `transport` category; in-process `@rivetos/mcp-server`.
- Providers: dedicated `@rivetos/provider-vllm` and `@rivetos/provider-llama-server` replace `openai-compat`; `@rivetos/provider-claude-cli` drives local `claude` with an embedded MCP bridge.
- Agent loop on the AI SDK (`@rivetos/aisdk`); providers migrated to official AI SDK packages.
- Mesh mTLS (shared CA, HTTPS agent channel, `mesh.tls`, `.mesh` DNS). **Breaking: all mesh nodes must upgrade together.** `mesh.secret` is ignored for agent-channel auth (warning on load); remove it from config.
- `rivetos mesh enroll` / `mesh sync` / `mesh renew` (SSH hub helper, unpack issued certs + `mesh.json`); doctor warns when the leaf expires within 30 days. **Breaking:** `mesh join <host>` without `--manual` exits non-zero — use `mesh enroll` or `mesh join --manual` (#599).
- Durable task engine (`ros_tasks`): chat-loop executor, heartbeats, subagents, mesh delegation over shared Postgres, evaluation/retry/escalation.
- Gateway embedded in the rivetos process: `/api/tasks`, catalog, sessions, notifications WS, uploads, wiki, memory, workflows.
- Workflows v1: journal-replay engine, step SDK, budget/`parallel`, gateway + RivetHub runs UI (#438, #441–#446).
- MCP unification: core + sidecar split, era-negotiating stdio, MCP 2026-07-28 final / SDK 2.0 (#275, #276, #435, #451).
- `RIVETOS_INSTALL_ROOT` and `RIVETOS_SHARED_DIR` replace hardcoded install-root and shared-dir defaults (#595, #590).
- Identity contract in workspace templates — verify before assuming, maintain the user roster (#594).
- Removed: Pulumi IaC, split container images, Telegram/Discord/voice-discord channels (Phase 5, #490), unused circuit-breaker/audit-rotation exports (#463), Rivet Team product (#530).

### Memory / wiki

- Memory v5 compaction (leaf/branch/root + tool-call synthesis) and hybrid search (FTS + trigram + vector/RRF).
- Compaction and embedding moved onto graphile-worker (`services/{compaction,embedding}-worker`).
- Memory wiki: page model, extract/consolidate/recompile, durable topics and Wikipedia-style articles, `/api/wiki` + hub UI, `wiki_search`/`wiki_read` (#285–#292, #414, #416).
- `memory_get_full` disk-pointer recall; `window=` shortcuts; tool rows excluded from browse by default (#546); tool_result search/embed (#440, #482).
- Per-user memory routing (device identity → per-user database) (#561); `/api/memory` routed by the den-stamped user (#571).
- Compaction skips heartbeats (#518); deadlock retry + wiki enqueue after commit (#542); `rivetos memory retry-failed` (#508).

### RivetHub client

- `apps/rivethub-web`: chat-first hub over the gateway — transcript, composer, node switcher, terminal, files, memory Search/Browse/Stats, wiki, workflows/flows canvas (#295–#307, #428–#433, #502, #550).
- Desktop shell migrated from Tauri to Electron (`apps/rivethub-electron`) (#555); in-app updates from the mesh filestore (#562). Electron stays on its own 0.5.x updater cadence (0.5.4 as of #587).
- Composer attachments, interactive ask card, voice mode (#576); per-session node binding (#583); agents roster in the sidebar (#549).
- Loopback mTLS pipe so the desktop client presents device certs to the gateway (#494).
- `apps/rivet-bots-android`: Grok Bot-style client where every bot is a mesh agent node (#541, #544, #545).

### Den

- New stack: `@rivetos/den-protocol`, `@rivetos/den-server` (harness event contract, PTY terminals, mesh overview).
- Den embedded in the rivetos process; harness adapters (Claude Code, Grok Build, later Hermes/Kimi/DeepSeek); MicBridge host-mic input (#418); voice transcribe/speak proxy (#574).
- Harness control-plane fencing per session owner (#580, #582); idle auto-close of unattached harness PTYs (#439, #514).
- DeepSeek `dsh` TUI driver (#539).

### Harness integrations

- Harness control-plane contract + `SessionId` codec (#456); drivers for Claude Code (#458), Grok Build (#472), Hermes (#477), kimi-code (#480), DeepSeek (#539).
- Rotation re-keying and superseded lifecycle (#470); reasoning-delta on the contract (#469); gateway attachment staging (#465).
- Capture plugins: Grok Build, Hermes, Kimi Code, Grok Bot memory bridge (#517); kimi-code headless executor + wire.jsonl backfill (#474, #481).
- RivetHub and Android chat bound to the harness control plane (#466, #479).

### Tenancy / multi-user

- Mesh device enrollment (QR pairing) and per-device datahub credentials (#357, #366).
- Gateway Rivet CA device mTLS; bearer tokens removed (#491). **Breaking: clients must present a device cert.**
- Resolve the user at the den edge and filter RivetHub by owner (#565); wiki/memory/harness surfaces honor the routed user (#571, #579, #580, #581).
- Early per-user identity (profile `USER.md` + memory tag) generalized into the owner-user model.

### Release / infra

- Unified `rivetos` container image (`--role`); GHCR publish; `@rivetos/cli` installable via `npm install -g`.
- Versioned SQL migrations as source of truth; Nx module-boundary enforcement; secret scanner (#363); commit authorship check (#552).
- `docs/RELEASES.md` release policy; docs truth-sweep to Phase-5 reality (#589, #593).
- Workspace versions normalized to 0.5.0 for the first stable tag (this release). Lockfile refresh (`npm install`) must land in the PR — CI runs `npm ci`.

## [0.4.0] - 2026-04-05

First public beta. Containerized distribution, reliability hardening, and launch documentation across three internal milestones (M6 containers, M7 reliability, M8 docs).

### Added

- Containerized distribution: agent + datahub Dockerfiles, root `docker-compose.yaml`, Nx container build targets, `DATA-PERSISTENCE.md` model, CI pipeline.
- `rivetos build`, `rivetos init` interactive wizard, `rivetos config`, `rivetos agent add/remove/list`, `rivetos update` source-based update flow.
- Pulumi infrastructure components and `rivetos infra up/preview/destroy` (later removed in 0.4.x).
- Reliability primitives: `RivetError` hierarchy, channel `ReconnectionManager`, provider circuit breaker, memory connection pooling, structured logging, audit log rotation.
- Observability: `rivetos logs`, runtime metrics, `/health`, `/health/live`, `/metrics` endpoints, enhanced `rivetos status` and `rivetos doctor`, `rivetos test` smoke suite.
- Secret management: `redactSecrets()`, `.env` permission enforcement, config secret validation, 1Password `op://` resolution.
- Multi-agent mesh: `FileMeshRegistry`, `MeshDelegationEngine`, mesh HTTP endpoints, `rivetos mesh` CLI, `rivetos init --join`, `rivetos update --mesh`.
- Launch docs: `GETTING-STARTED`, `CONFIG-REFERENCE`, `PLUGINS`, `SKILLS`, `DEPLOYMENT`, `TROUBLESHOOTING`, example configs, `rivetos plugin init`, `rivetos skill init`, `rivetos skill validate`.

### Changed

- Node.js requirement: 22 → 24.
- All package versions normalized to 0.4.0 (was unreleased 1.0.0 placeholders).
- Containers moved from `containers/` to `infra/containers/`.
- Plugin discovery is convention-based via `package.json` `rivetos` field; all plugins export `createPlugin()` factory.
- Root `package.json` no longer leaks plugin dependencies (only `yaml` remains).

### Removed

- Backward-compat runtime shim `core/src/runtime.ts`.
- Architecture violation: `memory-postgres/review-loop.ts` no longer imports from `@rivetos/core`.

> Long-form release narrative archived outside the repo: `0.4.0-milestone-6-containerized-distribution.md`, `0.4.0-milestone-7-reliability-polish.md`, `0.4.0-milestone-8-documentation-launch.md`.

## [0.0.8] - 2026-04-03

### Changed

- **License** — changed from MIT to Apache License 2.0. NOTICE file added.
- **Documentation overhaul** — updated all markdown files to reflect current architecture and features.
- Deleted `CODE_OF_CONDUCT.md`, `REFACTOR_PROGRESS.md`, `docs/PHASE2.md`, `docs/MILESTONE-2-3-ANALYSIS.md` (obsolete).

## [0.0.7] - 2026-04-03

### Changed

- **Runtime decomposition** — `runtime.ts` (576 lines) split into focused modules:
  - `runtime.ts` (296 lines) — thin compositor, registration, routing, lifecycle
  - `turn-handler.ts` (263 lines) — single message turn processing
  - `media.ts` (105 lines) — attachment resolution, download, multimodal content
  - `streaming.ts`, `sessions.ts`, `commands.ts` — already extracted, unchanged
- **Delegation/subagent/skills registration** moved from `Runtime.start()` to `boot/registrars/agents.ts` for consistency with other registrars.
- Net -280 lines from runtime. Runtime no longer knows about images, base64, content parts, history management, hook execution, or memory appending.

## [0.0.6] - 2026-04-03

### Added

- **Boot package** (`@rivetos/boot`) — composition root properly decomposed:
  - `config.ts` — YAML config loading with env var resolution
  - `validate.ts` — schema validation with structured error/warning reporting
  - `lifecycle.ts` — PID file, signal handlers, shutdown
  - `registrars/providers.ts` — provider instantiation
  - `registrars/channels.ts` — channel instantiation
  - `registrars/hooks.ts` — safety, fallback, auto-action, session hook wiring
  - `registrars/tools.ts` — tool plugin registration
  - `registrars/memory.ts` — memory backend wiring
  - `registrars/agents.ts` — delegation, subagent, skills registration
- **`typecheck` target** on all 21 nx packages — `tsc --noEmit` catches type errors independently per package.
- **Typing indicators** for Discord channel plugin (same pattern as Telegram — channel-managed, runtime-agnostic).
- **Message splitting** in channel plugins — Discord (2000 char) and Telegram (4096 char) handle overflow internally. Runtime has zero knowledge of message length limits.
- **Safety cap fix** — when agent hits tool iteration limit, preserves the accumulated response text instead of replacing it with a generic message.

### Changed

- **CLI rewired** — imports from `@rivetos/boot` instead of `../../../../src/boot.js`. No more rootDir violations.
- **Telegram typing refactored** — typing indicator management moved from internal `handleMessage()` wrapping to public `startTyping()`/`stopTyping()` methods, then back to channel-internal management (matching Discord's pattern). Runtime doesn't touch typing.
- **21/21 packages typecheck clean** — fixed ~138 type errors across the monorepo (config types, tool result types, delegation types, missing tsconfigs).

### Removed

- **`src/boot.ts`** — 500-line god file replaced by `@rivetos/boot` package with 7 focused files.
- **`src/config.ts`**, **`src/validate.ts`** — moved to `packages/boot/src/`.

## [0.0.5] - 2026-04-02

### Added

- **`rivetos logs`** — tail runtime logs with filtering (`--lines`, `--follow`, `--since`, `--grep`, `--json`). Wraps `journalctl` for systemd service, falls back to log file reading.
- **`rivetos skills list`** — discovers all skills from `skill_dirs`, parses SKILL.md frontmatter, shows name/description/trigger count.
- **`rivetos plugins list`** — enumerates configured providers, channels, memory backends, and tools with status (configured / available / missing-key).
- **`rivetos login`** — OAuth login for Anthropic subscription auth.

### Changed

- **CLI extracted to `@rivetos/cli`** (`packages/cli/`) — independent Nx package with own `package.json`, `tsconfig.json`, build/test targets. Enables `nx run cli:build`, `nx run cli:test`, affected-only testing, and Nx caching. Old `src/cli/` removed.
- `@rivetos/cli` path alias added to `tsconfig.base.json`.
- Root `bin` entry updated to point to `packages/cli/src/index.ts`.

### Milestone

- **0.5 — CLI Tools: Complete.** All planned CLI commands shipped. `mesh list/ping/remove` moved to Milestone 6.6 (Fleet Management).

## [0.0.4] - 2026-04-02

### Added

- **Config validation engine** (`packages/boot/src/validate.ts`) — schema validation on startup with structured error/warning reporting
  - Missing required fields, invalid types, unknown keys
  - Cross-reference validation: agents ↔ providers, heartbeats, channel bindings, coding pipeline
  - Warns on hardcoded API keys/tokens in config (use env vars)
  - Warns on out-of-range values (temperature, max_tokens)
  - Human-readable error messages with config path and available options
- **`rivetos config validate`** CLI command — dry-run config validation without starting the runtime
- **Upgraded `rivetos doctor`** — now runs schema validation, config-aware env var checks, and provider connectivity tests
- 62 unit tests for config validation covering all sections, cross-references, edge cases
- `ConfigValidationError` thrown on boot with formatted output when config is invalid

### Changed

- `loadConfig()` now validates schema before resolving env vars — catches structural issues early
- `rivetos doctor` version bumped to match package version
- Root test script now includes validation tests alongside Nx project tests

## [0.0.1] - 2026-03-28

### Added

- Core runtime with agent loop, router, workspace loader, message queue
- Streaming-first provider interface (`AsyncIterable<StreamEvent>`)
- Domain-driven design with clean architecture (types → domain → application → plugins)
- **Providers:** Anthropic (with OAuth subscription auth), Google Gemini, xAI Grok, Ollama, llama-server
- **Channels:** Telegram (grammY) with typing indicator, inline buttons, reactions
- **Memory:** PostgreSQL adapter with full transcript archive, summary DAG, hybrid FTS+vector search
- **Tools:** Shell execution with safety categorization and AbortSignal support
- Full command surface: `/stop`, `/interrupt`, `/steer`, `/new`, `/status`, `/model`, `/think`, `/reasoning`
- Message queue with deterministic behavior (commands immediate, messages queued)
- Session persistence across restarts via Memory plugin
- Thinking level control (off/low/medium/high) mapped to provider-specific parameters
- CLI: `rivetos start/stop/status/doctor/config/version` + provider commands
- Toggleable structured logging via `RIVETOS_LOG_LEVEL` environment variable
- YAML configuration with `${ENV_VAR}` resolution
- GitHub Actions CI
- Apache 2.0 license
