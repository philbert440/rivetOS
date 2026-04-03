# RivetOS Roadmap

**Version:** v0.1.0 → v1.0.0 LTS  
**Last updated:** April 2026  
**Philosophy:** The lightweight Linux of agent runtimes. Tiny core, stable kernel, everything else is a plugin or skill.

---

## Milestone 0: Foundation — Make It Reliable
**Target: v0.2.0**  
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

## Milestone 1: Coreutils — The Base Toolset
**Target: v0.3.0**  
**Theme:** Every agent needs these. They ship with every RivetOS install.

Modeled after the Claude Code core tool patterns — battle-tested primitives adapted for multi-model, multi-agent use. These replace the current "everything goes through shell" approach with purpose-built tools that have safety rails, structured output, and audit trails.

### 1.1 — File Read (`file_read`)
**Plugin:** `plugins/tools/file/`

- Read files with line numbers, range selection (`start_line`, `end_line`)
- Support text files, JSON, YAML, TOML, markdown
- Image files → base64 for vision-capable models, description for others
- PDF → text extraction (pdftotext or similar)
- Jupyter notebooks → cell-by-cell rendering
- Max file size guard (configurable, default 1MB)
- Returns line-numbered output for precise referencing

### 1.2 — File Write (`file_write`)
**Plugin:** `plugins/tools/file/`

- Write or overwrite a file with full content
- Create parent directories automatically
- **Safety:** Require `file_read` of the target before overwrite (prevent blind overwrites)
- File permissions preserved on overwrite
- Returns confirmation with byte count and path

### 1.3 — File Edit (`file_edit`)
**Plugin:** `plugins/tools/file/`

- Surgical edits: provide `old_string` (exact match) and `new_string` (replacement)
- Must match exactly one location in the file (fail if ambiguous)
- **Safety:** Require `file_read` first (enforced — tool checks read history for this turn)
- Support creating new files (empty `old_string` = insert at location)
- Returns diff-style confirmation of what changed

### 1.4 — Search: Glob (`search_glob`)
**Plugin:** `plugins/tools/search/`

- Find files by glob pattern (`**/*.ts`, `src/**/test*`)
- Returns paths sorted by most-recently-modified (MRU)
- Respects `.gitignore` by default (configurable)
- Configurable max results (default 100)
- Returns file paths with size and last-modified timestamp

### 1.5 — Search: Grep (`search_grep`)
**Plugin:** `plugins/tools/search/`

- Search file contents by regex or literal pattern
- Context lines (configurable, default 2 before/after)
- Respect `.gitignore` by default
- Case-sensitive/insensitive flag
- Max results cap (default 50 matches)
- Returns: file path, line number, matched line with context

### 1.6 — Web Search (`web_search`) — Upgrade Existing
**Plugin:** `plugins/tools/web-search/` (existing, upgraded)

- **Multi-provider:** Google CSE (existing) + DuckDuckGo fallback + xAI native (when available)
- Automatic failover: if primary returns 403/quota error, try next provider
- Source citation enforcement in output
- Rate limiting / retry with backoff
- Result caching (same query within 5min = cached response)

### 1.7 — Web Fetch (`web_fetch`) — Upgrade Existing
**Plugin:** `plugins/tools/web-search/` (existing, upgraded)

- **Readability extraction:** Use Mozilla Readability or similar instead of regex tag stripping
- Content caching (URL + max_age → skip re-fetch)
- PDF URL → text extraction
- GitHub raw content detection (render markdown properly)
- Configurable user agent
- Response truncation with "use max_chars to see more" hint

### 1.8 — Shell (`shell`) — Upgrade Existing
**Plugin:** `plugins/tools/shell/` (existing, upgraded)

- **Command categorization:** read-only (ls, cat, git status) vs write (rm, mv, apt) vs dangerous (rm -rf)
- Configurable approval requirements per category (none / warn / block)
- **Background mode:** Long-running commands return immediately with a handle, poll for completion
- Git-aware safety: warn before force push, warn on dirty working tree
- **Sandbox option:** Run in restricted shell or container for untrusted commands
- Session environment persistence (cd in one call persists to next)

### 1.9 — Ask User (`ask_user`)
**Plugin:** `plugins/tools/interaction/`

- Structured question tool: the model explicitly asks the user something
- Supports question types: free text, yes/no, multiple choice
- Prevents the model from guessing when it should ask
- Returns the user's response as a string
- Useful for confirmation gates, ambiguous instructions, preference collection

### 1.10 — Task List (`todo`) ✅
**Plugin:** `plugins/tools/interaction/`

- Read/write a structured task list persisted to a file
- Operations: add, update (status/content), delete, list
- Status: pending, in_progress, done
- Scoped per session or persistent across sessions (configurable)
- Gives models a working scratchpad for multi-step plans
- Returns formatted task list with status indicators

### 1.11 — Memory Search (`memory_search`)
**Plugin:** `plugins/tools/memory/`

- Expose the Memory plugin's search capabilities as a tool
- Full-text search, vector similarity, or hybrid
- Filter by agent, time range, conversation
- Returns scored results with timestamps and context
- Lets the model explicitly search its own memory rather than relying on automatic context injection

---

## Milestone 2: Hooks & Lifecycle Events
**Target: v0.4.0**  
**Theme:** Extensibility without touching core.

### 2.1 — Hook System Architecture
- Define lifecycle events: `SessionStart`, `PreToolUse`, `PostToolUse`, `PreResponse`, `PostResponse`, `SessionEnd`, `PreCompact`, `PostCompact`
- Hook handler types: `shell` (run a command), `http` (webhook), `internal` (TypeScript function)
- Hooks defined in config.yaml under `hooks:` section
- Multiple hooks per event, executed in order
- Hook failure modes: `continue` (log and proceed), `abort` (stop the turn), `retry`

### 2.2 — Safety Hooks (PreToolUse)
- Block dangerous shell commands before execution
- Require confirmation for file writes outside workspace
- Log all tool invocations to audit file
- Custom rules: "never run npm publish without --dry-run first"

### 2.3 — Auto-Actions (PostToolUse)
- Auto-format files after edit (prettier, eslint --fix)
- Auto-lint after code changes
- Auto-run tests after file modifications in src/
- Custom: "after any git commit, run the pre-push checks"

### 2.4 — Session Hooks
- `SessionStart`: load additional context, check calendar, greet user
- `SessionEnd`: auto-commit pending changes, write session summary, update daily notes
- `PreCompact`: save important context before compaction
- `PostCompact`: verify critical context survived compaction

---

## Milestone 3: Agent Capabilities
**Target: v0.5.0**  
**Theme:** Smarter agents, not just more tools.

### 3.1 — Plan Mode
- Read-only exploration mode: only read tools enabled (file_read, search_glob, search_grep, web_search, web_fetch, memory_search)
- Write tools (file_write, file_edit, shell with side effects) blocked with helpful message
- Agent produces structured plan: steps, files to modify, tests to run, risks
- User approves → mode switches to execute
- `/plan` command to enter, `/execute` to approve and switch

### 3.2 — Git Worktree Isolation for Subagents
- When `subagent_spawn` is used for code tasks, auto-create a git worktree
- Subagent operates in isolated copy of repo
- On completion: merge back to main worktree or create PR branch
- Enables true parallel code changes without conflict
- Cleanup: auto-remove worktree after merge

### 3.3 — Batch Mode
- Decompose large tasks into independent units (like Claude Code's /batch)
- Spawn N subagents, each in its own worktree
- Each implements its unit, runs tests, reports results
- Coordinator agent merges results and resolves conflicts
- Progress tracking: show status of all units

### 3.4 — Delegation Improvements
- `fromAgent` context: delegated agent knows who asked and why
- Delegation chains: A delegates to B, B can delegate to C (with depth limit)
- Result caching: same delegation request within a session returns cached result
- Timeout handling: graceful timeout with partial result return

---

## Milestone 4: Memory & Context
**Target: v0.6.0**  
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
**Target: v0.7.0**  
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
**Target: v0.8.0 → v0.9.0**  
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

| Version | Milestone | Target |
|---------|-----------|--------|
| v0.2.0 | Foundation (tests, bugs, CI) | Q2 2026 |
| v0.3.0 | Coreutils (11 base tools) | Q2 2026 |
| v0.4.0 | Hooks & Lifecycle | Q3 2026 |
| v0.5.0 | Agent Capabilities (plan, batch, worktrees) | Q3 2026 |
| v0.6.0 | Memory & Context | Q3 2026 |
| v0.7.0 | Developer Experience (SDK, docs, CLI) | Q4 2026 |
| v0.8-0.9 | Production Hardening (+ IaC, containers, auto-mesh) | Q4 2026 |
| v1.0.0 | LTS Release + Public Launch | Q1 2027 |

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


