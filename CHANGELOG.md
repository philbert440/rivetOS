# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Agent registry

- `@rivetos/agent-registry` (tagged `domain:shared`) is the shared preset store den, core, and the hub will import: file and Postgres backends, directory materialization, a short-lived cache, and a one-shot `agents.json` importer. Migration `0017_agent_presets.sql` adds the DataHub table `ros_agent_presets`. `AgentPreset` gains optional `node`, `directory`, and `sharedLink` (`nodeBaseUrl` stays, deprecated); roster-command helpers move into `@rivetos/types` so den and RivetHub share one map. No runtime behaviour change.
- den serves presets from the DataHub (`ros_agent_presets` on `config.pgUrl` / `RIVETOS_PG_URL`) and falls back to the per-node `agents.json` when Postgres is absent or the table is not ready yet. The first time the table answers ready, that file is imported once and renamed aside; imported rows get a directory on disk. A name that already exists (case-insensitively) is imported as `"<name> (<node>)"`, then `"<name> (<node> 2)"`, and if those are taken `"<name> (<node> <first 8 of id>)"`, instead of being dropped. Only an id conflict is skipped. A row that still cannot be imported leaves the source file in place and is reported as `unresolved`. The import result counts `renamed` disambiguations next to `imported` and `skipped`. Preset names are unique case-insensitively on every den, including file-only dens.
- Presets carry `node`, `directory`, and `sharedLink`. The hosting den materializes the directory (mode 0700) and a `rivet-shared` symlink to the shared directory. `sharedLink: false` does not create that symlink. On PATCH, `sharedLink: false` removes an existing `rivet-shared` link only when this patch flips it off and the directory stays the same; a directory move with `sharedLink: false` skips creating the link and does not unlink a different directory. Turning it back on links it again. The directory is not deleted with the preset.
- `nodeBaseUrl` is no longer required on create, and an empty patch value is ignored. A non-empty change to a stored URL is still rejected; an empty stored URL can be filled in. A client `node` other than this den's is rejected; `node` cannot be changed later.
- `RIVETOS_DEN_NODE_NAME` (then `RIVETOS_DEN_NODE_ID`, then the hostname) is this den's mesh node name. Boot sets it from `nodeNameFor(config)` (`mesh.node_name`, then `HOSTNAME`, then `local`) after prefix passthrough, so the config-derived name wins for an embedded den and a process-env `RIVETOS_DEN_NODE_NAME` is ignored there. The mesh registrar registers that same string: a whitespace-padded `mesh.node_name` is trimmed, and when `mesh.node_name` is unset the fallback is the hostname, not `'unknown'`. `RIVETOS_DEN_AGENTS_DIR` overrides the default preset directory root (`~/.rivetos/agents`). `/mesh.json` attaches `latest` using that same `config.nodeName`. On this box the hostname is `rivet-claude` and the mesh id is `ct115`; matching the hostname left `latest` on the wrong roster entry.
- `/healthz` includes `node` (the mesh node name) next to `name` (the hostname).
- Presets are `delegate_task` targets (by id or name) from both delegation engines. A hit runs as a durable `ros_tasks` row (`executor: harness-session`, `executorTarget` the preset harness, pinned to the hosting node) with the preset's directory, model, effort, and system prompt. The caller never names a node. A harness with no headless executor on that node fails pre-flight with the gap text and creates no row. The task runner forwards `workingDir`, `effort`, and `systemPromptAppend`. It materialises the directory and the `rivet-shared` symlink only for a preset the runner resolved (`resolvePreset`, boot passes the preset resolver's `find`) — not from a client `presetId` or `workingDir` — so a workflow step's case directory is not given a symlink into the shared tree. A `workingDir` that disagrees with that preset fails the task (`working_dir_mismatch`) and creates nothing. Chat-loop workflow steps still run with `workspaceDir` set to that case directory. `POST /api/tasks` for a preset (when the body does not set `executor`) creates that same harness-session row; no harness or an unimplemented one is 400, and a hosting node that is offline or unknown is 409. An explicit `executor` is left alone. The HTTP mesh fallback carries `toAgent`. The catalog lists presets (`kind: 'preset'`), and nodes advertise `metadata.harnessExecutors`.
- `POST /api/tasks` strips client `presetId`, `presetName`, `sharedLink`, `delegation`, and `meshFrom` unless the route itself resolved a preset (the preset branch writes them back). On that branch a non-blank body `model` wins, a blank `model` is omitted, and the preset owns `effort` and the system prompt; API rows are not delegations. Fresh roster reads (`rosterEntriesFresh({ timeoutMs })`, default 2s) and the catalog race the preset store and mesh registry against that bound and fall back to the last-known list and mesh snapshot, so a hung read cannot pin the request.
- A mesh node with no `node_name` takes its registry id, TLS cert lookup name, and task affinity from `nodeNameFor` (`HOSTNAME`, then `local`) instead of the literal `unknown`.

### Den

- The gateway enforces a browser origin policy. A request or WebSocket upgrade that carries an `Origin` is answered only when that origin is the gateway itself, the RivetHub desktop app, another den in the mesh roster, or listed in the new `den.allowed_origins`; anything else gets `403`. Responses echo the allowed origin instead of `Access-Control-Allow-Origin: *`. Clients that send no `Origin` (Android, hooks, CLI, mesh peers) are unaffected. A plain-HTTP gateway also requires loopback callers to use a loopback `Host` name or one listed in the new `den.allowed_hosts`. The mesh agent channel now refuses requests that carry an `Origin`. See CONFIG-REFERENCE → `den` → Browser origin policy.
- `POST /term/inject` writes only into sessions whose roster entry is an agent harness (`room: true`). Terminal-only sessions (`room: false`) answer 409 `session is not an agent harness` and nothing is written to the PTY (#810). Custom harness entries must set `room: true` to receive chat; terminal-only entries are typed through the terminal. Typing into a shell remains the terminal websocket.
- When a herdr-backed coding agent exits, den reaps the PTY and mux session after a short grace so chat inject 409s instead of writing into the leftover shell (#791). Adopted harness panes stay closed to inject until a pane-scoped `pane list`/`agent list` probe (or a working|idle|blocked frame, or `pane.agent_detected` with a live agent) proves a live agent; a fresh create stays not-ready and re-probes instead of killing a still-booting harness; `POST /term` during the grace mints a new pty immediately.
- Term ready-gate waits for output quiescence or herdr agent-idle (not first-chunk + delay). The first buffered inject on an agent pane is confirmed only by a herdr `working` frame; unconfirmed turns are recorded on the pty and never retried (#796).
- Claude transcript adapter strips Claude Code's `<pasted_content id="…">…</pasted_content id="…">` framing from a parsed user turn before it reaches the transcript, and from the session drawer title (#818). The den injects chat as a bracketed paste, which Claude Code wraps and stores verbatim; left as-is the wrapper showed as raw tags in the user bubble and, because the web client retires an optimistic bubble by exact-text match with no id, duplicated the turn. The strip is paired and id-anchored, so literal user text that merely mentions the tag is left untouched.
- The herdr agent kind is resolved from the roster entry's own `argv[0]` instead of its key, so a renamed entry (`claude-code` running `claude`) keeps the agent-idle ready-gate and first-turn confirm instead of silently falling back to output quiescence. The restart sweep (status subscription only) lets the `@rivet_agent_pane` stamp — written at create and on adopt — win and, with no stamp, retains a survivor when its `@rivet_command` tag is a kind or its roster entry's `argv[0]` is a kind. Reattach lets the stamp win too; a session with no `@rivet_agent_pane` stamp (created by an older den) keeps the previous key-based rule — the kind comes from the roster key and `argv[0]` must equal it — so a renamed-key or pinned-path plain pane is not reclassified and ended. Wrapper scripts and absolute paths remain plain panes by design — `--kind` would launch herdr's own PATH binary rather than the pinned one — and a `room: true` entry that resolves to a plain pane now logs once at spawn.
- The harness model/effort sheet carries an explicit `launchModel` flag, and the PTY driver stamps it onto the advertised capabilities: `claude-code` sets it (its `--model` is the launch-time switch and the sheet's alias set is what the CLI accepts). A sheet with `models` + `modelFlag` does NOT imply it — the pre-spawn picker gates on the flag, not the sheet's shape (#814). `POST /term` still validates the model/effort tokens against the resolved sheet either way.
- Model and effort flags are only added when the roster entry still runs the built-in program for that key.

### RivetHub client

- Composer model picker for conversations whose harness supports choosing a model per turn.
- `apps/rivethub-web`: the composer autofocuses on landing in a conversation and when switching to another, so you can type without clicking first. Waits for the socket (the textarea is disabled while reconnecting) and fires once per session. It never pulls focus from something you're already using — an inline rename, a filter, a dialog, or the terminal — and skips touch devices so a tap can't raise the keyboard over the transcript.
- A model picker appears before a harness's first launch in a conversation. The choice is then fixed for that harness in that conversation. Switching the conversation's agent clears it and offers the new agent's models. claude-code only today (#814).
- `apps/rivethub-web`: prevent sidebar and composer node pickers flashing while discovery is pending or failed with one saved node; keep multiple saved nodes available immediately (#809).
- `apps/rivethub-web`: hide node pickers only when connected to the sole saved node (or the app origin with no saved nodes) and mesh discovery confirms no peers; keep discovery and first-peer saving available.

### Harness integrations

- `opencode` harness (id `opencode`, provider `opencode-cli`, roster `opencode`) surfaced in RivetHub web, Android, and docs. Default `model` is `zai/glm-5.3-flash`. The installed OpenCode CLI owns backend, endpoint, and credentials.
- `pi` memory capture (`integrations/pi/rivet-memory`): v3 session jsonl watcher under `agent=rivet-deepseek` / `channel=pi`, systemd user unit `pi-memory-capture.service` / launchd `dev.rivetos.pi-capture`, wired into `rivetos plugins install` and doctor.

### Harness

- `grok-cli` provider: `max_turns` defaults to unset, so `--max-turns` is only passed when configured (#951). The old default of `1` ended every tool-using grok turn as `error_max_turns` — grok heartbeats and mesh tasks failed with a bare `grok result is_error`. A failed result now carries grok's `subtype` in the error (e.g. `grok result is_error: error_max_turns`).
- `claude-cli` provider: the `claude --version` availability probe is bounded (15 s, then SIGKILL, reported unavailable) and shared between concurrent callers. It had no timeout, and `Runtime.start()` awaits `router.healthCheck()` before starting channels, so a `claude` that never exits (e.g. a wrapper script whose `exec claude` resolves back to itself) held the gateway channel and health endpoint down indefinitely.
- `pi` harness (earendil-works/pi, provider `pi-cli`, roster command `pi`) on RivetHub web + Android, with a commented `@rivetos/provider-pi-cli` config example (recommended default backend z.ai GLM).
- feat(harness): add qwen-code — Qwen Code CLI as the eighth first-class harness (driver, provider, executor, hooks-driven memory capture via a qwen extension, web + Android).
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
