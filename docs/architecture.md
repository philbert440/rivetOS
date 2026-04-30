# ARCHITECTURE.md — RivetOS Codebase Reference

> Living document. Updated as the codebase evolves. Read this before building anything.
> Last updated: 2026-04-30 (post pulumi removal, schema relocation, transport plugins)

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

RivetOS is a lightweight AI agent runtime. It connects LLM providers (Anthropic, xAI, Google, Ollama, llama-server, openai-compat, claude-cli) to messaging channels (Discord, Telegram, voice) with a tool execution loop, persistent memory, multi-agent orchestration, and an MCP transport that exposes the agent to external clients.

**Key Numbers:**
- ~25k lines of source code in `packages/` + `plugins/` (excluding tests)
- 5 core packages, 19 plugins across 5 categories (provider, channel, tool, memory, transport)
- One unified `rivetos` container image with `--role` (agent / datahub / mcp), plus the legacy split agent + datahub Dockerfiles
- Node.js 24+, TypeScript 5.8, ES2023 target
- Nx monorepo with npm workspaces

---

## Monorepo Structure

```
/opt/rivetos/
├── packages/                    # Core framework (5 packages)
│   ├── types/                   # 2,078 lines — Interfaces only. Zero deps. Leaf package.
│   ├── boot/                    # 2,364 lines — Config loading, validation, registrars
│   ├── core/                    # 8,534 lines — Runtime engine, domain logic, hooks
│   ├── cli/                     # 6,080 lines — All CLI commands (rivetos <command>)
│   └── nx-plugin/               # 724 lines   — Nx generators for scaffolding plugins
│
├── plugins/                     # Extensions (19 plugins across 5 categories)
│   ├── providers/               # ~5,700 lines — LLM provider adapters
│   │   ├── anthropic/           # Claude (streaming, adaptive thinking, prompt caching)
│   │   ├── google/              # Gemini (thought signatures for function calling)
│   │   ├── xai/                 # Grok (streaming, live search)
│   │   ├── ollama/              # Local Ollama models
│   │   ├── llama-server/        # Native llama.cpp server (sampling, <think>, tools)
│   │   ├── openai-compat/       # Strict OpenAI servers (vLLM/TGI/Groq/Together/LocalAI)
│   │   └── claude-cli/          # Drives `claude` CLI via stream-json + embedded MCP bridge
│   │
│   ├── channels/                # ~4,300 lines — Messaging surface adapters
│   │   ├── discord/             # Discord (edit, react, embed, overflow, bindings)
│   │   ├── telegram/            # Telegram (owner gate, inline queries)
│   │   ├── agent/               # Agent-to-agent HTTPS/mTLS channel (delegation target)
│   │   └── voice-discord/       # Discord voice (xAI Realtime API, STT/TTS)
│   │
│   ├── tools/                   # ~3,300 lines — Agent capabilities
│   │   ├── shell/               # Shell execution (cwd, timeout, danger detection)
│   │   ├── file/                # file_read, file_write, file_edit
│   │   ├── search/              # search_glob, search_grep
│   │   ├── interaction/         # ask_user, todo list
│   │   ├── web-search/          # Google CSE + web_fetch (Readability)
│   │   ├── mcp-client/          # MCP protocol client (stdio + HTTP transports)
│   │   └── coding-pipeline/     # Multi-agent build-review-fix loop
│   │
│   ├── memory/                  # ~5,700 lines — Persistence backends
│   │   └── postgres/            # PostgreSQL (conversations, messages, search,
│   │       │                    #   embeddings, compaction, summaries, review loop)
│   │       ├── schema/          # Co-located SQL migrations & DDL
│   │       └── workers/         # Event-driven workers (embedding + compaction)
│   │
│   └── transports/              # ~2,600 lines — Inbound MCP / RPC surfaces
│       └── mcp-server/          # @rivetos/mcp-server — exposes RivetOS tools
│                                #   (memory_*, web_*, skill_*, runtime) over MCP
│                                #   StreamableHTTP. Has its own `rivetos-mcp-server` bin.
│
├── apps/infra/                  # Container Dockerfiles + Compose + provisioning scripts
│   ├── containers/
│   │   ├── agent/               # Legacy split agent Dockerfile
│   │   ├── datahub/             # Legacy split datahub Dockerfile (postgres + pgvector)
│   │   ├── rivetos/             # Unified image — built once, dispatched via `--role`
│   │   └── DATA-PERSISTENCE.md  # What survives container rebuilds
│   ├── docker/                  # Compose stacks (mcp-stack, rivetos)
│   ├── scripts/                 # provision-ct.sh, setup-mesh-hosts.sh, …
│   └── templates/               # Workspace + config skeletons used by `init`
│
├── .github/workflows/pipeline.yml  # GitHub Actions: lint/test/build → publish npm + containers → notify-ops
├── docker-compose.yaml          # Multi-agent Docker Compose with profiles
├── .env.example                 # Template for secrets
├── nx.json                      # Nx configuration
├── tsconfig.base.json           # Shared TS config (ES2023, Node16 modules, strict)
└── package.json                 # Root workspace config
```

---

## Package Dependency Graph

```
@rivetos/types          ← Leaf. No dependencies. Everything depends on this.
    ↑
@rivetos/core           ← Depends on: types
    ↑
@rivetos/boot           ← Depends on: types, core, all plugins (dynamic import)
    ↑
@rivetos/cli            ← Depends on: types, core, boot
    
plugins/*               ← Each depends on: types (some on core for logger)

apps/infra/             ← Build artifacts only — no @rivetos/* runtime deps
```

**Rule: `@rivetos/types` is interfaces only. Zero runtime deps. If you need a class or function, it goes in `core`.**

---

## Packages

### `@rivetos/types` (2,078 lines)

Pure TypeScript interfaces and type exports. The contract layer.

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
| `deployment.ts` | `DeploymentConfig`, Docker/Proxmox/K8s types |
| `events.ts` | `StreamEvent`, `SessionState`, `DelegationRequest/Result`, `TokenUsage` |
| `hooks.ts` | Full hook system types (16 event types, pipeline, config) |
| `mesh.ts` | `MeshNode`, `MeshRegistry`, `MeshConfig`, `MeshDelegationRoute` |
| `skill.ts` | `Skill`, `SkillManager` |
| `subagent.ts` | `SubagentSession`, `SubagentManager` |
| `errors.ts` | `RivetError` hierarchy (Channel, Memory, Config, Tool, Delegation, Runtime) |
| `utils.ts` | `splitMessage`, `getTextContent`, `hasImages`, tool result helpers |

**Exception:** `ProviderError` and `RivetError` (and subclasses) are classes exported from types. This is the one place types has runtime code — because errors need to be `instanceof`-checkable across package boundaries.

### `@rivetos/boot` (2,364 lines)

The composition root. Loads config, validates, wires everything together, starts the runtime.

| File | Purpose |
|------|---------|
| `config.ts` | YAML config loader with `${ENV_VAR}` resolution |
| `lifecycle.ts` | PID file management, SIGINT/SIGTERM handlers |
| `validate/` | Config schema validation (sections, cross-refs, deployment) |
| `registrars/agents.ts` | Wires delegation, sub-agents, skills |
| `registrars/hooks.ts` | Wires fallback, safety, auto-action, session hooks |
| `registrars/plugins.ts` | Generic manifest-driven loader for all discovered providers, channels, tools, and memory plugins |

**Boot flow:** `loadConfig()` → `validateConfig()` → `discoverPlugins()` → `registerHooks()` → `new Runtime()` → `registerPlugins()` → `registerAgentTools()` → `writePidFile()` → `runtime.start()`

Each plugin package exports `manifest: PluginManifest` from its `index.ts`. `registerPlugins()` calls `manifest.register(ctx)` once per discovered plugin; the plugin owns its config resolution, env-var lookup, and shutdown wiring via the `RegistrationContext`.

**Config shape:** YAML with sections `runtime`, `agents`, `providers`, `channels`, `memory`, `mcp`, `deployment`. See `config.ts` for the full RivetConfig interface.

### `@rivetos/core` (8,534 lines)

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
| `fallback.ts` | 263 | Provider fallback chains (triggered by provider:error hook) |
| `safety-hooks.ts` | 393 | Shell danger detection, workspace fencing, audit logging |
| `auto-actions.ts` | 330 | Auto-format, auto-lint, auto-test, auto-git-check |
| `session-hooks.ts` | 313 | Session start/end, auto-summary, pre/post compaction |
| `heartbeat.ts` | 133 | Scheduled agent execution with quiet hours |
| `circuit-breaker.ts` | 214 | Per-provider circuit breaker (closed → open → half-open) |
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
| `audit-rotation.ts` | ~140 | Log rotation (compress >7d, delete >90d) |

**Logger** (`src/logger.ts`, ~170 lines):
- Two modes: `pretty` (dev, colored) and `json` (production, structured)
- Scoped by component: `logger('Router')` → `[Router] message`
- Levels: error, warn, info, debug
- Set via `RIVETOS_LOG_LEVEL` and `RIVETOS_LOG_FORMAT` env vars
- Understands `RivetError` — extracts code, severity into structured output

### `@rivetos/cli` (6,080 lines)

Every `rivetos <command>` lives here. Lazy-loaded via dynamic import.

| Command | File | Lines | Purpose |
|---------|------|-------|---------|
| `init` | `commands/init/` | ~1,240 | Interactive setup wizard (@clack/prompts) |
| `start` | `commands/start.ts` | 44 | Boot and run |
| `stop` | `commands/stop.ts` | 26 | Kill running instance via PID file |
| `status` | `commands/status.ts` | 173 | Runtime status display |
| `update` | `commands/update.ts` | 481 | Source-based container rebuild |
| `doctor` | `commands/doctor.ts` | 877 | 12-category health check |
| `test` | `commands/test.ts` | 391 | Smoke tests (config, provider, memory, tools) |
| `logs` | `commands/logs.ts` | 270 | Tail runtime logs with filtering |
| `config` | `commands/config.ts` | 158 | Show/validate/edit config |
| `agent` | `commands/agent.ts` | 207 | Add/remove/list agents |
| `model` | `commands/model.ts` | 128 | Show/switch models |
| `build` | `commands/build.ts` | 157 | Build container images |
| `mesh` | `commands/mesh.ts` | 403 | Mesh management (list, ping, join, status) |
| `service` | `commands/service.ts` | 154 | Systemd service management |
| `skills` | `commands/skills.ts` | 368 | Skill management |
| `plugins` | `commands/plugins.ts` | 307 | Plugin listing and status |
| `provider` | `commands/provider.ts` | 321 | Provider-specific commands (setup, status) |
| `login` | `commands/login.ts` | 72 | OAuth login flow |
| `version` | `commands/version.ts` | 25 | Version display |

**Init wizard phases:** `detect` → `deployment` → `agents` → `channels` → `review` → `generate`

### `@rivetos/nx-plugin` (724 lines)

Nx generators for scaffolding new plugins:
```bash
nx generate @rivetos/nx-plugin:plugin --type=provider --name=deepseek
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

**Unified `rivetos` image** (`apps/infra/containers/rivetos/Dockerfile`):
- Single Node 24 Alpine image, non-root user (`rivetos`), tini init
- Built once with `npm run build` (esbuild bundle in `dist/`)
- Dispatched at runtime via `--role agent | datahub | mcp` (entrypoint reads the role and starts the right surface)
- Healthcheck: `wget -qO- http://localhost:3100/health/live` (agent role)
- Workspace and config mounted as volumes

**Legacy split images** (`apps/infra/containers/agent/`, `apps/infra/containers/datahub/`):
- Kept for environments that pin to the old role-specific images
- Datahub image still bundles PostgreSQL 16 + pgvector + shared-dir init scripts
- Shared dirs: `/rivet-shared/plans`, `/rivet-shared/docs`, `/rivet-shared/status`, `/rivet-shared/whiteboard`

### Docker Compose

- `x-agent` YAML anchor for DRY agent service definition
- Named volumes: `rivetos-pgdata`, `rivetos-shared`
- Profiles: default (1 agent), `multi` (3 agents)
- Health check dependency: agents wait for datahub to be healthy

### Memory Workers (Datahub Services)

Embedding and compaction run as **event-driven workers on Datahub**, co-located with Postgres. No agent node runs background memory jobs — the workers are the sole consumers.

```
┌────────────────────────────────────────────────────┐
│  Datahub  —  Postgres 16 + Workers                 │
│                                                    │
│  ┌──────────────────┐  ┌─────────────────────────┐ │
│  │ Embedding Worker  │  │ Compaction Worker        │ │
│  │ LISTEN embed_work │  │ LISTEN compact_work      │ │
│  │ → Embed model     │  │ → Summarization model    │ │
│  │   (GPU endpoint)  │  │   (CPU endpoint)         │ │
│  └──────────────────┘  └─────────────────────────┘ │
│                                                    │
│  Postgres triggers fire on:                        │
│  • INSERT ros_messages  → embed queue + NOTIFY     │
│  • INSERT ros_summaries → embed queue + NOTIFY     │
│  • Message threshold    → compact queue + NOTIFY   │
│  • Session idle (15min) → compact queue + NOTIFY   │
│  • Explicit request     → compact queue + NOTIFY   │
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
1. Message INSERT → Postgres trigger → `ros_embedding_queue` row + `NOTIFY embedding_work`
2. Worker wakes → fetches batch → calls Nemotron on GERTY GPU
3. Writes vector back to source row → deletes queue entry
4. Retries with exponential backoff on transient errors; max 3 attempts per item

**Compaction flow (three trigger paths):**
1. **Message threshold** — Postgres trigger counts unsummarized messages per conversation, enqueues at 50+
2. **Session idle** — 5-minute periodic check finds conversations with no activity for 15 min + 10+ unsummarized messages
3. **Explicit request** — Agent or API inserts directly into `ros_compaction_queue`

Hierarchy: messages → leaf summaries → branch summaries → root summaries (bottom-up). Full thinking enabled on Gemma-4-E2B with generous token budgets (4096/6144/8192) and 10-minute timeout.

**Source:** `plugins/memory/postgres/workers/embedding/` and `plugins/memory/postgres/workers/compaction/`
**Setup:** `apps/infra/containers/datahub/init-db.sh` (schema) + `apps/infra/containers/datahub/setup-workers.sh` (Node.js, systemd). Schema DDL itself lives co-located under `plugins/memory/postgres/schema/` (PR-G).

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
       ├── registerHooks()            # Fallback, safety, auto-action, session hooks
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
| `provider:error` | LLM failure | **Fallback chains** |
| `tool:before` | Before tool execution | **Safety gates**, audit |
| `tool:after` | After tool execution | Auto-format, auto-lint |
| `session:start` | New session | Context loading |
| `session:end` | Session ending | Auto-summary |
| `turn:before` | Before processing | Content filtering |
| `turn:after` | After turn completes | **Review loop**, delegation tracking |
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
- **Files:** kebab-case (`circuit-breaker.ts`, `turn-handler.ts`)
- **Classes:** PascalCase (`AgentLoop`, `DelegationEngine`)
- **Interfaces:** PascalCase, no `I` prefix (`Provider`, not `IProvider`)
- **Types:** PascalCase (`ThinkingLevel`, `DeploymentTarget`)
- **Constants:** UPPER_SNAKE (`SILENT_RESPONSES`, `CORE_FILES`)
- **Loggers:** `const log = logger('ComponentName')`

### Architecture Rules

1. **`types` is the leaf** — everything depends on it, it depends on nothing
2. **Domain layer is pure** — no I/O, no `fs`, no `fetch`. Only interfaces.
3. **Application layer wires I/O** — runtime/, boot/registrars/
4. **Plugins use dynamic import** — boot never statically imports a plugin
5. **Late binding for tools** — coding pipeline gets tool executors as closures, not direct refs
6. **Config is YAML, not code** — all user-facing config in `config.yaml`
7. **Secrets in `.env`** — never in config YAML, never in container images
8. **Containers are stateless** — all data on volumes/bind mounts
9. **One message queue per session** — no shared queues, no race conditions
10. **Hooks are the extension point** — fallbacks, safety, auto-actions all use hooks

### Error Handling

- **RivetError hierarchy** — typed errors with codes, severity, retryable flag
- **ProviderError** — HTTP-aware, triggers fallback chains
- **Circuit breaker** — per-provider, closed → open → half-open
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
  coding_pipeline: { builder_agent, validator_agent, ... }
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

mcp:
  servers:
    memory: { transport: stdio, command: npx, args: [...] }

deployment:             # Optional — drives containerized deployment
  target: docker
  datahub: { postgres: true }
  image: { build_from_source: true }
```

---

## Testing

### Test Framework

- **Vitest 4.x** — fast, TypeScript-native, Node assert compatible
- **Co-located tests** — `foo.ts` → `foo.test.ts`
- **No external test deps** — uses `node:assert/strict`, no chai/jest matchers
- **Run:** `nx run-many -t test` or `nx test @rivetos/core`

### Test Coverage by Package

| Package | Test Files | Lines | Coverage Area |
|---------|-----------|-------|---------------|
| `types` | 1 | 62 | Export verification |
| `boot` | 1 | 784 | Config validation (comprehensive) |
| `core/domain` | 12 | 5,559 | Loop, hooks, delegation, queue, router, skills, safety, etc. |
| `core/runtime` | 1 | 467 | Full turn lifecycle integration |
| `nx-plugin` | 1 | 82 | Generator scaffolding |
| `plugins` | 10 | 1,589 | Channel, tools, MCP, OAuth |
| **Total** | **28** | **8,543** | |

### Untested Areas

- CLI commands (no unit tests — tested manually)
- Infra providers (Docker, Proxmox)
- Container builds
- Memory plugin (tested via integration, no unit tests)
- Streaming manager (tested via runtime integration)

---

## Known Issues & Tech Debt

### Architecture

1. **Compiled bundle now standard** — `npm run build` produces an esbuild bundle in `dist/`. The unified `rivetos` image runs the bundle, not source via `tsx`. Some legacy paths still allow running from source for dev.

2. **Root `package.json` has runtime deps** — `discord.js`, `grammy`, `pg`, `yaml` are in root deps. Should be plugin-scoped only. Currently works because npm workspaces hoist.

3. **Voice plugin lifecycle quirk** — `voice-discord` isn't a Channel, it manages its own lifecycle. With the manifest contract this is now a clean `registerShutdown` call, but the plugin still owns its session lifecycle internally rather than going through the runtime's channel registry.

4. **Per-kind registrars deleted** — `boot/registrars/{providers,channels,tools,memory}.ts` were collapsed into a single manifest-driven `plugins.ts` (PR-B). Any references in user code or external docs to the old per-kind registrars are stale.

5. **Schema lives next to the plugin** — `plugins/memory/postgres/schema/` is the source of truth for SQL DDL (PR-G). Datahub container scripts apply it; nothing under `apps/infra/containers/datahub/` owns schema anymore.

### Config

6. **YAML snake_case vs TypeScript camelCase** — Config uses `default_agent`, types use `defaultAgent`. The mapping happens in `boot/index.ts` manually. No automated snake→camel conversion.

7. **Provider config is untyped** — Each provider's config is `Record<string, unknown>` in the raw config. Type safety is only enforced in the provider constructor.

### Infrastructure

8. **CI builds packages and containers in one pipeline** — `pipeline.yml` runs lint/build/test, then fans out to `publish-npm` and `containers` (matrix: agent + datahub) in parallel, with `notify-ops` gated on both.

9. **Multi-arch container builds not implemented** — Dockerfiles are amd64 only. Buildx for arm64 is planned but not done.

10. **No code-driven IaC layer** — provisioning is fully script-and-Compose driven (`apps/infra/scripts/` + `apps/infra/docker/`). The Pulumi-based `@rivetos/infra` was removed in PR-H; nothing replaces it.

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
| Fallback chains | `packages/core/src/domain/fallback.ts` |
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
