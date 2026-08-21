# RivetOS Codebase Reference

> Living document. Updated as the codebase evolves. Read this before building anything.
> Last updated: 2026-08-08 (docs staleness sweep — package tree, roles, CI, test inventory)

---

## Table of Contents

1. [Overview](#overview)
2. [Monorepo Structure](#monorepo-structure)
3. [Package Dependency Graph](#package-dependency-graph)
4. [Packages](#packages)
5. [Plugin Architecture](#plugin-architecture)
6. [Infrastructure](#infrastructure)
7. [Runtime Lifecycle](#runtime-lifecycle)
8. [Patterns & Conventions](#patterns--conventions)
9. [Testing](#testing)
10. [Known Issues & Tech Debt](#known-issues--tech-debt)
11. [File Index](#file-index)

---

## Overview

RivetOS is a lightweight AI agent runtime. It connects LLM providers (Anthropic, xAI, Google, Ollama, vLLM, llama-server, claude-cli) to messaging channels (Discord, Telegram, voice) with a tool execution loop, persistent memory, multi-agent orchestration, and an MCP transport that exposes the agent to external clients.

**Key Numbers:**
- ~63k lines of source code in `packages/` + `plugins/` (excluding tests)
- 13 packages, 19 plugins across 5 categories (provider, channel, tool, memory, transport)
- One unified `rivetos` container image with `--role agent | migrate` — no separate datahub image (Datahub is upstream `pgvector/pgvector:pg16`)
- Node.js 22+ (24 used in CI/containers), TypeScript 6, ES2023 target
- Nx monorepo with npm workspaces

---

## Monorepo Structure

```
/opt/rivetos/
├── packages/                    # Core framework (13 packages)
│   ├── types/                   # Shared interfaces. Depends only on den-protocol.
│   ├── core/                    # Runtime engine, domain logic, hooks
│   ├── boot/                    # Config loading, validation, registrars
│   ├── cli/                     # All CLI commands (rivetos <command>)
│   ├── aisdk/                   # AI SDK ↔ RivetOS adapter (message + stream-part conversion)
│   ├── workflows/               # Workflows v1 engine — document model, step SDK, journal replay
│   ├── wiki-core/               # Memory wiki page model — parse/apply/serialize, pure
│   ├── den-protocol/            # rivet-den event protocol + pure room-state reducer
│   ├── den-packs/               # rivet-den SpritePack spec, validator CLI, default pack
│   ├── gateway-client/          # Typed HTTP+WS client for the gateway API (RivetHub's bridge)
│   ├── mcp/                     # MCP primitives shared by the sidecar and clients
│   ├── mcp-v2/                  # Era-negotiating MCP surface built on `mcp`
│   └── nx-plugin/               # `@rivetos/nx` — Nx generators for scaffolding plugins
│
├── plugins/                     # Extensions (19 plugins across 5 categories)
│   ├── providers/               # LLM provider adapters
│   │   ├── anthropic/           # Claude (streaming, adaptive thinking, prompt caching)
│   │   ├── google/              # Gemini (thought signatures for function calling)
│   │   ├── xai/                 # Grok (streaming, live search)
│   │   ├── ollama/              # Local Ollama models
│   │   ├── vllm/               # vLLM server (full vLLM surface)
│   │   ├── llama-server/       # llama.cpp llama-server (lean)
│   │   └── claude-cli/          # Drives `claude` CLI via stream-json + embedded MCP bridge
│   │
│   ├── channels/                # Messaging surface adapters
│   │   └── agent/               # Agent-to-agent mesh (HTTPS/mTLS); social channels removed Phase 5
│   │
│   ├── tools/                   # Agent capabilities
│   │   ├── shell/               # Shell execution (cwd, timeout, danger detection)
│   │   ├── file/                # file_read, file_write, file_edit
│   │   ├── search/              # search_glob, search_grep
│   │   ├── interaction/         # ask_user, todo list
│   │   ├── web-search/          # Google CSE + web_fetch (Readability)
│   │   └── mcp-client/          # MCP protocol client (stdio + HTTP transports)
│   │
│   ├── memory/                  # Persistence backends
│   │   └── postgres/            # PostgreSQL (conversations, messages, search,
│   │       │                    #   embeddings, compaction, summaries, review loop)
│   │       └── src/schema/      # Co-located SQL migrations & DDL
│   │                            #   (workers live in services/, not here)
│   │
│   └── transports/              # Inbound MCP / RPC surfaces
│       └── mcp-server/          # @rivetos/mcp-server — exposes RivetOS tools
│                                #   (memory_*, web_*, skill_*, runtime) over MCP
│                                #   StreamableHTTP. Has its own `rivetos-mcp-server` bin.
│
├── services/                    # Long-running processes deployed alongside the agent
│   ├── den-server/              # Embedded den/gateway server (also a boot dependency)
│   ├── embedding-worker/        # graphile-worker daemon — embedding jobs
│   ├── compaction-worker/       # graphile-worker daemon — compaction + wiki extraction
│   └── mcp-sidecar/             # Standalone MCP surface over the runtime's tools
│
├── apps/                        # End-user surfaces
│   ├── den/                     # rivet-den companion renderer
│   ├── rivethub-web/            # RivetHub web client
│   ├── rivethub-desktop/        # RivetHub Tauri desktop shell
│   ├── rivet-android/           # RivetHub Android client (AGPL)
│   └── site/                    # Astro docs site (rivetos.dev)
│
├── infra/                       # Container Dockerfiles + Compose + provisioning scripts
│   ├── containers/
│   │   ├── rivetos/             # Unified runtime image — built once, dispatched via `--role`
│   │   └── DATA-PERSISTENCE.md  # What survives container rebuilds
│   ├── docker/                  # Compose stacks
│   │   ├── rivetos/             # canonical stack (datahub + migrate + agent + 2 workers)
│   │   └── mcp-stack/           # standalone MCP server stack
│   ├── scripts/                 # provision-ct.sh, setup-mesh-hosts.sh, …
│   └── templates/               # Workspace + config skeletons used by `init`
│
├── .github/workflows/pipeline.yml  # GitHub Actions: lint/test/build → publish npm + containers → notify-ops
├── .env.example                 # Template for secrets
├── nx.json                      # Nx configuration
├── tsconfig.base.json           # Shared TS config (ES2023, Node16 modules, strict)
└── package.json                 # Root workspace config
```

---

## Package Dependency Graph

Workspace dependencies as declared in each `package.json` (`@rivetos/*` only):

```
den-protocol            ← Leaf. No workspace deps.
wiki-core               ← Leaf. No workspace deps.
workflows               ← Leaf. No workspace deps.
nx (nx-plugin)          ← Leaf. No workspace deps.

types                   ← den-protocol
aisdk                   ← types
mcp                     ← types
mcp-v2                  ← mcp
gateway-client          ← types
den-packs               ← den-protocol

core                    ← types, aisdk, workflows, wiki-core
boot                    ← types, core, workflows, den-server,
                          memory-postgres, provider-claude-cli
cli                     ← boot, workflows

plugins/providers/*     ← types, aisdk
  └─ claude-cli         ← + mcp, mcp-v2
plugins/memory/postgres ← types, wiki-core
plugins/channels/*      ← types
plugins/tools/*         ← types
  └─ mcp-client         ← + mcp-v2
plugins/transports/mcp-server ← types, mcp, mcp-v2

services/den-server     ← den-protocol, types
services/compaction-worker ← memory-postgres, wiki-core
services/embedding-worker  ← no workspace deps
services/mcp-sidecar    ← mcp, mcp-v2, core, types, wiki-core,
                          memory-postgres, tool-{file,search,shell,web-search}

infra/                  ← Build artifacts only — no @rivetos/* runtime deps
```

**No plugin depends on `@rivetos/core`.** Providers reach the shared AI SDK adapter through `@rivetos/aisdk`; anything else a plugin needs comes from `@rivetos/types`.

**Rule: `@rivetos/types` is (almost) interfaces only.** Its one workspace dependency is
`@rivetos/den-protocol`, which supplies the den event contract that the runtime types
reference. Beyond that, if you need a class or function, it goes in `core`.

**What `boot` declares in `package.json`.** Four workspace packages are listed as direct dependencies of `boot` — `@rivetos/provider-claude-cli`, `@rivetos/memory-postgres`, `@rivetos/den-server`, and `@rivetos/workflows` — so a default install always materializes them. That declaration is about *installation*, not registration: `boot` imports specific symbols from them (the workflow engine, `WikiIndex`, the claude-cli task executor, the den server), while the two that are also plugins — the claude-cli provider and the memory-postgres backend — are still registered the same way as every other plugin, through discovery and `manifest.register()`.

---

## Packages

### `@rivetos/types`

TypeScript interfaces and type exports. The contract layer. Its only workspace
dependency is `@rivetos/den-protocol`.

| File | Purpose |
|------|---------|
| `message.ts` | `Message`, `ToolCall`, `ContentPart` (text + image) |
| `provider.ts` | `Provider`, `LLMResponse`, `LLMChunk`, `ProviderError` class |
| `channel.ts` | `Channel`, `InboundMessage`, `OutboundMessage`, `EditResult` |
| `tool.ts` | `Tool`, `ToolDefinition`, `ToolContext`, `ToolResult` |
| `plugin.ts` | `Plugin`, `PluginConfig` |
| `memory.ts` | `Memory`, `MemoryEntry`, `MemorySearchResult` |
| `workspace.ts` | `Workspace`, `WorkspaceFile` |
| `config.ts` | `RuntimeConfig`, `AgentConfig`, `HeartbeatConfig`, `LearningLoopConfig` |
| `deployment.ts` | `DeploymentTarget`, `DeploymentConfig` (`target` only) |
| `defaults.ts` | Shared default values for config resolution |
| `events.ts` | `StreamEvent`, `SessionState`, `DelegationRequest/Result`, `TokenUsage` |
| `hooks.ts` | Full hook system types (16 event types, pipeline, config) |
| `mesh.ts` | `MeshNode`, `MeshRegistry`, `MeshConfig`, `MeshDelegationRoute` |
| `gateway.ts` | Gateway route/upgrade contracts registered by `boot` |
| `gateway-api.ts` | Wire types for the gateway HTTP+WS API (shared with `gateway-client`) |
| `session-context.ts` | Per-session context carried through a turn |
| `task.ts` / `task-result.ts` | Task engine records and result shapes (`ros_tasks`) |
| `commands.ts` | Slash-command descriptors |
| `wiki.ts` | Memory wiki page + index types |
| `skill.ts` | `Skill`, `SkillManager` |
| `subagent.ts` | `SubagentSession`, `SubagentManager` |
| `errors.ts` | `RivetError` hierarchy (Channel, Memory, Config, Tool, Delegation, Runtime) |
| `utils.ts` | `splitMessage`, `getTextContent`, `hasImages`, tool result helpers |

**Exception:** `ProviderError` and `RivetError` (and subclasses) are classes exported from types. This is the one place types has runtime code — because errors need to be `instanceof`-checkable across package boundaries.

### `@rivetos/boot`

The composition root. Loads config, validates, wires everything together, starts the runtime.

| File | Purpose |
|------|---------|
| `config.ts` | YAML config loader with `${ENV_VAR}` resolution |
| `discovery.ts` | Finds the plugin root and builds the plugin registry from manifests |
| `lifecycle.ts` | PID file management, SIGINT/SIGTERM handlers |
| `validate/` | Config schema validation (sections, cross-refs, deployment) |
| `registrars/agents.ts` | Wires delegation, sub-agents, skills |
| `registrars/hooks.ts` | Wires safety, auto-action, session hooks |
| `registrars/plugins.ts` | Generic manifest-driven loader for all discovered providers, channels, tools, and memory plugins |
| `registrars/gateway.ts` | Starts the embedded den/gateway server with the routes and WS upgrades collected from agent tools |

**Boot flow:** `loadConfig()` → `validateConfig()` → `discoverPlugins()` → `registerHooks()` → `new Runtime()` → `registerPlugins()` → `registerAgentTools()` → `registerGateway()` → `writePidFile()` → `runtime.start()`

Each plugin package exports `manifest: PluginManifest` from its `index.ts`. `registerPlugins()` calls `manifest.register(ctx)` once per discovered plugin; the plugin owns its config resolution, env-var lookup, and shutdown wiring via the `RegistrationContext`.

**Config shape:** YAML with sections `runtime`, `agents`, `providers`, `channels`, `memory`, `mcp`, `deployment`. See `config.ts` for the full RivetConfig interface.

### `@rivetos/core`

The runtime engine. Split into two layers:

**Domain Layer** (`src/domain/`) — Pure business logic, no I/O:

| File | Lines | Purpose |
|------|-------|---------|
| `loop.ts` | 589 | **AgentLoop** — the core execution cycle (stream → tool → stream) |
| `router.ts` | 69 | Routes messages to agent+provider pairs |
| `queue.ts` | 134 | Message queue with sequential processing |
| `delegation.ts` | 448 | Agent-to-agent task handoff with caching, depth limits |
| `subagent.ts` | 515 | Persistent interactive child sessions (spawn/send/kill) |
| `workspace.ts` | 212 | Loads workspace files, builds system prompts |
| `hooks.ts` | 215 | HookPipelineImpl — priority-ordered async middleware |
| `safety-hooks.ts` | 393 | Shell danger detection, workspace fencing, audit logging |
| `auto-actions.ts` | 330 | Auto-format, auto-lint, auto-test, auto-git-check |
| `session-hooks.ts` | 313 | Session start/end, auto-summary, pre/post compaction |
| `heartbeat.ts` | 133 | Scheduled agent execution with quiet hours |
| `reconnect.ts` | 190 | Channel reconnection with exponential backoff |
| `mesh.ts` | 344 | File-based mesh registry with heartbeat, prune, seed sync |
| `mesh-delegation.ts` | 253 | Cross-mesh HTTP delegation |
| `skills/` | 1,337 | Skill discovery, matching, manage tool, frontmatter parsing |
| `constants.ts` | 9 | Silent response strings |

**Application Layer** (`src/runtime/`) — Wires domain + I/O:

| File | Lines | Purpose |
|------|-------|---------|
| `runtime.ts` | ~300 | **Runtime** class — registers components, owns lifecycle |
| `turn-handler.ts` | ~250 | Processes a single message turn (route → hook → loop → deliver) |
| `commands.ts` | ~350 | Slash command handler (/stop, /new, /status, /model, /context, etc.) |
| `streaming.ts` | ~250 | Stream events → channel message edits (throttled, one message per turn) |
| `sessions.ts` | ~150 | Session lifecycle, history restoration, settings persistence |
| `media.ts` | ~100 | Attachment resolution, image download, base64 encoding |
| `health.ts` | ~170 | HTTP health endpoint (GET /health, /health/live, /metrics) |
| `metrics.ts` | ~170 | Runtime metrics collector (turns, tools, tokens, latency, errors) |

**Security** (`src/security/`):

| File | Lines | Purpose |
|------|-------|---------|
| `secrets.ts` | ~170 | Secret redaction, .env permissions, 1Password `op://` resolution |

Audit logging itself lives in `domain/safety-hooks.ts` and is wired by `boot`, which appends to
`<workspace>/.data/audit/<date>.jsonl`. There is no rotation or retention: audit logs accumulate
indefinitely and operators are expected to prune them manually.

**Logger** (`src/logger.ts`, ~170 lines):
- Two modes: `pretty` (dev, colored) and `json` (production, structured)
- Scoped by component: `logger('Router')` → `[Router] message`
- Levels: error, warn, info, debug
- Set via `RIVETOS_LOG_LEVEL` and `RIVETOS_LOG_FORMAT` env vars
- Understands `RivetError` — extracts code, severity into structured output

### `@rivetos/cli`

Every `rivetos <command>` lives here. Lazy-loaded via dynamic import.

| Command | File | Purpose |
|---------|------|---------|
| `init` | `commands/init.ts` → `commands/init/` | Interactive setup wizard (@clack/prompts) |
| `start` | `commands/start.ts` | Boot and run (`--role agent \| migrate`) |
| `stop` | `commands/stop.ts` | Kill running instance via PID file |
| `status` | `commands/status.ts` | Runtime status display |
| `update` | `commands/update.ts` (+ `commands/update/`) | Source/container update, incl. remote mesh nodes |
| `doctor` | `commands/doctor.ts` | 12-category health check |
| `test` | `commands/test.ts` | Smoke tests (config, provider, memory, tools) |
| `logs` | `commands/logs.ts` | Tail runtime logs with filtering |
| `config` | `commands/config.ts` | Show/validate/edit config |
| `agent` | `commands/agent.ts` | Add/remove/list agents |
| `model` | `commands/model.ts` | Show/switch models |
| `build` | `commands/build.ts` | Build container images |
| `mesh` | `commands/mesh.ts` | Mesh management (list, ping, join, status) |
| `gateway` | `commands/gateway.ts` | Embedded-den gateway helpers (`gateway token`, `--rotate`) |
| `memory` | `commands/memory.ts` | Memory subsystem maintenance (backfill jobs, etc.) |
| `db` | `commands/db.ts` | Schema migration and inspection (`db migrate`, `db status`) |
| `keys` | `commands/keys.ts` | SSH key management for the mesh (rotate, list, status) |
| `service` | `commands/service.ts` | Systemd service management |
| `skills` / `skill` | `commands/skills.ts` | Skill listing (`skill init` → `skill-init.ts`, `skill validate` → `skill-validate.ts`) |
| `plugins` / `plugin` | `commands/plugins.ts` | Plugin listing and status (`plugins sync` → `plugins-sync.ts`, `plugin init` → `plugin-init.ts`) |
| `workflow` | `commands/workflow.ts` | Scaffold workflows (`workflow new <name>`) |
| `provider` | `commands/provider.ts` | Provider-specific commands (setup, status) |
| `version` | `commands/version.ts` | Version display |

**Init wizard phases:** `detect` → `deployment` → `agents` → `channels` → `review` → `generate`

### `@rivetos/nx` (`packages/nx-plugin/`)

Nx generators for scaffolding new plugins:
```bash
npx nx g @rivetos/nx:plugin --type=provider --name=deepseek
```
Generates: `plugins/{type}/{name}/` with `package.json`, `tsconfig.json`, `src/index.ts`, `src/index.test.ts`.

---

## Plugin Architecture

### Plugin Categories

All plugins follow the same pattern: a class implementing an interface from `@rivetos/types`, dynamically imported by a registrar in `@rivetos/boot`.

| Category   | Interface  | Registration |
|------------|------------|-------------|
| Provider   | `Provider` | `boot/registrars/plugins.ts` (via `manifest.register`) |
| Channel    | `Channel`  | `boot/registrars/plugins.ts` (via `manifest.register`) |
| Tool       | `Tool`     | `boot/registrars/plugins.ts` (via `manifest.register`) |
| Memory     | `Memory`   | `boot/registrars/plugins.ts` (via `manifest.register`) |
| Transport  | (no core interface — plugin opens its own listening surface) | `boot/registrars/plugins.ts` — registers shutdown + `onRegistrationComplete` to enumerate the finalized tool set |

### Provider Plugin Pattern

```typescript
export class ExampleProvider implements Provider {
  id = 'example'
  name = 'Example'
  
  async *chatStream(messages: Message[], options?: ChatOptions): AsyncIterable<LLMChunk> {
    // Stream LLM responses
  }
  
  async isAvailable(): Promise<boolean> { ... }
  getModel(): string { ... }
  setModel(model: string): void { ... }
}
```

All providers implement streaming via `chatStream()` (AsyncIterable). The non-streaming `chat()` is optional — the AgentLoop always uses `chatStream()`.

### Channel Plugin Pattern

```typescript
export class ExampleChannel implements Channel {
  id = 'example'
  platform = 'example'
  
  async start(): Promise<void> { ... }
  async stop(): Promise<void> { ... }
  async send(message: OutboundMessage): Promise<string | null> { ... }
  async edit?(channelId, messageId, text, overflowIds?): Promise<EditResult | null> { ... }
  async react?(channelId, messageId, emoji): Promise<void> { ... }
  async resolveAttachment?(attachment): Promise<ResolvedAttachment | null> { ... }
  onMessage(handler): void { ... }
  onCommand(handler): void { ... }
}
```

The `edit()` method handles overflow internally — if text exceeds platform limits, the channel splits it and manages overflow message IDs.

### Tool Plugin Pattern

```typescript
export class ExampleTool implements Tool {
  name = 'example_tool'
  description = 'Does something useful'
  parameters = { type: 'object', properties: { ... } }
  
  async execute(args, signal?, context?): Promise<ToolResult> {
    // ToolResult = string | ContentPart[] (for multimodal)
  }
}
```

Tools can return plain text or multimodal content (text + images as `ContentPart[]`).

### Memory Plugin Pattern

```typescript
export class ExampleMemory implements Memory {
  async append(entry: MemoryEntry): Promise<string> { ... }
  async search(query, options?): Promise<MemorySearchResult[]> { ... }
  async getContextForTurn(query, agent, options?): Promise<string> { ... }
  async getSessionHistory(sessionId, options?): Promise<Message[]> { ... }
  async saveSessionSettings?(sessionId, settings): Promise<void> { ... }
  async loadSessionSettings?(sessionId): Promise<Record<string, unknown> | null> { ... }
}
```

### Plugin Package Convention

Every plugin lives at `plugins/{category}/{name}/` and has:
- `package.json` with name `@rivetos/{category}-{name}`
- `tsconfig.json` extending `../../../tsconfig.base.json`
- `src/index.ts` as the main entry point
- `src/index.test.ts` for tests

---

## Infrastructure

### Container Images

**Unified `rivetos` image** (`infra/containers/rivetos/Dockerfile`):
- Single Node 24 Alpine image, non-root user (`rivetos`), tini init
- Built once with `npm run build` (esbuild bundle in `dist/`)
- Dispatched at runtime via `--role agent | migrate` (`packages/cli/src/commands/start.ts`). `agent` is the default. `RIVETOS_ROLE` seeds the role, but an explicit `--role` flag overrides it — the flag wins, not the env var. An unknown value exits with `unknown role`, whether it came from the flag or from `RIVETOS_ROLE`.
- The `services/{embedding,compaction}-worker` dists ship in the image too, but they are not roles — run them directly (`node services/embedding-worker/dist/index.js`).
- Healthcheck: hits `/health/live` on the agent role; the migrate role skips the check
- Workspace and config mounted as volumes

**Datahub** (no custom image):
- Uses upstream `pgvector/pgvector:pg16` directly
- Schema is applied by the `migrate` role of the unified image at stack startup; the database container has no rivetos-specific code or scripts

### Docker Compose

The canonical stack lives at `infra/docker/rivetos/docker-compose.yml` and defines five services:

- `datahub` — Postgres + pgvector (image: `pgvector/pgvector:pg16`, upstream)
- `migrate` — one-shot, applies pending migrations and exits (image: `rivetos`, role: `migrate`)
- `embedding-worker` — `graphile-worker` daemon, `node services/embedding-worker/dist/index.js` (image: `rivetos`, profile: `workers`)
- `compaction-worker` — `graphile-worker` daemon, `node services/compaction-worker/dist/index.js` (image: `rivetos`, profile: `workers`)
- `agent` — runtime that drives channels + providers (image: `rivetos`, role: `agent`)

Named volume: `rivetos-pgdata`. Dependency ordering: only `migrate` waits on `datahub` being healthy; the workers and `agent` each wait solely on `migrate` completing successfully (`service_completed_successfully`), so they inherit the database gate transitively rather than declaring it.

Both workers sit behind the `workers` profile, so a bare `docker compose up` brings up only `datahub`, `migrate`, and `agent`. Each needs an inference endpoint the compose file cannot guess (`RIVETOS_EMBED_URL` / `RIVETOS_COMPACTOR_URL`) and exits 1 on boot without one; supply those, then `docker compose --profile workers up`.

### Memory Workers (graphile-worker daemons)

Embedding and compaction run as **`graphile-worker` daemons deployed alongside Datahub**
(`services/embedding-worker/`, `services/compaction-worker/`). Both pull from a
Postgres-backed job queue rather than holding a `LISTEN` connection — the earlier
LISTEN/NOTIFY pumps under `plugins/memory/postgres/workers/` were replaced. No agent node
runs background memory jobs; the workers are the sole consumers.

```
┌────────────────────────────────────────────────────┐
│  Datahub  —  Postgres 16 + graphile_worker queue   │
│                                                    │
│  ┌──────────────────┐  ┌─────────────────────────┐ │
│  │ Embedding Worker │  │ Compaction Worker       │ │
│  │ (2 tasks)        │  │ (7 tasks)               │ │
│  │ embed-target     │  │ compact-conversation    │ │
│  │ enqueue-         │  │ synthesize-tool-call    │ │
│  │   unembedded     │  │ extract-wiki            │ │
│  │   (cron */10)    │  │ consolidate-wiki        │ │
│  │                  │  │ recompile-wiki          │ │
│  │                  │  │ enqueue-idle (cron */5) │ │
│  │                  │  │ enqueue-wiki-backfill   │ │
│  │                  │  │   (cron */10)           │ │
│  │ → Embed model    │  │ → Summarization model   │ │
│  │   (GPU endpoint) │  │   (CPU endpoint)        │ │
│  └──────────────────┘  └─────────────────────────┘ │
│                                                    │
│  Jobs are enqueued by:                             │
│  • INSERT ros_messages  → trigger calls            │
│  • INSERT ros_summaries →   graphile_worker        │
│                             .add_job('embed-       │
│                             target'), deduped by   │
│                             job_key                │
│  • Session idle         → 'enqueue-idle' cron      │
│                             (every 5 min), not a   │
│                             DB trigger             │
│  • Empty-content tool   → the memory adapter       │
│    call appended            enqueues 'synthesize-  │
│                             tool-call' inline      │
└────────────────────────────────────────────────────┘
         │                          │
         ▼                          ▼
┌──────────────────────────────────────────────────┐
│  Inference Server  —  GPU + CPU                  │
│                                                  │
│  Embedding model (GPU)    — vector embeddings    │
│  Summarization model (CPU) — compaction/summary  │
└──────────────────────────────────────────────────┘
```

**Embedding flow:**
1. INSERT into `ros_messages` / `ros_summaries` → `notify_embedding_queue()` trigger → `graphile_worker.add_job('embed-target', …)`, skipped when content is empty
2. graphile-worker picks the job up in the embedding-worker → calls the configured embed endpoint (`RIVETOS_EMBED_URL` / `RIVETOS_EMBED_MODEL`)
3. Writes the vector back to the source row
4. graphile-worker handles retry/backoff/dedup — deduped by `job_key = 'embed-<table>-<id>'`, `max_attempts => 5`
5. An `enqueue-unembedded` cron (every 10 min) re-queues rows left with a NULL embedding and no live job

**Compaction flow (one enqueue path):**

All compaction enqueueing lives in the worker's `enqueue-idle` cron
(`services/compaction-worker/src/tasks/enqueue-idle.ts`, `*/5 * * * *`). There is no
Postgres trigger — `check_compaction_threshold` and `enqueue_idle_sessions()` are
deliberately absent from the baseline schema. Each tick enqueues up to 10 conversations,
picking any whose unsummarized messages satisfy one of three clauses:

| Clause | Condition | Trigger type |
|--------|-----------|--------------|
| Full window | `>= COMPACT_LEAF_BATCH` (default 10) unsummarized — fires even while the conversation is active, so long-running sessions drain one window per tick | `session_idle` |
| Idle | quiet for `COMPACT_IDLE_MINUTES` (default 15) and `>= MIN_BATCH_SIZE` (5) unsummarized — mops up the remainder | `session_idle` |
| Stale | quiet for `COMPACT_STALE_MINUTES` (default 4 days) and `>= COMPACT_STALE_MIN_BATCH` (2) — flushes the below-floor tail the idle clause skips by design | `session_stale` |

Jobs are deduped by `jobKey = conversationId` (`preserve_run_at`, `maxAttempts: 3`), so a
tick can enqueue unconditionally without checking for a pending job.

Hierarchy: messages → leaf summaries → branch summaries → root summaries (bottom-up). Full thinking enabled with generous token budgets and a 60-minute timeout.

**Tool-call synthesis:** when an assistant message is appended with empty content but a
`tool_name`, the memory adapter enqueues a `synthesize-tool-call` job inline
(`plugins/memory/postgres/src/adapter.ts`) so the row gets natural-language content it can
be searched by. `rivetos memory backfill-tool-synth` enqueues the same task for historical
rows.

**Wiki extraction:** the compaction worker also owns the memory wiki — `extract-wiki`
mines durable topic patches out of leaf summaries, `consolidate-wiki` merges near-duplicate
topics, and `recompile-wiki` rebuilds a topic's Summary + Article from history. A second
cron, `enqueue-wiki-backfill` (`*/10 * * * *`), queues leaves that were never mined.

**Source:** `services/embedding-worker/` and `services/compaction-worker/` (TS, graphile-worker tasks)
**Setup:** Schema DDL lives at `plugins/memory/postgres/src/schema/migrations/` and is applied at boot. Worker services run as their own systemd units; graphile-worker installs its own schema lazily on first connection.

### Data Persistence

Containers are stateless. All user data lives on volumes:

| Data | Storage | Survives Update |
|------|---------|-----------------|
| Workspace files | Bind mount `./workspace/` | ✅ |
| Config | Bind mount `./config.yaml` | ✅ |
| Secrets | `.env` on host | ✅ |
| Postgres data | Named volume `rivetos-pgdata` | ✅ |
| Shared storage | Named volume `rivetos-shared` | ✅ |
| Plugins | In source tree | ✅ |
| Runtime code | Rebuilt from source | 🔄 |

---

## Runtime Lifecycle

### Boot Sequence

```
rivetos start
  └── boot()
       ├── loadConfig(path)           # YAML → typed config
       ├── validateConfig(config)     # Schema + cross-ref validation
       ├── registerHooks()            # Safety, auto-action, session hooks
       ├── new Runtime(config)        # Creates Router, Workspace, SessionManager, etc.
       ├── registerPlugins()          # Manifest-driven: providers, channels, memory, tools
       ├── registerAgentTools()       # Delegation, sub-agents, skills
       ├── writePidFile()             # ~/.rivetos/rivetos.pid
       ├── registerShutdownHandlers() # SIGINT/SIGTERM → graceful stop
       └── runtime.start()
            ├── workspace.load()      # Read workspace files
            ├── router.healthCheck()  # Verify providers are reachable
            ├── channel.start()       # Connect to Discord, Telegram, etc.
            ├── healthServer.start()  # HTTP on :3100
            └── heartbeatRunner.start() # Scheduled agent execution
```

### Message Flow (Single Turn)

```
Channel receives message
  └── Runtime.handleMessage()
       ├── isCommand? → CommandHandler.handle()
       ├── Queue: if turn active → queue, react with 👀
       └── TurnHandler.handle()
            ├── Router.route(message) → { agent, provider }
            ├── SessionManager.getOrCreateSession()
            ├── workspace.buildSystemPrompt() [cached per session]
            ├── Hook: turn:before (can skip)
            ├── resolveAttachments() (images → base64)
            ├── AgentLoop.run(content, history, signal)
            │   ├── Provider.chatStream() → stream chunks
            │   │   ├── Hook: provider:before (rate limit, skip)
            │   │   ├── ← Stream text → StreamManager → channel.edit()
            │   │   ├── ← Stream tool_call → execute tool
            │   │   │   ├── Hook: tool:before (safety gate)
            │   │   │   ├── tool.execute()
            │   │   │   └── Hook: tool:after (auto-format, auto-lint)
            │   │   └── Hook: provider:after (token logging)
            │   └── Loop until: text response | max iterations | abort
            ├── Hook: turn:after (review loop, delegation tracking)
            ├── StreamManager.cleanup()
            ├── channel.edit() or channel.send() final response
            ├── metrics.recordTurn()
            └── memory.append() (user + assistant messages)
```

### Streaming Behavior

- **ONE streaming text message per turn** — sent on first text chunk, edited as more arrives
- **Throttled edits** — 600ms minimum between Discord edit calls
- **Overflow is the channel's job** — `edit()` handles splitting
- **Reasoning** — shown as inline italics if visible, "🧠 Thinking..." indicator if hidden
- **Tool calls** — ONE consolidated tool log message, edited in-place (max 8 lines shown)
- **Errors** — only thing that sends a NEW message mid-turn

### Hook System

16 lifecycle events, priority-ordered (0-99, lower first), async pipelines:

| Event | When | Key Use |
|-------|------|---------|
| `provider:before` | Before LLM call | Rate limit checks |
| `provider:after` | After LLM response | Token logging |
| `provider:error` | LLM failure | Logging, classification (observational only) |
| `tool:before` | Before tool execution | **Safety gates**, audit |
| `tool:after` | After tool execution | Auto-format, auto-lint |
| `session:start` | New session | Context loading |
| `session:end` | Session ending | Auto-summary |
| `turn:before` | Before processing | Content filtering |
| `turn:after` | After turn completes | Delegation tracking |
| `turn:reflect` | After complex turns | Pattern analysis |
| `skill:before` | Before skill load | Skip gate |
| `skill:after` | After skill used | Metrics |
| `compact:before` | Before compaction | Preserve context |
| `compact:after` | After compaction | Verify context |
| `delegation:before` | Before delegation | Block gate |
| `delegation:after` | After delegation | Audit, learning |

---

## Patterns & Conventions

### Coding Standards

- **TypeScript strict mode** — always
- **ES2023 target, Node16 module resolution**
- **`.js` extensions in imports** — required for Node16 ESM
- **No default exports in packages** — named exports only (except CLI commands use `export default`)
- **`index.ts` barrel exports** — every package re-exports from `src/index.ts`
- **Tests co-located** — `foo.ts` → `foo.test.ts` in same directory

### Naming Conventions

- **Packages:** `@rivetos/{name}` (npm scope)
- **Plugins:** `@rivetos/{category}-{name}` (e.g., `@rivetos/provider-anthropic`)
- **Files:** kebab-case (`safety-hooks.ts`, `turn-handler.ts`)
- **Classes:** PascalCase (`AgentLoop`, `DelegationEngine`)
- **Interfaces:** PascalCase, no `I` prefix (`Provider`, not `IProvider`)
- **Types:** PascalCase (`ThinkingLevel`, `DeploymentTarget`)
- **Constants:** UPPER_SNAKE (`SILENT_RESPONSES`, `CORE_FILES`)
- **Loggers:** `const log = logger('ComponentName')`

### Architecture Rules

1. **`types` is near the bottom** — everything depends on it; it depends only on `den-protocol`
2. **Domain layer is pure** — no I/O, no `fs`, no `fetch`. Only interfaces.
3. **Application layer wires I/O** — runtime/, boot/registrars/
4. **Plugins are discovered and registered via `manifest.register()`** — without exception, including `provider-claude-cli` and `memory-postgres`. `boot` additionally declares four workspace packages in its `package.json` so they are always installed, and imports specific symbols from them; that is an installation edge, not a registration shortcut
5. **Late binding for tools** — composite tools get tool executors as closures, not direct refs
6. **Config is YAML, not code** — all user-facing config in `config.yaml`
7. **Secrets in `.env`** — never in config YAML, never in container images
8. **Containers are stateless** — all data on volumes/bind mounts
9. **One message queue per session** — no shared queues, no race conditions
10. **Hooks are the extension point** — safety, auto-actions, observability all use hooks

### Error Handling

- **RivetError hierarchy** — typed errors with codes, severity, retryable flag
- **ProviderError** — HTTP-aware, observed by `provider:error` hooks
- **Reconnection manager** — exponential backoff for channel disconnects
- **Hook error modes** — `continue` (log & proceed), `abort` (stop pipeline), `retry`

### Config Shape

```yaml
runtime:
  workspace: ~/.rivetos/workspace
  default_agent: opus
  max_tool_iterations: 100
  skill_dirs: [~/.rivetos/skills]
  heartbeats: [...]
  safety: { shellDanger, workspaceFence, audit }
  auto_actions: { format, lint, test, gitCheck }

agents:
  opus: { provider: anthropic, default_thinking: medium, tools: { exclude: [...] } }

providers:
  anthropic: { model: claude-sonnet-4-6, max_tokens: 16384 }

channels:
  agent: { port: 3100, agent_id: "opus" }

memory:
  postgres: { connection_string: "${RIVETOS_PG_URL}" }

mcp:
  servers:
    memory: { transport: stdio, command: npx, args: [...] }

deployment:             # Optional — `target` is the only key consumed at runtime
  target: docker        # docker | proxmox | kubernetes | manual
```

Provisioning itself is driven by the Compose files under `infra/docker/` and the scripts
under `infra/scripts/` — not by nested config keys. Anything other than `target` inside
`deployment:` is reported as unknown by config validation.

---

## Testing

### Test Framework

- **Vitest 4.x** — fast, TypeScript-native, Node assert compatible
- **Co-located tests** — `foo.ts` → `foo.test.ts`
- **No external test deps** — uses `node:assert/strict`, no chai/jest matchers
- **Run:** `nx run-many -t test` or `nx test @rivetos/core`

### Test Coverage

Tests are co-located, so the current inventory is always one command away rather than a
table that rots:

```bash
find packages plugins services apps -name '*.test.ts' | wc -l   # ~160 files
npx nx run-many -t test --all                                    # run them
```

Coverage is broadest in `core/domain` (loop, hooks, delegation, queue, router, skills,
safety), `boot` (config validation, discovery, registrars), the memory plugin (adapter,
scoring, tool synthesis, wiki, migrations), and the CLI's update/mesh helpers.

### Untested Areas

- Infra provisioning scripts (Docker, Proxmox)
- Container builds
- The memory adapter and mcp-sidecar memory tests skip unless `RIVETOS_PG_URL` points at a live Postgres (`plugins/memory/postgres/src/adapter.test.ts`, `services/mcp-sidecar/src/memory.test.ts`); the worker services' own tests are plain unit tests and always run

---

## Known Issues & Tech Debt

### Architecture

1. **Compiled bundle now standard** — `npm run build` produces an esbuild bundle in `dist/`. The unified `rivetos` image runs the bundle, not source via `tsx`. Some legacy paths still allow running from source for dev.

2. **Root `package.json` still has one runtime dep** — `yaml`. `pg` has moved to the packages that actually use them; `yaml` is the last holdout and should follow.

3. **Social channels removed (Phase 5)** — telegram / discord / voice-discord packages deleted. Stale config keys warn as unknown channel types.

4. **Per-kind registrars deleted** — `boot/registrars/{providers,channels,tools,memory}.ts` were collapsed into a single manifest-driven `plugins.ts` (PR-B). Any references in user code or external docs to the old per-kind registrars are stale.

5. **Schema lives next to the plugin** — `plugins/memory/postgres/src/schema/migrations/` is the source of truth for SQL DDL. The unified image's `migrate` role applies it at stack startup.

### Config

6. **YAML snake_case vs TypeScript camelCase** — Config uses `default_agent`, types use `defaultAgent`. The mapping happens in `boot/index.ts` manually. No automated snake→camel conversion.

7. **Provider config is untyped** — Each provider's config is `Record<string, unknown>` in the raw config. Type safety is only enforced in the provider constructor.

### Infrastructure

8. **CI builds packages and containers in one pipeline** — `pipeline.yml` runs `secrets-scan` → `ci` (lint, boundary probes, typecheck, test, build), then fans out to `publish-npm` and `containers` in parallel, with `notify-ops` gated on both. `containers` builds the single unified `infra/containers/rivetos/Dockerfile` — there is no build matrix and no datahub image.

9. **Multi-arch container builds not implemented** — Dockerfiles are amd64 only. Buildx for arm64 is planned but not done.

10. **No code-driven IaC layer** — provisioning is fully script-and-Compose driven (`infra/scripts/` + `infra/docker/`). The Pulumi-based `@rivetos/infra` was removed in PR-H; nothing replaces it.

---

## File Index

### Core Loop

| What | Where |
|------|-------|
| Agent execution loop | `packages/core/src/domain/loop.ts` |
| Message routing | `packages/core/src/domain/router.ts` |
| Message queuing | `packages/core/src/domain/queue.ts` |
| Turn processing | `packages/core/src/runtime/turn-handler.ts` |
| Stream → channel delivery | `packages/core/src/runtime/streaming.ts` |
| Session management | `packages/core/src/runtime/sessions.ts` |

### Hooks & Safety

| What | Where |
|------|-------|
| Hook pipeline impl | `packages/core/src/domain/hooks.ts` |
| Safety hooks (shell, fence, audit) | `packages/core/src/domain/safety-hooks.ts` |
| Auto-actions (format, lint, test) | `packages/core/src/domain/auto-actions.ts` |
| Session hooks (start, summary) | `packages/core/src/domain/session-hooks.ts` |

### Multi-Agent

| What | Where |
|------|-------|
| Delegation engine | `packages/core/src/domain/delegation.ts` |
| Sub-agent manager | `packages/core/src/domain/subagent.ts` |
| Mesh registry | `packages/core/src/domain/mesh.ts` |
| Mesh delegation | `packages/core/src/domain/mesh-delegation.ts` |
| Agent HTTP channel | `plugins/channels/agent/src/index.ts` |

### Config & Boot

| What | Where |
|------|-------|
| Config YAML loader | `packages/boot/src/config.ts` |
| Config validation | `packages/boot/src/validate/` |
| Boot orchestrator | `packages/boot/src/index.ts` |
| Runtime compositor | `packages/core/src/runtime/runtime.ts` |

### CLI

| What | Where |
|------|-------|
| CLI entry point | `packages/cli/src/index.ts` |
| Init wizard | `packages/cli/src/commands/init/` |
| All other commands | `packages/cli/src/commands/*.ts` |

### Type Definitions

| What | Where |
|------|-------|
| All interfaces | `packages/types/src/` |
| Deployment types | `packages/types/src/deployment.ts` |
| Error hierarchy | `packages/types/src/errors.ts` |
| Hook types | `packages/types/src/hooks.ts` |

---

*This document is the source of truth for RivetOS architecture. Update it when you add packages, change patterns, or discover issues.*
