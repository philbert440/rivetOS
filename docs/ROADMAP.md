# RivetOS Roadmap

**Version:** v0.0.x → v1.0.0 LTS  
**Last updated:** April 2026  
**Philosophy:** The lightweight Linux of agent runtimes. Small clean stable core, everything else is a plugin or skill.

---

## Milestone 0: Foundation — Make It Reliable
**Target: v0.0.x** ✅  
**Theme:** You can't ship what doesn't test.

### 0.1 — Test Coverage for Core Domain ✅
- [x] Unit tests for `AgentLoop` (turn execution, tool iteration limits, abort/steer) — `loop.test.ts`
- [x] Unit tests for `Router` (agent resolution, provider mapping, fallback behavior) — `router.test.ts`
- [x] Unit tests for `WorkspaceLoader` (file injection, caching, system prompt construction) — `workspace.test.ts` (15 tests)
- [x] Unit tests for `MessageQueue` (ordering, dedup, command interception) — `queue.test.ts`
- [x] Unit tests for `SkillManager` (discovery, frontmatter parsing, trigger matching) — `skills.test.ts` (18 tests)
- [x] Integration test: full turn lifecycle (message in → provider call → tool execution → response out) — `runtime.test.ts`

### 0.2 — Fix Known Bugs ✅
- [x] **skill_dirs wiring:** `boot.ts` now passes `config.runtime.skill_dirs` to Runtime constructor
- [x] **Compaction:** Background compactor fixed — proper scoring and summarization
- [x] **Memory embedder:** Background embedder fixed — error recovery and batch processing
- [ ] **Web search 403:** Google CSE API returning 403 — diagnose quota/billing/key issue or add fallback provider

### 0.3 — CI Pipeline & Build System ✅
- [x] GitHub Actions workflow: lint → type-check → test on push/PR
- [x] **Fix workspace globs:** `plugins/*` → `plugins/{channels,memory,providers,tools}/*` — Nx sees all 17 packages
- [x] **Per-package test scripts:** All 17 packages have `test` scripts (real or no-op)
- [x] **Root test via Nx:** `npm test` → `npx nx run-many -t test` — caching, parallelism, affected-only
- [x] **CI uses Nx affected:** `npx nx affected -t test build` with `nrwl/nx-set-shas`, `fetch-depth: 0`
- [x] **Nx cache in CI:** GitHub Actions cache for `.nx/cache` across runs
- [x] Branch protection: require CI pass before merge to `main` *(GitHub settings — manual)*

### 0.4 — Config Validation ✅
- [x] Schema validation on startup (missing required fields, invalid types, unknown keys)
- [x] Helpful error messages: "provider 'xai' referenced by agent 'grok' but not defined in [providers]"
- [x] Warn on common mistakes (API key in config file, missing env var)
- [x] `rivetos doctor` validates config + connectivity to all configured providers/channels

### 0.5 — CLI Tools ✅
- [x] `rivetos version` — dynamic from package.json + git short hash
- [x] `rivetos init` — first-run setup (config, workspace, symlink)
- [x] `rivetos update` — git pull, npm install, re-symlink
- [x] `rivetos start/stop/status` — runtime lifecycle
- [x] `rivetos help` — command reference
- [x] `rivetos logs` — tail runtime logs with filtering (journalctl wrapper + structured log parsing)
- [x] `rivetos config validate` — check config without starting (dry-run of schema validation from 0.4)
- [x] `rivetos skills list` — show all discovered skills with trigger counts
- [x] `rivetos plugins list` — show loaded plugins with status
- [x] `rivetos login` — OAuth login for Anthropic subscription auth
- [x] **CLI extracted to `@rivetos/cli`** — independent Nx package at `packages/cli/`, own build/test, path alias in tsconfig.base

---

## Milestone 1: Coreutils — The Base Toolset ✅
**Target: v0.1.0**  
**Theme:** Every agent needs these. They ship with every RivetOS install.

Modeled after the Claude Code core tool patterns — battle-tested primitives adapted for multi-model, multi-agent use. These replace the current "everything goes through shell" approach with purpose-built tools that have safety rails, structured output, and audit trails.

### 1.1 — File Read (`file_read`) ✅
**Plugin:** `plugins/tools/file/`

- [x] Read files with line numbers, range selection (`start_line`, `end_line`)
- [x] Binary file detection
- [x] Max file size guard (configurable, default 1MB)
- [x] Returns line-numbered output for precise referencing
- [ ] Image files → base64 for vision-capable models, description for others
- [ ] PDF → text extraction (pdftotext or similar)
- [ ] Jupyter notebooks → cell-by-cell rendering

### 1.2 — File Write (`file_write`) ✅
**Plugin:** `plugins/tools/file/`

- [x] Write or overwrite a file with full content
- [x] Create parent directories automatically
- [x] Backup option (`.bak` file)
- [x] Returns confirmation with byte count and path
- [ ] **Safety:** Require `file_read` of the target before overwrite (prevent blind overwrites)

### 1.3 — File Edit (`file_edit`) ✅
**Plugin:** `plugins/tools/file/`

- [x] Surgical edits: provide `old_string` (exact match) and `new_string` (replacement)
- [x] Must match exactly one location in the file (fail if ambiguous)
- [x] Multiline replacements
- [x] Context snippet after edit
- [ ] **Safety:** Require `file_read` first (enforced — tool checks read history for this turn)

### 1.4 — Search: Glob (`search_glob`) ✅
**Plugin:** `plugins/tools/search/`

- [x] Find files by glob pattern (`**/*.ts`, `src/**/test*`)
- [x] Ignores node_modules by default
- [x] Configurable max results
- [x] Custom cwd support

### 1.5 — Search: Grep (`search_grep`) ✅
**Plugin:** `plugins/tools/search/`

- [x] Search file contents by regex or literal pattern
- [x] Case-sensitive/insensitive flag
- [x] Fixed string mode
- [x] Include filter by file pattern
- [x] Excludes node_modules by default

### 1.6 — Web Search (`web_search`) — Upgraded ✅
**Plugin:** `plugins/tools/web-search/`

- [x] **Multi-provider:** Google CSE primary → DuckDuckGo HTML fallback
- [x] Automatic failover on 403/quota/5xx errors
- [x] Source attribution per result (`[Source: Google/DuckDuckGo]`)
- [x] Retry with exponential backoff (2 retries, 1s/2s delays)
- [x] Result caching (5min TTL, in-memory)
- [ ] xAI native search integration

### 1.7 — Web Fetch (`web_fetch`) — Upgraded ✅
**Plugin:** `plugins/tools/web-search/`

- [x] **Structured extraction:** HTML → markdown (article > main > body priority)
- [x] Removes script/style/nav/header/footer/aside
- [x] Converts h1-h6, links, lists, bold/italic, code blocks to markdown
- [x] Full HTML entity decoding
- [x] Content caching (10min TTL, in-memory)
- [x] Configurable user agent (config or `RIVETOS_USER_AGENT` env)
- [x] PDF detection with placeholder message
- [x] GitHub raw content Accept header
- [x] Truncation hint with max_chars guidance

### 1.8 — Shell (`shell`) — Upgraded ✅
**Plugin:** `plugins/tools/shell/`

- [x] **Command categorization:** read-only / write / dangerous
- [x] Configurable approval levels per category (allow / warn / block)
- [x] Git-aware safety: warns on force push, hard reset, branch -D
- [x] Session working directory persistence (`cd` persists across calls)
- [ ] **Background mode:** Long-running commands with handle + poll
- [ ] **Sandbox option:** Restricted shell or container for untrusted commands

### 1.9 — Ask User (`ask_user`) ✅
**Plugin:** `plugins/tools/interaction/`

- [x] Structured question tool: free text, yes/no, multiple choice
- [x] Context field for explaining why info is needed
- [x] Default values
- [x] Input validation (empty questions, missing choices, invalid types)

### 1.10 — Task List (`todo`) ✅
**Plugin:** `plugins/tools/interaction/`

- Read/write a structured task list persisted to a file
- Operations: add, update (status/content), delete, list
- Status: pending, in_progress, done
- Scoped per session or persistent across sessions (configurable)
- Gives models a working scratchpad for multi-step plans
- Returns formatted task list with status indicators

### 1.11 — Memory Tools (consolidated) ✅
**Plugin:** `plugins/memory/postgres/` (tools live alongside the memory adapter)

- [x] **`memory_search`** — Unified search + auto-expand. Replaces `memory_grep`, `memory_expand`, `memory_describe`, `memory_expand_query`. Searches messages + summaries, auto-expands top summary hits to children/source messages, returns structured scored output. Supports FTS/trigram/regex modes, agent/date filters, optional LLM synthesis.
- [x] **`memory_browse`** — Chronological message browsing (unchanged). For reviewing sessions and catching up on activity.
- [x] **`memory_stats`** — System health diagnostics. Embedding queue depth, unsummarized message counts, conversations needing compaction, orphan summaries, summary tree depth, embedding coverage, freshness indicators.
- [x] Filter by agent, time range, scope (messages/summaries/both)
- [x] Wired in `boot.ts` — registered when memory plugin initializes
- [x] Consolidated from 6 tools → 3 (less tool-call orchestration needed by the LLM)

---

## Milestone 2: Hooks & Lifecycle Events ✅
**Target: v0.2.0**  
**Theme:** Extensibility without touching core.

### 2.1 — Hook System Architecture ✅
- [x] Lifecycle events: `provider:before`, `provider:after`, `provider:error`, `tool:before`, `tool:after`, `session:start`, `session:end`, `turn:before`, `turn:after`, `compact:before`, `compact:after`
- [x] **Types:** Full type system in `@rivetos/types` — `HookContext` variants for each event with typed fields (provider, model, args, results, usage, latency, etc.)
- [x] **HookPipelineImpl:** Async composable pipeline in `@rivetos/core` — priority ordering (0-99), data passing via mutable context, short-circuit (abort/skip), agent/tool filters, error modes (continue/abort/retry)
- [x] **Wired into AgentLoop:** `provider:before` (pre-request), `provider:after` (post-response), `provider:error` (fallback trigger), `tool:before` (safety gate — can block), `tool:after` (post-execution metrics)
- [x] **Wired into Runtime:** `turn:before` (pre-processing, can skip), `turn:after` (post-turn analytics)
- [x] Config types: `HookConfig` for declarative hooks, `FallbackConfig` for fallback chains
- [x] **25 tests** — priority, data passing, short-circuit, error modes, filters, async, composability
- [ ] Hook handler types: `shell` (run a command), `http` (webhook) — currently only `internal` (TypeScript function)
- [ ] Hooks defined in config.yaml (declarative registration at boot — types ready, loader not implemented)

### 2.2 — Safety Hooks (PreToolUse) ✅
- [x] **Shell danger blocker:** Blocks catastrophic commands (rm -rf /, fork bombs, pipe-to-shell), warns on risky ones (force push, hard reset)
- [x] **Workspace fence:** Blocks file operations outside allowed directories, always allows /tmp
- [x] **Audit logger:** Logs all tool invocations to `.data/audit/YYYY-MM-DD.jsonl`, redacts secrets, truncates long values
- [x] **Custom rule engine:** User-defined block/warn patterns per tool. Ships with: npm-dry-run, no-delete-git, warn-config-write
- [x] **Priority ordering:** Shell danger (10) → workspace fence (15) → custom rules (20) → audit (90)
- [x] **Boot wiring:** All safety hooks registered at startup from config
- [x] **29 tests** — blocking, warnings, fence boundaries, audit logging, secret redaction, custom rules, priority ordering

### 2.3 — Auto-Actions (PostToolUse) ✅
- [x] **Auto-format:** Runs prettier after file_write/file_edit on JS/TS/JSON/CSS/MD/YAML (opt-in via config)
- [x] **Auto-lint:** Runs eslint --fix after file_write/file_edit on JS/TS files (opt-in)
- [x] **Auto-test:** Runs vitest --related after source file changes (skips test files themselves) (opt-in)
- [x] **Auto git check:** Runs tsc --noEmit after git commit (opt-in)
- [x] **Custom actions:** User-defined post-tool commands with file interpolation, file pattern filters, soft-fail option
- [x] **All opt-in:** Nothing runs by default. Enable via `runtime.auto_actions` config.
- [x] **Injected shell executor:** Testable without real child_process
- [x] **21 tests** — format, lint, test, git check, custom actions, soft fail, aggregate config

### 2.4 — Session Hooks ✅
- [x] **session:start:** Records session metadata, loads daily context from workspace notes
- [x] **session:end — summary:** Writes session summary (agent, turns, tokens) to daily notes
- [x] **session:end — auto-commit:** Auto-commits pending workspace changes on session end (opt-in, off by default)
- [x] **compact:before:** Captures pre-compaction snapshot (message count, timestamp) for verification
- [x] **compact:after:** Calculates compression ratio, verifies context survived, logs to daily notes
- [x] **Injected file writer + shell:** Fully testable without real filesystem
- [x] **Boot wiring:** All session hooks registered at startup (auto-commit opt-in)
- [x] **18 tests** — start context, summary writing, auto-commit, compaction snapshot/verify, pipeline integration

### 2.5 — Provider Fallback Chains ✅
- [x] Generalized fallback system across **all providers** via hook pipeline
- [x] Config: `fallbacks: ['model-b', 'provider:model-c']` — same-provider or cross-provider
- [x] Triggers: configurable per chain — status codes (default: 429, 503), timeout detection (ETIMEDOUT, socket hang up, AbortError), optional auth failure
- [x] Cascade: progresses through chain, exhausts gracefully, resets on cooldown (5min)
- [x] Session isolation: separate fallback state per provider:session
- [x] Metadata: `fallbackFrom`, `fallbackTo`, `fallbackIndex`, `fallbackReason` for downstream hooks
- [x] Boot wiring: config → `createFallbackHook()` → pipeline registration
- [x] Per-agent fallback support: `agent.fallbacks: ['model-a', 'model-b']`
- [x] **16 tests** — trigger codes, timeout, auth, chain progression, exhaustion, cross-provider, session isolation, composability
- [ ] Metrics: track fallback frequency per provider (feed into M6 observability)

### 2.6 — MCP Client Plugin ✅
- [x] MCP client as a tool plugin (`@rivetos/tool-mcp-client`)
- [x] Connect to MCP servers via stdio, StreamableHTTP, or SSE transport
- [x] Discover tools via `listTools()` → register as native RivetOS tools
- [x] MCP tool results → `ToolResult` (text or multimodal `ContentPart[]`)
- [x] Config: `mcp.servers` section in config.yaml with transport, command/URL, toolPrefix, env, timeout
- [x] Auto-reconnect on disconnect (configurable)
- [x] Tool prefix support to avoid name collisions across servers
- [x] Boot integration: MCP servers connect at startup, tools registered, shutdown on stop
- [x] **22 tests** — connection, discovery, execution, error handling, multimodal, multi-server
- [ ] Test against live Nemotron MCP server on GERTY (SSH access needed)
- [ ] Test against Google Workspace MCP server
- **NOT an MCP server** — RivetOS exposes its own tools via its own plugin system, not MCP

---

## Milestone 3: Multi-Agent Communication ✅
**Target: v0.3.0**  
**Theme:** Agents that can work together — within an instance and across the network.

### 3.1 — Delegation (Intra-Instance) ✅
Delegation = synchronous, intra-instance. One agent spawns a sub-loop with a different provider/model within the same process. Caller waits for the result.

- [x] `DelegationEngine` + `SubagentManagerImpl` with `delegate_task`, `subagent_spawn`, `subagent_send`, `subagent_list`, `subagent_kill` tools
- [x] `fromAgent` context: delegated agent gets rich context (requesting agent, chain depth, additional context lines)
- [x] Delegation chains: A delegates to B, B can delegate to C (configurable depth limit, default 3)
- [x] Result caching: same task+agent returns cached result (5 min TTL, configurable)
- [x] Timeout handling: graceful timeout with partial result return
- [x] Hook integration: `delegation:before` / `delegation:after` events on the hook pipeline (blocking support)
- [x] **26 tests** for DelegationEngine (basic, chains, cache, timeout, hooks, tool)
- [x] **20 tests** for SubagentManagerImpl (spawn run/session, send, yield, kill, list, tools)

### 3.2 — Inter-Agent Messaging (Cross-Instance) ✅
Messaging = asynchronous, cross-instance. Agent-to-agent communication over HTTP. The receiving agent processes the message through its full normal pipeline.

- [x] **Agent Channel Plugin** (`@rivetos/channel-agent`) — HTTP endpoint for incoming agent messages
- [x] **Agent Messaging Tool** (`agent_message`) — sends messages to remote agents via HTTP (sync + async modes)
- [x] **Peer Config** — `peers` section in config with URL and optional per-peer secret override
- [x] **Auth** — shared secret via Bearer token
- [x] **Memory** — receiving agent records with `channel: 'agent'`, `userId: 'agent:<name>'`
- [x] **Response flow** — sync: response in HTTP body. Async: 202 accepted.
- [x] **Health endpoint** — `GET /health` returns agent info and status
- [x] **19 tests** — lifecycle, health, auth, message delivery, sync/async, tool schema, peer messaging, bidirectional

---

## Milestone 4: Memory & Context
**Target: v0.4.0**  
**Theme:** Agents that actually remember.

### 4.1 — Complete Background Embedder
- Finish partial implementation: reliable embedding of all messages
- Batch processing with configurable concurrency
- Error recovery: retry failed embeddings, skip permanently failed
- Embedding model configuration (local via Ollama or cloud)
- Progress reporting in logs

### 4.2 — Complete Compaction System
- Hierarchical summarization: messages → summaries → meta-summaries
- Configurable compaction triggers (message count, token count, time)
- Context-aware compaction: preserve tool outputs, code snippets, decisions
- `PreCompact`/`PostCompact` hooks for custom preservation logic
- Manual trigger: `/compact [focus]` with optional focus parameter

### 4.3 — Auto-Memory
- `PostToolUse` hook that captures learnings without manual writes
- Pattern detection: "this build command works", "this file is the auth entry point"
- Writes to structured auto-memory file (separate from manual MEMORY.md)
- Dedup: don't re-capture things already known
- Configurable: opt-in per agent, per tool

### 4.4 — Directed Context Loading
- `/context add <file>` — pin a file into context for the session
- `/context remove <file>` — unpin
- `/context list` — show pinned files
- Persistent across compaction (pinned files survive)
- Replaces ad-hoc "read this file" instructions

---

## Milestone 5: Developer Experience
**Target: v0.5.0**  
**Theme:** Make it easy for others to build on.

### 5.1 — Plugin SDK
- `rivetos plugin init <type> <name>` scaffolds a new plugin
- Types: channel, provider, tool, memory
- Generated: TypeScript boilerplate, tsconfig, package.json, README, test file
- Reference docs auto-linked in generated README

### 5.2 — Skill Authoring
- `rivetos skill init <name>` scaffolds a new skill
- Generated: directory, SKILL.md with frontmatter template, README
- Skill validation: `rivetos skill validate <name>` checks frontmatter, triggers, file references
- Skill testing: `rivetos skill test <name>` simulates trigger matching against sample queries

### 5.3 — Documentation
- `docs/GETTING-STARTED.md` — zero to running in 5 minutes
- `docs/ARCHITECTURE.md` — update with coreutils, hooks, skills (exists, needs refresh)
- `docs/PLUGINS.md` — how to write each plugin type with examples
- `docs/SKILLS.md` — how to write and distribute skills
- `docs/CONFIG-REFERENCE.md` — every config option documented
- `docs/MIGRATION.md` — migrating from OpenClaw to RivetOS
- API reference auto-generated from TypeScript interfaces

### 5.4 — CLI Improvements
- `rivetos benchmark` — simple latency test against configured providers
- Additional CLI polish deferred from 0.5 (TBD based on usage patterns)

---

## Milestone 6: Production Hardening
**Target: v0.6.0**  
**Theme:** Ready for other people to run.

### 6.1 — Error Handling & Recovery
- Graceful provider failures (retry with backoff, fallback to secondary provider)
- Channel reconnection (Telegram/Discord disconnect → auto-reconnect)
- Memory backend connection pooling and health checks
- Crash recovery: resume active sessions from transcript on restart
- Structured error types (not just string messages)

### 6.2 — Observability
- Structured logging (JSON mode for production, pretty for dev)
- Metrics: turns/minute, tool calls/turn, provider latency, token usage
- OpenTelemetry traces (optional plugin)
- Health endpoint for external monitoring
- `/status` shows runtime health, active sessions, provider connectivity

### 6.3 — Security
- Tool allowlists/blocklists per agent
- Workspace isolation: agent can only access its own workspace files
- Secret management: integration with 1Password, env vars, config encryption
- Audit log: every tool call, every provider call, every file access
- Rate limiting per user/channel

### 6.4 — Systemd Integration
- `rivetos service install` generates systemd unit file
- `rivetos service start/stop/status/logs` wrappers
- Auto-restart on crash with backoff
- Environment file for secrets
- Journal integration for logging

### 6.5 — Infrastructure as Code Research
- [ ] Evaluate IaC tools for the monorepo (Pulumi, Terraform, Ansible, or combination)
- [ ] Define what gets codified: CT provisioning, networking, SSH config, service setup
- [ ] Decide on platform direction (Proxmox vs. alternatives — keep options open)
- [ ] Prototype: single declarative file → deploy a new agent node end-to-end
- [ ] Document findings and recommendation in `docs/INFRASTRUCTURE.md`

### 6.6 — Pre-Packaged Agent Containers + Auto-Mesh
**Theme:** Clone a golden template → first-boot wizard asks "who are you?" → fully meshed agent in 60 seconds.

#### 6.6.1 — Golden Container Template
- [ ] Pre-packaged container template with everything pre-installed:
  - Node.js, npm, git, common tools
  - `/opt/rivetos/` repo cloned and built
  - `/usr/local/bin/rivetos` symlinked
  - `rivetos.service` in systemd (enabled, but waits for first-run config)
  - `philbot` user created with standard config
  - SSH hardened (`prohibit-password`, `MaxAuthTries 3`)
  - OTel collector ready (just needs endpoint config)
  - No template bloat (no postfix, no snapd, no avahi)
- [ ] Template versioning: tag template with RivetOS version, rebuild on major updates
- [ ] Provisioning script or CLI to clone template with ID + hostname + IP

#### 6.6.2 — First-Boot Identity Wizard (`rivetos init`)
- [ ] Detect first-run state (no `~/.rivetos/config.yaml`)
- [ ] Interactive setup:
  - Agent name (e.g., "grok", "opus", "gemini", "local")
  - Provider + API keys (or local model endpoint)
  - Personality: generates `SOUL.md`, `IDENTITY.md` unique to this agent
  - Channel bindings (Discord channel IDs, Telegram tokens)
  - Heartbeat schedule
- [ ] Write config, create workspace, generate SSH keypair
- [ ] Each agent gets its own soul — different personality, different strengths, same team

#### 6.6.3 — Auto-Mesh on First Boot (`rivetos init --join <host>`)
- [ ] Connect to any existing RivetOS node (the "seed node")
- [ ] Seed node shares its mesh registry (all known agents + IPs + capabilities)
- [ ] Bidirectional SSH key exchange: new node ↔ all existing nodes
- [ ] SSH config entries written automatically (`ssh ct100`, `ssh rivet-grok`, etc.)
- [ ] New agent registered in mesh registry, propagated to all nodes
- [ ] Full mesh established — every node can reach every other node

#### 6.6.4 — Mesh Registry
- [ ] `~/.rivetos/mesh.json` — source of truth per node, synced across fleet
- [ ] Per-node entry: agent name, host, IP, port, model, provider, capabilities, tags
- [ ] Auto-sync on change (push to all peers, or piggyback on syncthing)
- [ ] `rivetos mesh list` — all agents, status, versions
- [ ] `rivetos mesh ping` — health check across the fleet
- [ ] `rivetos mesh remove <agent>` — deregister, revoke keys, clean up

#### 6.6.5 — Mesh-Aware Delegation
- [ ] `delegate_task` / `subagent_spawn` read mesh registry for available agents
- [ ] Name-based routing: "delegate to grok" → resolve host from mesh → execute
- [ ] Capability-based routing: "need a fast model" → pick by tags/provider
- [ ] Fallback chains: if target is down, try next agent with matching capability
- [ ] Cross-node tool execution: CT101 agent invokes a tool running on CT103

#### 6.6.6 — Fleet Management
- [ ] `rivetos update --mesh` — rolling update across all nodes
- [ ] One at a time, health check between each, rollback on failure
- [ ] Version consistency warnings if nodes drift
- [ ] Template rebuild pipeline: update template → `rivetos mesh upgrade` pushes to fleet

---

## Milestone 7: v1.0.0 LTS
**Target: v1.0.0**  
**Theme:** Pin it and forget it.

### 7.0 — Release Criteria
- [ ] All Milestone 0-6 items complete
- [ ] Zero known critical bugs
- [ ] Test coverage >80% on core domain
- [ ] All plugin interfaces frozen (breaking changes = major version bump)
- [ ] Documentation complete and reviewed
- [ ] Migration guide from OpenClaw tested end-to-end
- [ ] `rivetos doctor` passes on clean install (macOS, Ubuntu, Debian)
- [ ] 30 days running in production (Phil's daily driver) without intervention
- [ ] CHANGELOG.md complete from v0.1.0 → v1.0.0
- [ ] LICENSE, CODE_OF_CONDUCT, CONTRIBUTING reviewed and finalized

### 7.1 — LTS Branch
- Create `lts/1.0` branch
- Security patches and bug fixes only for 12 months
- No new features, no breaking changes, no dependency upgrades (except security)
- Backport process documented in CONTRIBUTING.md

### 7.2 — Public Launch
- [ ] GitHub repo public
- [ ] rivetos.dev live with docs
- [ ] npm packages published (`@rivetos/types`, `@rivetos/core`, plugins)
- [ ] README with quick-start, architecture diagram, feature comparison
- [ ] Blog post / announcement
- [ ] Example configs: single-agent simple, multi-agent collective, local-only (Ollama)

---

## Skill Classification

### Coreutils (ship with RivetOS)
These are the `ls`, `cat`, `grep` of an agent OS. Every install gets them.

| Tool | Plugin Package | Status |
|------|---------------|--------|
| `shell` | `@rivetos/tool-shell` | Exists, needs upgrade |
| `file_read` | `@rivetos/tool-file` | Build new |
| `file_write` | `@rivetos/tool-file` | Build new |
| `file_edit` | `@rivetos/tool-file` | Build new |
| `search_glob` | `@rivetos/tool-search` | Build new |
| `search_grep` | `@rivetos/tool-search` | Build new |
| `web_search` | `@rivetos/tool-web` | Exists, needs upgrade |
| `web_fetch` | `@rivetos/tool-web` | Exists, needs upgrade |
| `ask_user` | `@rivetos/tool-interaction` | Build new |
| `todo` | `@rivetos/tool-interaction` | ✅ Done |
| `memory_search` | `@rivetos/tool-memory` | Build new |

### Skills (optional, user-installed)
These are `apt install` packages. Available in a skills registry, installed per-instance.

| Skill | Current Status |
|-------|---------------|
| `1password` | In ~/.rivetos/skills/ |
| `discord` | In ~/.rivetos/skills/ |
| `excalidraw` | In ~/.rivetos/skills/ |
| `gh-issues` | In ~/.rivetos/skills/ |
| `github` | In ~/.rivetos/skills/ |
| `gog` (Google Workspace) | In ~/.rivetos/skills/ |
| `healthcheck` | In ~/.rivetos/skills/ |
| `nemotron` | In ~/.rivetos/skills/ |
| `skill-creator` | In ~/.rivetos/skills/ |
| `stealth-browser` | In ~/.rivetos/skills/ |
| `tmux` | In ~/.rivetos/skills/ |
| `weather` | In ~/.rivetos/skills/ |
| `websearch` | In ~/.rivetos/skills/ (merge into coreutils web_search) |
| `coding-pipeline` | Exists as plugin tool (keep as advanced skill) |
| `subagent` | Built into core (not a skill) |

---

## Version Timeline (Estimated)

| Version | Milestone | Status |
|---------|-----------|--------|
| v0.0.x | M0: Foundation (tests, bugs, CI, CLI) | ✅ Done |
| v0.0.x | M1: Coreutils (11 base tools) | ✅ Done |
| v0.0.x | M2: Hooks & Lifecycle | ✅ Done |
| v0.0.x | M3: Multi-Agent Communication | ✅ Done |
| v0.4.0 | M4: Memory & Context | Next |
| v0.5.0 | M5: Developer Experience (SDK, docs, CLI) | Q3 2026 |
| v0.6.0 | M6: Production Hardening (+ IaC, containers, auto-mesh) | Q4 2026 |
| v1.0.0 | M7: LTS Release + Public Launch | Q1 2027 |

---

## Guiding Principles

1. **Tiny core, fat plugins.** The kernel stays under 5,000 lines. Everything else is a plugin or skill.
2. **Test before feature.** No new milestone starts until the previous milestone's tests are green.
3. **Steal shamelessly, credit generously.** Claude Code, OpenClaw, and the broader ecosystem have solved problems we don't need to re-solve. Take the patterns, adapt for our architecture.
4. **Multi-model is the differentiator.** Every design decision should work across Anthropic, xAI, Google, Ollama, and OpenAI-compatible providers. No single-model assumptions.
5. **Phil uses it daily.** If it breaks Phil's workflow, it's a P0 bug regardless of milestone.
6. **Boring technology.** TypeScript, Node.js, PostgreSQL, systemd. No experiments in the foundation.
7. **Ship the README.** If a plugin doesn't have a README that a stranger can follow, it's not done.

---

## Loose Ends — Tie Up If Not Addressed Along the Way

Items that don't fit cleanly into a milestone but shouldn't be forgotten. If they get resolved as part of another milestone, check them off here and note where.

- [ ] **Voice plugin / xAI Realtime API:** Existing voice plugin is incomplete. Needs finish-out for TTS/STT streaming via xAI or ElevenLabs.
- [ ] **Cron scheduler:** Distinct from the heartbeat system. Precise time-based task scheduling (exact times, recurring schedules) with isolated execution context. AGENTS.md references "heartbeat vs cron" but no cron implementation exists.
- [ ] **OAuth token auto-refresh:** Google Workspace tokens expire and currently require manual re-auth. Needs automatic refresh-token flow.
- [ ] **Delegation `fromAgent` context bug:** Delegated agents don't receive context about who delegated to them and why. Partially addressed by 3.4 but the existing bug should be fixed independently.
- [ ] **Plugin hot-reload:** Currently all plugin changes require a full restart. Would benefit from watch-mode reload during development.
- [ ] **WhatsApp channel plugin:** Formatting notes exist in AGENTS.md but no WhatsApp channel implementation exists yet.
- [ ] **Additional providers (DeepSeek, etc.):** As new model providers emerge, add OpenAI-compatible shims or native integrations.


