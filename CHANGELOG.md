# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
- **Providers:** Anthropic (with OAuth subscription auth), Google Gemini, xAI Grok, Ollama, OpenAI-compatible
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
