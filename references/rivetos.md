# RivetOS — Project Reference

> Quick-load briefing for context. Load with `/context add references/rivetos.md`.
> Last updated: 2026-04-06

---

## What It Is

Lightweight AI agent runtime. Connects LLM providers (Anthropic, xAI, Google, Ollama, llama-server) to messaging channels (Discord, Telegram, voice) with a tool execution loop, persistent memory, and multi-agent orchestration.

- **Repo:** `github.com/philbert440/rivetOS` → `/opt/rivetos`
- **Version:** v0.4.0 (all milestones M0–M8 complete, pending end-to-end testing for v1.0)
- **Stack:** Node.js 24+, TypeScript 5.8, ES2023, Nx monorepo, npm workspaces
- **Scale:** ~49k lines source, ~8.5k lines tests, 5 core packages, 15+ plugins

---

## Architecture Overview

```
┌─────────────────────────────────────────────────┐
│  Channel (Discord/Telegram/Agent/Voice)          │
│    ↓ message                                     │
│  Runtime → Router → TurnHandler                  │
│    ↓                                             │
│  AgentLoop (stream → tool → stream loop)         │
│    ├── Provider.chatStream() → streaming chunks  │
│    ├── Tool.execute() → results fed back         │
│    └── Hook pipeline at every lifecycle point    │
│    ↓                                             │
│  StreamManager → channel.edit() (throttled)      │
│    ↓                                             │
│  Memory.append() (Postgres + pgvector)           │
└─────────────────────────────────────────────────┘
```

### Core Packages

| Package | Lines | Purpose |
|---------|-------|---------|
| `@rivetos/types` | 2,078 | Interfaces only. Leaf dependency. Zero runtime deps. |
| `@rivetos/core` | 8,534 | Runtime engine — domain logic (loop, router, hooks, delegation, mesh, skills) + application layer (turn handler, streaming, sessions, health) |
| `@rivetos/boot` | 2,364 | Composition root — config loader, validation, registrars that wire everything |
| `@rivetos/cli` | 6,080 | All `rivetos <command>` implementations (20 commands) |
| `@rivetos/nx-plugin` | 724 | Nx generators for scaffolding plugins |

### Plugin Architecture

4 plugin types, all dynamically imported by boot registrars:

| Category | Interface | Plugins |
|----------|-----------|---------|
| Provider | `Provider` | anthropic, xai, google, ollama, llama-server |
| Channel | `Channel` | discord, telegram, agent (HTTP), voice-discord |
| Tool | `Tool` | shell, file, search, web-search, interaction, mcp-client, coding-pipeline |
| Memory | `Memory` | postgres (pgvector, embeddings, compaction, summaries) |

### Hook System

16 lifecycle events, priority-ordered async pipelines. Key hooks:
- `provider:error` → fallback chains
- `tool:before` → safety gates (shell danger detection, workspace fencing)
- `tool:after` → auto-format, auto-lint
- `turn:after` → review loop, delegation tracking
- `session:end` → auto-summary

---

## Key Files

| What | Where |
|------|-------|
| Agent execution loop | `packages/core/src/domain/loop.ts` |
| Turn processing | `packages/core/src/runtime/turn-handler.ts` |
| Message routing | `packages/core/src/domain/router.ts` |
| Delegation engine | `packages/core/src/domain/delegation.ts` |
| Sub-agent manager | `packages/core/src/domain/subagent.ts` |
| Skill system | `packages/core/src/domain/skills/` |
| Hook pipeline | `packages/core/src/domain/hooks.ts` |
| Safety hooks | `packages/core/src/domain/safety-hooks.ts` |
| Config loader | `packages/boot/src/config.ts` |
| Config validation | `packages/boot/src/validate/` |
| Boot orchestrator | `packages/boot/src/index.ts` |
| All registrars | `packages/boot/src/registrars/` |
| CLI entry | `packages/cli/src/index.ts` |
| Init wizard | `packages/cli/src/commands/init/` |
| Memory plugin | `plugins/memory/postgres/` |
| Discord channel | `plugins/channels/discord/` |
| Agent channel (mesh) | `plugins/channels/agent/` |
| Dockerfiles | `infra/containers/agent/`, `infra/containers/datahub/` |
| Docker Compose | `docker-compose.yaml` |
| Pulumi infra | `infra/src/` |

---

## Database Schema (PostgreSQL 16 + pgvector)

All tables use `ros_` prefix.

### ros_messages
Immutable transcript — every message ever sent/received.
- `id` UUID, `conversation_id` UUID, `agent`, `channel`, `role`, `content`
- `tool_name`, `tool_args` JSONB, `tool_result`
- `embedding` halfvec(4000), `content_tsv` tsvector (generated)
- `metadata` JSONB, `created_at`

### ros_conversations
Session grouping.
- `id` UUID, `session_key`, `agent`, `channel`, `channel_id`
- `bot_identity`, `title`, `settings` JSONB, `active` bool

### ros_summaries
Compacted summaries forming a DAG (leaf → branch → root).
- `id` UUID, `conversation_id`, `parent_id` (self-ref), `depth` int
- `content`, `kind` (leaf/branch/root), `message_count`
- `earliest_at`, `latest_at`, `embedding` halfvec(4000)

### ros_summary_sources
Links summaries to source messages. `(summary_id, message_id, ordinal)`

### Memory Tools
| Tool | Purpose |
|------|---------|
| `memory_search` | Unified FTS + semantic + temporal search with auto-expand |
| `memory_browse` | Chronological message browsing |
| `memory_stats` | Embedding queue depth, compaction status, coverage |

### Scoring
```
relevance = (fts_rank × 0.3) + (semantic_sim × 0.3) + (temporal × 0.3) + (importance × 0.1)
temporal = e^(-0.05 × days) × (1 + 0.02 × access_count)
```

---

## Deployment Topology (Phil's Homelab)

```
Proxmox Cluster (192.168.1.0/24, vmbr1)

PVE1 (pve1)          PVE2 (pve2)           PVE3 (pve3/GERTY)
┌──────────────┐     ┌──────────────┐      ┌──────────────┐
│ CT110        │     │ CT101 (Opus) │      │ CT100 (Local)│
│ PostgreSQL   │     │ Anthropic    │      │ Ollama       │
│ datahub      │     │ :3100        │      │ :3102        │
│ :5432        │     ├──────────────┤      │ (BROKEN)     │
│              │     │ CT112 (Grok) │      └──────────────┘
│ HNSW index ✅│     │ xAI          │      
│ 73k+ msgs   │     │ :3101        │      V100 GPUs:
└──────────────┘     └──────────────┘      GPU0: Nemotron 8B
                                           GPU1: Embeddings
NFS: /rivet-shared/ exported from datahub to all agents
```

### Container Images
- **Agent:** Node 24 Alpine, non-root (`rivetos`), tini, runs via tsx
- **Datahub:** PostgreSQL 16 + pgvector, `/rivet-shared/` dirs, init scripts

### Key Ports
| Port | Service |
|------|---------|
| 3100-3102 | Agent HTTP (health, mesh, delegation) |
| 5432 | PostgreSQL |
| 9400 | Nemotron (GERTY) |
| 9401 | Embedding model (GERTY) |

---

## Current Status & Known Issues

### What Works
- Opus (CT101) and Grok (CT112) running, connected to Discord
- Memory plugin writing to CT110, embeddings + summaries flowing
- All M0–M8 milestones complete in code
- 73,242+ messages in ros_messages

### Open Issues (from `memory/2026-04-06-issues.md`)

**P1 — Needs Fixing:**
- CT100 (Local) broken config — old creds, no Discord token, code behind
- tsc build outputs to `src/` instead of `dist/` — .js mixed with .ts
- SSH keys not distributed across CTs
- Learning loop / review hook not actually triggering
- Lint fixes incomplete
- CI on main still broken

**P2 — Unfinished:**
- Docker Compose hardcoded to Phil's GPU for embeddings
- npm packages not published to npmjs.org
- GHCR container images not published
- coco_memory + emkit DB not migrated to CT110
- Node 24 engine requirement too strict (Phil has Node 23)
- HNSW index not in repo provisioning scripts
- CT rebuild migration plan never started

**P4 — New Setup:**
- Set up Gemma 4 for Local Rivet
- Set up Local as delegation target
- Build project reference files (this file is #25)

---

## Config Shape (config.yaml)

```yaml
runtime:
  workspace: ~/.rivetos/workspace
  default_agent: opus
  max_tool_iterations: 100
  skill_dirs: [~/.rivetos/skills]
  heartbeats: [...]
  coding_pipeline: { builder_agent, validator_agent }
  fallbacks: [...]
  safety: { shellDanger, workspaceFence, audit }
  auto_actions: { format, lint, test, gitCheck }

agents:
  opus: { provider: anthropic, default_thinking: medium, tools: { exclude: [...] } }

providers:
  anthropic: { model: claude-sonnet-4-20250514, max_tokens: 16384 }

channels:
  discord: { channel_bindings: { "123": "opus" } }

memory:
  postgres: { connection_string: "${RIVETOS_PG_URL}" }

deployment:
  target: docker
  datahub: { postgres: true }
  image: { build_from_source: true }
```

Secrets live in `.env` (never in config YAML). Config uses snake_case, TypeScript uses camelCase.

---

## CLI Commands

| Command | Purpose |
|---------|---------|
| `rivetos start` | Boot and run |
| `rivetos stop` | Kill via PID file |
| `rivetos status` | Runtime status from health endpoint |
| `rivetos init` | Interactive setup wizard |
| `rivetos update` | Pull source, rebuild, restart |
| `rivetos doctor` | 12-category health check |
| `rivetos test` | Smoke tests (config, provider, memory, tools) |
| `rivetos logs` | Tail logs with filtering |
| `rivetos config` | Show/validate/edit config |
| `rivetos agent` | Add/remove/list agents |
| `rivetos model` | Show/switch models |
| `rivetos build` | Build container images |
| `rivetos infra` | Pulumi infrastructure commands |
| `rivetos mesh` | Mesh management (list, ping, join, status) |
| `rivetos service` | Systemd service management |
| `rivetos skills` | Skill management |
| `rivetos plugins` | Plugin listing and status |
| `rivetos provider` | Provider-specific commands |

---

## Architecture Rules

1. `types` is the leaf — interfaces only, zero deps
2. Domain layer is pure — no I/O, no `fs`, no `fetch`
3. Application layer wires I/O — runtime/, boot/registrars/
4. Plugins use dynamic import — boot never statically imports a plugin
5. Late binding for tools — closures, not direct refs
6. Config is YAML, not code
7. Secrets in `.env` — never in config, never in images
8. Containers are stateless — all data on volumes/bind mounts
9. One message queue per session
10. Hooks are the extension point for all cross-cutting concerns

### Coding Standards
- TypeScript strict, ES2023 target, Node16 module resolution
- `.js` extensions required in imports (ESM)
- Named exports only (except CLI commands)
- Tests co-located: `foo.ts` → `foo.test.ts`
- Files: kebab-case. Classes: PascalCase. No `I` prefix on interfaces.
- File size: >420 warning, >500 consider split, >600 split immediately

---

## Milestones (All Complete)

| MS | Version | Theme |
|----|---------|-------|
| M0 | v0.0.x | Foundation — tests, CI, config validation |
| M1 | v0.0.x | Coreutils — 13 base tools |
| M2 | v0.2.0 | Hooks & Lifecycle — hook pipeline, safety, MCP |
| M3 | v0.3.0 | Multi-Agent Comms — delegation, cross-instance HTTP |
| M4 | v0.4.0 | Learning & Self-Improvement — review loop, skills |
| M5 | v0.5.0 | Agent Orchestration — tool filtering, routing, model switching |
| M6 | v0.8.0 | Containerized Distribution — Dockerfiles, init wizard, Pulumi |
| M7 | v0.9.0 | Reliability & Polish — errors, observability, security, mesh |
| M8 | v1.0.0 | Documentation & Launch — docs, DX tooling, README |

**Remaining for v1.0 GA:** GitHub repo public, npm publish, GHCR images, rivetos.dev site, end-to-end testing on Docker Desktop + Proxmox, 30 days stable production run.
