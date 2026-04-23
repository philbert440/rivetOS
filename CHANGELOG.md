# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed — `openai-compat` reasoning on newer vLLM builds

The streaming delta parser now accepts both the spec-standard
`reasoning_content` field and the shorter `reasoning` field. vLLM
`0.0.3.dev10+gc1dce8324` (and later) renamed the field from
`reasoning_content` to `reasoning` in streaming deltas, which silently
dropped reasoning output through this provider. Both field names now
flow into the `reasoning` chunk type; no configuration change required.

### Added — workspace templates & `docs/FILESYSTEM.md` canonical

Workspace file templates now live in `workspace-templates/` at the repo root. This is the source of truth for every new instance's `~/.rivetos/workspace/` layout.

- **`workspace-templates/`** — canonical `CORE.md`, `USER.md`, `WORKSPACE.md`,
  `MEMORY.md`, `CAPABILITIES.md`, `HEARTBEAT.md`, `FILESYSTEM.md`. All written
  in the generic "I am Rivet" voice — no per-instance specifics.
- **`docs/FILESYSTEM.md`** — canonical filesystem layout reference (runtime at
  `/opt/rivetos/`, config + workspace at `~/.rivetos/`, shared at
  `/rivet-shared/`). Mirror shipped in `workspace-templates/FILESYSTEM.md` so
  every instance carries it.
- **`rivetos init` refactor** — `writeWorkspaceTemplates` now reads from
  `workspace-templates/` by walking up from the CLI install location. Inline
  templates retained as a minimal fallback for unusual install layouts (e.g.
  npm global install without the repo alongside).

### Changed — documentation default workspace path

Every docs reference to `workspace: ./workspace` is now `workspace: ~/.rivetos/workspace`, matching `docs/FILESYSTEM.md`, `config.example.yaml`, and what `rivetos init` already writes. Touched: `README.md`, `docs/CONFIG-REFERENCE.md`, `docs/GETTING-STARTED.md`, `apps/site/src/content/docs/reference/config.md`, `apps/site/src/content/docs/guides/getting-started.md`.

### Added — `@rivetos/provider-openai-compat`

New provider tuned for strict OpenAI-compatible servers (vLLM, TGI, LocalAI,
etc.), parallel to `llama-server`. Key features:

- **Strict message ordering** — folds mid-conversation `role: 'system'`
  messages into `[SYSTEM NOTICE]` `role: 'user'` messages so vLLM +
  Qwen/Llama chat templates don't reject them with `System message must
  be at the beginning.` RivetOS's core loop legitimately injects
  mid-conversation system messages for context-window warnings, `/steer`
  events, and turn-timeout notices.
- **Native `reasoning_content`** consumption for vLLM servers running
  `--reasoning-parser deepseek_r1` / `qwen3`, with `<think>`-block
  fallback for inline reasoning.
- **`tool_choice` passthrough** — forwards `tools` and `tool_choice:
  auto` by default; server must run with `--enable-auto-tool-choice` and
  a `--tool-call-parser` (hermes / mistral / llama).
- **Forgiving `base_url`** — accepts either `http://host:port` or
  `http://host:port/v1`.
- **Optional `verify_model_on_init`** — probes `/v1/models` on boot and
  fails fast if the configured model id is not served.
- **Standard OpenAI sampling only** — no llama-native knobs
  (`typical_p`, `min_p`, `mirostat`, `repeat_penalty`, `repeat_last_n`)
  that strict servers reject.

Wiring: `boot` registrar + validator + CLI init/doctor/plugins.
`OPENAI_COMPAT_API_KEY` env var fallback. See
`plugins/providers/openai-compat/README.md` for details.

### Memory v5 — memory-quality pipeline

Full overhaul of the compactor and tool-call handling based on a 10-pick side-by-side probe across cloud and local summarizers. Shipped in `refactor/memory-quality-pipeline-v5`.

#### Added

- **v5 compactor prompts** (`plugins/memory/postgres/src/compactor/types.ts`) — three system prompts (leaf/branch/root) with exhaustiveness, no-outside-context, system-messages-first-class, and LaTeX-ban rules. Thinking mode enabled.
- **Rich message formatting** — ISO-minute timestamps on every message and layer, agent attribution per message (`[#01 2026-04-18T12:00Z opus/user]`), full conversation preamble with id/channel/title/span/message-count.
- **Tool-call content synthesis** — new `synthesizeToolCallContent` helper (`plugins/memory/postgres/src/tool-synth.ts`) with the same hardened undici client and prompt as the backfill script. Model-agnostic (reads `TOOL_SYNTH_ENDPOINT`/`TOOL_SYNTH_MODEL`).
- **Async tool-synth queue** — `ros_tool_synth_queue` table + `migrate-v3.ts` + `adapter.ts` enqueue hook on empty-content tool-call writes + compaction-worker drain job. Inserts never fail on synth errors.
- **`rivetos memory backfill-tool-synth`** CLI subcommand — parallel workers (`--concurrency`, `--urls` for NUMA-pinned llama-server pairs), resumable, dry-run support, JSON output.
- **`rivetos memory queue-status`** CLI subcommand — `ros_tool_synth_queue` health by attempts, plus count of historical unqueued candidates.
- **Hardened undici client** — `Agent` with no `headersTimeout`/`bodyTimeout` and 3-attempt retry with 5/10/15s backoff. Replaces raw `fetch` + 60s timeout in compactor and tool-synth paths.
- **Unit tests** — 15 formatter tests (`compactor/formatters.test.ts`) covering preamble, timestamps, agent attribution, tool-call fallback, span computation. 13 tool-synth tests (`tool-synth.test.ts`) covering validation, retries, auth, request shape.

#### Changed

- **Summary token budgets** raised to 7k (leaf) / 14k (branch) / 20k (root). Thinking mode needs real headroom.
- **Source-message truncation removed** — 128k context window means no need to chop.
- **Compactor model tag** → `rivet-refined-v5` (previously `rivet-refined-v4` or `unknown`).

#### Migration

1. `npx tsx plugins/memory/postgres/src/migrate-v3.ts` (idempotent — creates `ros_tool_synth_queue`).
2. Redeploy `services/compaction-worker/` — picks up v5 prompts via barrel re-exports.
3. Optional: `rivetos memory backfill-tool-synth` to synthesize content for historical empty rows.

See `docs/MEMORY-DESIGN.md` and `docs/DECISIONS.md` §15 for rationale and probe methodology.

## [0.4.0] - 2026-04-05

### First Public Beta

**The first public release.** Full documentation, developer experience tooling, containerized distribution, and launch readiness. v1.0.0 will be the first LTS release.

#### Changed (release-wide)
- **Node.js requirement** bumped from 22 to 24
- **All package versions** set to 0.4.0 (previously unreleased 1.0.0 placeholders)
- **Containers moved** from `containers/` to `infra/containers/`
- **Plugin registration** standardized — all plugins export `createPlugin()` factory
- **Plugin discovery** — convention-based via `package.json` `rivetos` field (replaces hardcoded switch statements)

### Milestone 8: Documentation & Launch

Documentation, developer experience tooling, and launch readiness.

#### Added
- **docs/GETTING-STARTED.md** — Zero to running in 5 minutes. Docker, bare-metal, and interactive wizard paths.
- **docs/CONFIG-REFERENCE.md** — Every config option documented with types, defaults, and examples.
- **docs/PLUGINS.md** — Complete guide to writing provider, channel, tool, and memory plugins.
- **docs/SKILLS.md** — Guide to writing, testing, and distributing skills.
- **docs/DEPLOYMENT.md** — Docker, Proxmox, multi-agent mesh, networking, backup/restore.
- **docs/TROUBLESHOOTING.md** — Common issues, `rivetos doctor` output guide, FAQ.
- **`rivetos plugin init`** — CLI command to scaffold new plugins (wraps `@rivetos/nx:plugin`).
- **`rivetos skill init`** — CLI command to scaffold new skills with SKILL.md template.
- **`rivetos skill validate`** — Validates skill frontmatter, triggers, file references.
- **Example configs** — `examples/single-agent.yaml`, `multi-agent.yaml`, `local-only.yaml`, `homelab.yaml`.

#### Changed
- **README.md** — Complete rewrite for v1.0. Fixed stale workspace file references (SOUL.md → CORE.md), updated architecture diagram, added container deployment docs, expanded CLI reference.
- **CONTRIBUTING.md** — Added plugin discovery, container workflow, and skill development sections.
- **docs/ARCHITECTURE.md** — Updated to reflect M6-M8 additions (mesh, observability, security, infra).

## [0.9.0] - 2026-04-05

### Milestone 7: Reliability & Polish

**Production-grade reliability.** Structured errors, observability, diagnostics, security essentials, and multi-agent mesh.

#### Added
- **Structured error types** — `RivetError` hierarchy with codes, severity, retryable flags. Subclasses: `ChannelError`, `MemoryError`, `ConfigError`, `ToolError`, `DelegationError`, `RuntimeError`.
- **Channel reconnection** — `ReconnectionManager` with exponential backoff, jitter, configurable retries.
- **Provider circuit breaker** — Closed/open/half-open states, windowed failure tracking, auto-recovery.
- **Memory backend resilience** — Connection pooling, health checks, graceful degradation.
- **Structured logging** — JSON mode for production, pretty-print for dev. Component-scoped loggers.
- **`rivetos logs`** — Tail agent logs from CLI. Docker, systemd, and bare-metal backends. Filter by agent, level, pattern, time range.
- **Runtime metrics** — Turns/min, tool calls, token usage per agent, latency percentiles, error tracking.
- **Health endpoints** — `GET /health` (full status), `GET /health/live` (liveness), `GET /metrics` (raw metrics).
- **Enhanced `rivetos status`** — Rich display from health endpoint with agents, providers, channels, memory, metrics.
- **Enhanced `rivetos doctor`** — 12 check categories: system, config, workspace, env vars, secrets, OAuth, containers, memory, shared storage, DNS, providers, peers. `--json` flag.
- **`rivetos test`** — Smoke test suite: config validation, provider ping, pg connectivity, tool registry, health endpoint, shared storage. `--quick`, `--verbose`, `--json`.
- **Secret management** — `redactSecrets()` for safe logging, `.env` permissions enforcement, `validateNoSecretsInConfig()`, 1Password `op://` resolution.
- **Audit log rotation** — Configurable retention (default 90 days), gzip compression after 7 days, size warnings.
- **Multi-agent mesh** — `FileMeshRegistry` with heartbeat, pruning, seed sync. Full test suite.
- **Mesh-aware delegation** — `MeshDelegationEngine` routes `delegate_task` to remote agents via HTTP.
- **Mesh endpoints** — `/api/mesh` (GET nodes), `/api/mesh/join` (POST register), `/api/mesh/ping` (GET liveness).
- **`rivetos mesh`** — CLI commands: `list`, `ping`, `status`, `join`.
- **`rivetos init --join`** — Wizard supports mesh discovery during setup.
- **`rivetos update --mesh`** — Rolling fleet update with health checks between nodes.

## [0.8.0] - 2026-04-05

### Milestone 6: Containerized Distribution

**The container is the product.** Interactive setup, container images, infrastructure as code, source-based updates.

#### Added
- **Agent Dockerfile** — Multi-stage, non-root, tini init, healthcheck.
- **Datahub Dockerfile** — PostgreSQL 16 + pgvector, shared directory structure, init scripts.
- **Nx build targets** — `project.json` for both containers with dependency graph and SHA tagging.
- **Docker Compose** — Full `docker-compose.yaml` with datahub, agent template, multi-agent profiles, networking.
- **Data persistence model** — Workspace bind mount, named volumes for pgdata + shared. `DATA-PERSISTENCE.md` documented.
- **CI pipeline** — `.github/workflows/ci.yml`: PR lint+test, merge build+push, release publish.
- **`rivetos build`** — CLI command for local container builds.
- **Interactive setup wizard** (`rivetos init`) — 6 phases: detect → deployment → agents → channels → review → generate. Uses @clack/prompts.
- **Deployment config schema** — Full TypeScript types (`DeploymentConfig`, Docker, Proxmox, Kubernetes) in `@rivetos/types`. Validator in `@rivetos/boot`.
- **`rivetos agent add/remove/list`** — Agent management commands.
- **`rivetos config`** — Reopens wizard with current values pre-filled.
- **Pulumi infrastructure** — Abstract components (`RivetAgent`, `RivetDatahub`, `RivetNetwork`). Docker and Proxmox providers.
- **`rivetos infra up/preview/destroy`** — CLI commands for infrastructure management.
- **Source-based update flow** — `rivetos update` pulls source → rebuilds containers → restarts. `--version`, `--prebuilt`, `--mesh`, `--no-restart` flags. Data persistence verification before rebuild.

#### Changed
- **Convention-based plugin discovery** — All 17 plugins declare `rivetos` manifest in `package.json`. New `discovery.ts` scans plugin dirs. Registrars use dynamic import instead of switch statements.
- **Standardized tool plugin interface** — All tool plugins export `createPlugin()` → `ToolPlugin` with `getTools()`.
- **Cleaned root `package.json`** — Removed leaked plugin dependencies (discord.js, grammy, pg). Only `yaml` remains.
- **Deleted dead code** — Backward-compat shim `core/src/runtime.ts`, stale TODO references.
- **Fixed architecture violation** — `memory-postgres/review-loop.ts` no longer imports from `@rivetos/core`.

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
