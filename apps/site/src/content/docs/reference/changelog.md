---
title: Changelog
sidebar:
  order: 5
description: Version history and release notes
---

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0] - 2026-08-30

First stable release. Everything since the 0.4.0 public beta: gateway + RivetHub, den, harness control plane, memory wiki, device mTLS, and per-user tenancy. Workspace packages align at 0.5.0 (RivetHub Electron keeps its own 0.5.4 updater cadence).

### Runtime / mesh

- Self-registering plugin manifests (`PluginManifest` + `register(ctx)`); `transport` category; in-process `@rivetos/mcp-server`.
- Providers: dedicated `@rivetos/provider-vllm` and `@rivetos/provider-llama-server` replace `openai-compat`; `@rivetos/provider-claude-cli` drives local `claude` with an embedded MCP bridge.
- Agent loop on the AI SDK (`@rivetos/aisdk`); providers migrated to official AI SDK packages.
- Mesh mTLS (shared CA, HTTPS agent channel, `mesh.tls`, `.mesh` DNS). **Breaking: all mesh nodes must upgrade together.** `mesh.secret` is ignored for agent-channel auth (warning on load); remove it from config.
- Durable task engine (`ros_tasks`): chat-loop executor, heartbeats, subagents, mesh delegation over shared Postgres, evaluation/retry/escalation.
- Gateway embedded in the rivetos process: `/api/tasks`, catalog, sessions, notifications WS, uploads, wiki, memory, workflows.
- Workflows v1: journal-replay engine, step SDK, budget/`parallel`, gateway + RivetHub runs UI (#438, #441–#446).
- MCP unification: core + sidecar split, era-negotiating stdio, MCP 2026-07-28 final / SDK 2.0 (#275, #276, #435, #451).
- `RIVETOS_INSTALL_ROOT` and `RIVETOS_SHARED_DIR` replace hardcoded `/opt/rivetos` and `/rivet-shared` (#595, #590).
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

- **License**: changed from MIT to Apache License 2.0. NOTICE file added.
- **Documentation overhaul**: updated all markdown files to reflect current architecture and features.
- Deleted `CODE_OF_CONDUCT.md`, `REFACTOR_PROGRESS.md`, `docs/PHASE2.md`, `docs/MILESTONE-2-3-ANALYSIS.md` (obsolete).

## [0.0.7] - 2026-04-03

### Changed

- **Runtime decomposition**: `runtime.ts` (576 lines) split into focused modules:
  - `runtime.ts` (296 lines): thin compositor, registration, routing, lifecycle
  - `turn-handler.ts` (263 lines): single message turn processing
  - `media.ts` (105 lines): attachment resolution, download, multimodal content
  - `streaming.ts`, `sessions.ts`, `commands.ts`: already extracted, unchanged
- **Delegation/subagent/skills registration** moved from `Runtime.start()` to `boot/registrars/agents.ts` for consistency with other registrars.
- Net -280 lines from runtime. Runtime no longer knows about images, base64, content parts, history management, hook execution, or memory appending.

## [0.0.6] - 2026-04-03

### Added

- **Boot package** (`@rivetos/boot`): composition root properly decomposed:
  - `config.ts`: YAML config loading with env var resolution
  - `validate.ts`: schema validation with structured error/warning reporting
  - `lifecycle.ts`: PID file, signal handlers, shutdown
  - `registrars/providers.ts`: provider instantiation
  - `registrars/channels.ts`: channel instantiation
  - `registrars/hooks.ts`: safety, fallback, auto-action, session hook wiring
  - `registrars/tools.ts`: tool plugin registration
  - `registrars/memory.ts`: memory backend wiring
  - `registrars/agents.ts`: delegation, subagent, skills registration
- **`typecheck` target** on all 21 nx packages: `tsc --noEmit` catches type errors independently per package.
- **Typing indicators** for Discord channel plugin (same pattern as Telegram: channel-managed, runtime-agnostic).
- **Message splitting** in channel plugins: Discord (2000 char) and Telegram (4096 char) handle overflow internally. Runtime has zero knowledge of message length limits.
- **Safety cap fix**: when agent hits tool iteration limit, preserves the accumulated response text instead of replacing it with a generic message.

### Changed

- **CLI rewired**: imports from `@rivetos/boot` instead of `../../../../src/boot.js`. No more rootDir violations.
- **Telegram typing refactored**: typing indicator management moved from internal `handleMessage()` wrapping to public `startTyping()`/`stopTyping()` methods, then back to channel-internal management (matching Discord's pattern). Runtime doesn't touch typing.
- **21/21 packages typecheck clean**: fixed ~138 type errors across the monorepo (config types, tool result types, delegation types, missing tsconfigs).

### Removed

- **`src/boot.ts`**: 500-line god file replaced by `@rivetos/boot` package with 7 focused files.
- **`src/config.ts`**, **`src/validate.ts`**: moved to `packages/boot/src/`.

## [0.0.5] - 2026-04-02

### Added

- **`rivetos logs`**: tail runtime logs with filtering (`--lines`, `--follow`, `--since`, `--grep`, `--json`). Wraps `journalctl` for systemd service, falls back to log file reading.
- **`rivetos skills list`**: discovers all skills from `skill_dirs`, parses SKILL.md frontmatter, shows name/description/trigger count.
- **`rivetos plugins list`**: enumerates configured providers, channels, memory backends, and tools with status (configured / available / missing-key).
- **`rivetos login`**: OAuth login for Anthropic subscription auth.

### Changed

- **CLI extracted to `@rivetos/cli`** (`packages/cli/`): independent Nx package with own `package.json`, `tsconfig.json`, build/test targets. Enables `nx run cli:build`, `nx run cli:test`, affected-only testing, and Nx caching. Old `src/cli/` removed.
- `@rivetos/cli` path alias added to `tsconfig.base.json`.
- Root `bin` entry updated to point to `packages/cli/src/index.ts`.

### Milestone

- **0.5 CLI Tools: Complete.** All planned CLI commands shipped. `mesh list/ping/remove` moved to Milestone 6.6 (Fleet Management).

## [0.0.4] - 2026-04-02

### Added

- **Config validation engine** (`packages/boot/src/validate.ts`): schema validation on startup with structured error/warning reporting
  - Missing required fields, invalid types, unknown keys
  - Cross-reference validation: agents ↔ providers, heartbeats, channel bindings, coding pipeline
  - Warns on hardcoded API keys/tokens in config (use env vars)
  - Warns on out-of-range values (temperature, max_tokens)
  - Human-readable error messages with config path and available options
- **`rivetos config validate`** CLI command: dry-run config validation without starting the runtime
- **Upgraded `rivetos doctor`**: now runs schema validation, config-aware env var checks, and provider connectivity tests
- 62 unit tests for config validation covering all sections, cross-references, edge cases
- `ConfigValidationError` thrown on boot with formatted output when config is invalid

### Changed

- `loadConfig()` now validates schema before resolving env vars; this catches structural issues early
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
