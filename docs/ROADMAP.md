# RivetOS Roadmap — Path to v1.0

**Version:** v0.4.0 (first public beta) → v1.0.0 (first LTS)  
**Last updated:** April 2026  
**Philosophy:** The lightweight Linux of agent runtimes. Small clean stable core, everything else is a plugin or skill.

---

## What's Done

Milestones 0–5 are complete. The core platform is built, tested, and running in production daily across three agents (Opus, Grok, Local) on a multi-node Proxmox homelab.

| Milestone | Version | Summary |
|-----------|---------|---------|
| M0: Foundation | v0.0.x | Test coverage, CI pipeline, config validation, CLI tools |
| M1: Coreutils | v0.0.x | 13 base tools — file, search, shell, web, memory, interaction |
| M2: Hooks & Lifecycle | v0.2.0 | Hook pipeline, safety hooks, auto-actions, session hooks, fallback chains, MCP client |
| M3: Multi-Agent Comms | v0.3.0 | Intra-instance delegation, cross-instance HTTP messaging |
| M4: Learning & Self-Improvement | v0.4.0 | Background review loop, skill management, directed context loading |
| M5: Agent Orchestration | v0.5.0 | Tool filtering, agent-driven routing, shared filesystem, model switching |

**Current state:** 13 coreutil tools, 5 provider plugins, 4 channel plugins, 7 tool plugin packages, hook pipeline with safety/auto-action/session hooks, learning loop, skill system, delegation + sub-agents, cross-instance messaging, MCP client, shared `/shared/` NFS filesystem across all agents.

---

## What's Left — Three Milestones to v1.0

The remaining work is organized around one insight: **the container is the product.** Security, setup, updates, and multi-agent deployment all simplify dramatically when the deployment unit is a container image built from the monorepo.

### Milestone 6: Containerized Distribution ✅
**Target: v0.6.0**  
**Theme:** The install experience IS the product.  
**Status:** Complete. All 6 sub-milestones shipped. A few deferred items remain (multi-arch builds, Nx caching, K8s provider, mesh updates) — none block launch.

The golden container is the deployment unit. `rivetos init` walks you through setup interactively. The Nx monorepo builds the images. Pulumi (or Docker Compose) manages the infrastructure. Updates rebuild from source.

#### 6.1 — Container Images (Nx Build Targets) ✅

Build OCI-compliant container images as Nx build artifacts.

- [x] **Agent Dockerfile** (`infra/containers/agent/Dockerfile`) — Node.js, RivetOS runtime, tini init, non-root user, healthcheck
- [x] **Datahub Dockerfile** (`infra/containers/datahub/Dockerfile`) — PostgreSQL 16 + pgvector, `/shared/` directory structure, init scripts, health checks
- [x] **Nx build targets** — `project.json` for both containers with proper dependency graph and SHA tagging
- [x] **Image tagging** — commit SHA on build, semver on release, `latest` on main
- [x] **Data persistence** — workspace bind mount, named volumes for pgdata + shared, `DATA-PERSISTENCE.md` documented
- [x] **Docker Compose** — full `docker-compose.yaml` with datahub, agent template, multi-agent profiles, proper networking
- [ ] **Nx caching** — unchanged images don't rebuild
- [ ] **Multi-arch builds** — amd64 + arm64 (Proxmox hosts and Mac dev machines)

#### 6.2 — Container Registry & CI ✅

Automated image publishing via GitHub Actions.

- [x] **CI pipeline** (`.github/workflows/ci.yml`) — PR: lint+test, merge: build+push images, release: push with semver + `latest`
- [x] **Local build option** — `rivetos build` CLI command for building from source
- [x] **`.env.example`** — template for secrets
- [ ] **GitHub Container Registry (GHCR)** — push images on merge to main (pipeline defined, needs repo secrets configured)
- [ ] **Image signing** — cosign or similar for supply chain security (nice-to-have)

#### 6.3 — Interactive Setup Wizard (`rivetos init`) ✅

The CLI walks the user through everything. Detect environment, ask questions, configure, deploy.

- [x] **Environment detection** — Docker installed? Proxmox API reachable? kubectl? OS/arch/memory/disk
- [x] **Deployment target selection** — Docker (recommended), Proxmox, Kubernetes (future), Manual
- [x] **Agent configuration** — provider selection, API key entry + validation, model selection, agent naming, thinking level
- [x] **Multi-agent support** — "Would you like to add another agent?" loop
- [x] **Channel configuration** — Discord (with bot creation walkthrough), Slack, WhatsApp, Terminal, API-only
- [x] **Review & deploy** — summary of choices, confirm, then execute
- [x] **Config generation** — writes `rivet.config.yaml` + `.env` from wizard state
- [x] **Resumable** — partial config detected → "Continue where you left off?"
- [x] **Post-setup** — shows next steps, useful commands, how to modify later
- [x] **CLI library** — @clack/prompts for terminal UI
- [x] **`rivetos agent add/remove/list`** — agent management commands
- [x] **`rivetos config`** — reopens wizard with current values pre-filled

#### 6.4 — User-Facing Configuration (`rivet.config.yaml`) ✅

One simple config file that drives everything. No Pulumi knowledge needed.

```yaml
# rivet.config.yaml
deployment: docker              # or "proxmox" or "kubernetes"

datahub:
  postgres: true
  shared_storage: /shared

agents:
  - name: opus
    provider: anthropic
    model: claude-sonnet-4-20250514
    channels: [discord]
  - name: grok
    provider: xai
    model: grok-3
    channels: [discord]

# Provider-specific overrides (optional)
proxmox:
  nodes:
    - name: pve1
      ip: 192.168.1.1
      role: datahub
    - name: pve2
      ip: 192.168.1.2
      role: agents
  network:
    bridge: vmbr1
    subnet: 192.168.1.0/24
```

- [x] **Config schema** — full TypeScript types (`DeploymentConfig`, `DatahubConfig`, `DockerConfig`, `ProxmoxConfig`, `KubernetesConfig`) in `@rivetos/types`
- [x] **Config validation** — thorough validator in `@rivetos/boot` with helpful error messages
- [x] **Secrets handling** — API keys stored in `.env` file, not in config YAML
- [x] **Config modification** — `rivetos config` reopens wizard with current values pre-filled
- [x] **Agent management** — `rivetos agent add` / `rivetos agent remove` jump to agent config phase

#### 6.5 — Infrastructure as Code (Pulumi) ✅

Abstract infrastructure layer — same components, multiple providers.

```
infra/
├── components/           # Abstract resource definitions
│   ├── agent.ts          # RivetAgent component
│   ├── datahub.ts        # RivetDatahub component
│   └── network.ts        # RivetNetwork component
├── providers/            # Implementation per deployment target
│   ├── proxmox/          # LXC containers on Proxmox
│   ├── docker/           # Docker Desktop / Compose
│   └── kubernetes/       # K8s deployments (future)
├── stacks/               # Per-environment configs
│   ├── Pulumi.homelab.yaml
│   └── Pulumi.docker.yaml
├── index.ts              # Reads rivet.config.yaml, picks provider, builds stack
└── Pulumi.yaml
```

- [x] **Abstract components** — `RivetAgent`, `RivetDatahub`, `RivetNetwork` interfaces that providers implement
- [x] **Docker provider** — Docker Compose under the hood
- [x] **Proxmox provider** — LXC containers, networking, bind mounts, NFS
- [x] **Orchestrator** — reads `rivet.config.yaml`, picks provider, builds stack
- [x] **`rivetos infra up`** — creates/updates infrastructure from config
- [x] **`rivetos infra preview`** — dry run, shows what would change
- [x] **`rivetos infra destroy`** — tear down (with confirmation)
- [ ] **Idempotent reconciliation** — full diff-based reconciliation (currently recreates)
- [ ] **Kubernetes provider** — future, post-launch

#### 6.6 — Update Flow ✅

`rivetos update` pulls source and rebuilds containers — forks and plugins just work.

- [x] **Pull latest source** — `git pull` (or `--branch`, `--tag` for specific versions). Forks pull from their own remote.
- [x] **Rebuild containers from source** — builds images from whatever source tree is present, including user plugins/customizations
- [x] **Restart containers** — graceful shutdown, swap to rebuilt image, start
- [x] **Post-update hooks** — run migrations, sync skills, verify health
- [x] **Plugin preservation** — user plugins live in the source tree, survive updates, get baked into rebuild automatically
- [x] **Data persistence verification** — `verifyDataPersistence()` safety check before any rebuild
- [x] **Version pinning** — `rivetos update --version 0.8.2` checks out a specific tag before rebuilding
- [x] **Pre-built images (optional)** — `rivetos update --prebuilt` pulls from GHCR instead of building
- [x] **`--no-restart`** — build only, don't restart
- [x] **Bare-metal fallback** — systemd restart path for non-container deployments
- [ ] **`rivetos update --mesh`** — rolling update across all agents (depends on M7.5 mesh)
- [ ] **Migration runner** — automatic workspace migration between versions

---

### Build Order — M7 & M8

Batches are organized to maximize context efficiency — related work is grouped so we're not loading and reloading the same files.

| Batch | Milestone Items | Context Loaded |
|-------|----------------|----------------|
| **Batch 5** ✅ | 7.1 Error Handling + 7.2 Observability | core/domain, core/runtime, logger, CLI |
| **Batch 6** ✅ | 7.3 Diagnostics + 7.4 Security | CLI doctor, .env handling, audit log |
| **Batch 7** ✅ | 7.5 Multi-Agent Mesh | core/domain/delegation, channel-agent |
| **Batch 8** | 8.1 Core Docs + 8.2 Developer Experience | docs/, CLI scaffolding commands |
| **Batch 9** | 8.3 Public Launch + 8.4 Release Criteria | Everything — final polish and ship |

---

### Milestone 7: Reliability & Polish ✅
**Target: v0.9.0**  
**Theme:** Make it solid inside the container.  
**Status:** Complete. All 5 sub-milestones shipped.

#### 7.1 — Error Handling & Recovery ✅

- [x] **Structured error types** — typed error classes with codes, severity, retryable flags. Full hierarchy: RivetError → ChannelError, MemoryError, ConfigError, ToolError, DelegationError, RuntimeError.
- [x] **Channel reconnection** — ReconnectionManager with exponential backoff, jitter, configurable retries
- [x] **Memory backend resilience** — connection pooling, health checks, graceful degradation if DB is temporarily down
- [ ] **Crash recovery** — resume active sessions from transcript on restart (deferred — not blocking launch)
- [x] **Provider circuit breaker** — closed/open/half-open states, windowed failure tracking, auto-recovery

#### 7.2 — Observability ✅

- [x] **Structured logging** — JSON mode for production, pretty-print for dev. Log levels respected consistently. Component-scoped loggers.
- [x] **`rivetos logs`** — tail agent logs from the CLI. Docker (`docker compose logs`), systemd (`journalctl`), bare-metal fallback. Filter by agent, level, pattern, time range.
- [x] **Runtime metrics** — turns, tool calls, token usage per agent, latency percentiles (avg/p95/max), error tracking by code
- [x] **Health endpoint** — `GET /health` (full status), `GET /health/live` (liveness), `GET /metrics` (raw metrics)
- [x] **`rivetos status`** — rich display from health endpoint with agents, providers, channels, memory, metrics. Fallback to PID check.
- [ ] **OpenTelemetry** — optional trace export plugin (deferred to post-launch)

#### 7.3 — Diagnostics ✅

- [x] **`rivetos doctor`** — enhanced: system (Node/memory/disk), config (schema validation), workspace files, env vars, secrets (.env permissions, no secrets in config), OAuth, containers (Docker health), memory backend (pg connectivity), shared storage (writable), DNS resolution, provider connectivity, peer reachability. `--json` flag for CI.
- [x] **Self-test suite** — `rivetos test` smoke test: config validation, provider minimal prompt, memory SELECT 1, tool registry, health endpoint, shared storage read/write. `--quick` (skip provider), `--verbose`, `--json`.
- [ ] **Troubleshooting guide** — common issues and fixes (moves to M8 docs)

#### 7.4 — Security Essentials ✅

The container IS the security boundary. Agents have full capability inside their container. This milestone covers the essentials that don't limit agent capability.

- [x] **Secret management** — redactSecrets() for safe logging, ensureEnvPermissions() (0600), validateNoSecretsInConfig(), 1Password CLI integration (op:// references), RIVETOS_ env var prefix convention
- [x] **Audit log** — enhanced from M2.2: daily rotation (already existed), configurable retention (default 90 days), gzip compression after 7 days, size warnings, rotateAuditLogs() callable from startup/heartbeat

#### 7.5 — Multi-Agent Mesh ✅

Build on M5's cross-instance messaging to create a self-organizing agent network.

- [x] **Mesh types** — `MeshNode`, `MeshRegistry`, `MeshConfig`, `MeshDelegationRoute` in `@rivetos/types`
- [x] **Mesh registry** — `FileMeshRegistry` in `@rivetos/core`. File-based (`mesh.json`), auto-heartbeat, stale node pruning, seed-based sync. Full test suite (9 tests).
- [x] **`rivetos init --join <host>`** — wizard accepts `--join` flag, pings seed node, guides user through mesh config
- [x] **Auto-discovery** — seed-node based peer discovery. Joining node contacts seed's `/api/mesh/join`, receives full registry. mDNS interface defined for future.
- [x] **`rivetos mesh list`** — show all known nodes with status, agents, providers, models, last seen
- [x] **`rivetos mesh ping`** — health check all peers with latency, timeout detection, summary
- [x] **`rivetos mesh status`** — show local node mesh overview (online/offline/degraded counts)
- [x] **Mesh-aware delegation** — `MeshDelegationEngine` wraps local `DelegationEngine`, checks mesh registry for remote agents, routes via HTTP. Creates mesh-aware `delegate_task` tool.
- [x] **Mesh updates** — `rivetos update --mesh` with rolling deploys: update local first, then each remote peer sequentially with health check between each.
- [x] **Agent channel mesh endpoints** — `/api/mesh` (GET nodes), `/api/mesh/join` (POST register), `/api/mesh/ping` (GET liveness)

---

### Milestone 8: Documentation & Launch ✅
**Target: v1.0.0**  
**Theme:** Written once, against the finished product.  
**Status:** Complete. All documentation written against the finished product. CLI tooling for plugins and skills shipped.

#### 8.1 — Core Documentation ✅

- [x] **`docs/GETTING-STARTED.md`** — zero to running in 5 minutes. Docker, bare-metal, and interactive wizard paths.
- [x] **`docs/ARCHITECTURE.md`** — system overview, plugin model, hook pipeline, memory system, mesh, observability, infra layers
- [x] **`docs/CONFIG-REFERENCE.md`** — every config option documented with defaults, types, and examples
- [x] **`docs/PLUGINS.md`** — how to write each plugin type (channel, provider, tool, memory) with complete examples
- [x] **`docs/SKILLS.md`** — how to write, test, and distribute skills
- [x] **`docs/DEPLOYMENT.md`** — Docker, Proxmox, multi-agent mesh, networking, backup/restore
- [x] **`docs/TROUBLESHOOTING.md`** — common issues, `rivetos doctor` output explained, FAQ
- [ ] **API reference** — auto-generated from TypeScript interfaces (deferred — docs cover interfaces thoroughly)

#### 8.2 — Developer Experience ✅

- [x] **`rivetos plugin init`** — scaffolds a new plugin (wraps `@rivetos/nx:plugin`)
- [x] **`rivetos skill init`** — scaffolds a new skill with SKILL.md template and frontmatter
- [x] **`rivetos skill validate`** — checks frontmatter, triggers, file references, size limits. `--json` flag.
- [x] **Example configs** — `examples/single-agent.yaml`, `multi-agent.yaml`, `local-only.yaml`, `homelab.yaml`

#### 8.3 — Public Launch (Partial)

- [x] **README** — complete rewrite with correct workspace refs, architecture diagram, container deployment, full CLI reference
- [x] **LICENSE, CONTRIBUTING** — reviewed and updated for v1.0 (container workflow, plugin discovery, skills)
- [x] **CHANGELOG.md** — complete through v1.0
- [ ] **GitHub repo public** — clean history, no secrets, proper .gitignore
- [ ] **npm packages** — `@rivetos/types`, `@rivetos/core` published to npm
- [ ] **Container images** — `ghcr.io/philbert440/rivetos-agent`, `ghcr.io/philbert440/rivetos-datahub` published
- [ ] **rivetos.dev** — documentation site (VitePress or similar)
- [ ] **Blog post / announcement** — what it is, why it exists, how to get started

#### 8.4 — Release Criteria

- [x] All M6–M7 items complete
- [x] Test coverage >80% on core domain
- [x] Plugin interfaces frozen (breaking changes = major version bump)
- [x] CHANGELOG.md complete
- [ ] Zero known critical bugs (pending end-to-end testing)
- [ ] `rivetos init` works end-to-end on Docker Desktop (macOS, Linux, Windows WSL)
- [ ] `rivetos init` works end-to-end on Proxmox
- [ ] 30 days running in production without intervention

---

## Monorepo Structure (Target)

```
/opt/rivetos/
├── apps/
│   └── datahub/              # Datahub service (DB + shared storage)
├── packages/
│   ├── boot/                 # Bootstrap + wiring (existing)
│   ├── cli/                  # CLI commands (existing, expanded)
│   ├── core/                 # Runtime kernel (existing)
│   ├── nx-plugin/            # Nx generators/executors (existing)
│   └── types/                # Shared type system (existing)
├── plugins/                  # All plugins (existing)
│   ├── channels/             # discord, telegram, agent, voice
│   ├── memory/               # postgres
│   ├── providers/            # anthropic, xai, google, ollama, openai-compat
│   └── tools/                # file, search, shell, web, interaction, mcp, coding-pipeline
├── infra/containers/
│   ├── agent/
│   │   └── Dockerfile        # Agent container image
│   └── datahub/
│       └── Dockerfile        # Postgres + NFS + shared dirs
├── infra/
│   ├── components/           # Abstract: RivetAgent, RivetDatahub, RivetNetwork
│   ├── providers/            # proxmox/, docker/, kubernetes/
│   ├── stacks/               # Per-environment Pulumi configs
│   └── Pulumi.yaml
├── skills/                   # Bundled + user skills (existing)
├── docs/                     # Documentation (existing, expanded)
├── config.example.yaml       # Example config (existing)
├── nx.json                   # Nx workspace config (existing)
└── package.json              # Root package (existing)
```

---

## Skill Classification

### Coreutils (ship with every install)

| Tool | Plugin Package | Status |
|------|---------------|--------|
| `shell` | `@rivetos/tool-shell` | ✅ |
| `file_read` | `@rivetos/tool-file` | ✅ |
| `file_write` | `@rivetos/tool-file` | ✅ |
| `file_edit` | `@rivetos/tool-file` | ✅ |
| `search_glob` | `@rivetos/tool-search` | ✅ |
| `search_grep` | `@rivetos/tool-search` | ✅ |
| `internet_search` | `@rivetos/tool-web` | ✅ |
| `web_fetch` | `@rivetos/tool-web` | ✅ |
| `ask_user` | `@rivetos/tool-interaction` | ✅ |
| `todo` | `@rivetos/tool-interaction` | ✅ |
| `memory_search` | `@rivetos/tool-memory` | ✅ |
| `memory_browse` | `@rivetos/tool-memory` | ✅ |
| `memory_stats` | `@rivetos/tool-memory` | ✅ |

### Skills (optional, user-installed)

| Skill | Status |
|-------|--------|
| `1password` | Available |
| `discord` | Available |
| `excalidraw` | Available |
| `gh-issues` | Available |
| `github` | Available |
| `gog` (Google Workspace) | Available |
| `healthcheck` | Available |
| `nemotron` | Available |
| `skill-creator` | Available |
| `stealth-browser` | Available |
| `tmux` | Available |
| `weather` | Available |
| `coding-pipeline` | Available (advanced) |

---

## Version Timeline

| Version | Milestone | Target |
|---------|-----------|--------|
| v0.5.0 | M0–M5: Core Platform | ✅ Complete |
| v0.8.0 | M6: Containerized Distribution | ✅ Complete |
| v0.9.0 | M7: Reliability & Polish | ✅ Complete |
| v1.0.0 | M8: Documentation & Launch | ✅ Complete (pending end-to-end testing) |

---

## Guiding Principles

1. **The container is the product.** Security via isolation. Setup via wizard. Updates via image pull. No bare-metal assumptions.
2. **Tiny core, fat plugins.** The kernel stays under 5,000 lines. Everything else is a plugin or skill.
3. **Test before feature.** No new milestone starts until the previous milestone's tests are green.
4. **Multi-model is the differentiator.** Every design decision works across Anthropic, xAI, Google, Ollama, and OpenAI-compatible providers.
5. **Phil uses it daily.** If it breaks Phil's workflow, it's a P0 bug regardless of milestone.
6. **Boring technology.** TypeScript, Node.js, PostgreSQL, systemd, Docker, Pulumi. No experiments in the foundation.
7. **Ship the README.** If a component doesn't have docs a stranger can follow, it's not done.
8. **Learn from doing.** The system should get smarter with use, not just with code changes.
9. **Write docs last.** Document the finished product, not the moving target.
10. **One config to rule them all.** `rivet.config.yaml` is the single source of truth for what a deployment looks like.

---

## Loose Ends — Address If Time Permits

Items that don't block launch but would be nice to have.

- [ ] **Voice plugin / xAI Realtime API** — TTS/STT streaming
- [ ] **Cron scheduler** — precise time-based task scheduling distinct from heartbeats
- [ ] **OAuth token auto-refresh** — Google Workspace tokens expire, need automatic refresh
- [ ] **Plugin hot-reload** — watch-mode reload during development
- [ ] **WhatsApp channel plugin** — Evolution API integration
- [ ] **Additional providers** — DeepSeek, etc.
- [ ] **`rivetos benchmark`** — latency test against configured providers
- [ ] **OpenTelemetry** — full distributed tracing (structured logging ships in M7)

---

## Legacy Reference

The original M0–M5 roadmap with full implementation details is preserved in git history. Run `git log --all --oneline -- docs/ROADMAP.md` to find previous versions.
