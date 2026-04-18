# RivetOS Architecture

## Design Principles

1. **Domain-Driven Design** — Core domain is pure business logic. No framework dependencies, no I/O, no platform specifics. Plugins adapt the outside world to the domain.
2. **Clean Architecture** — Dependencies point inward. Core knows nothing about Telegram, Discord, PostgreSQL, or Anthropic. Plugins know about core, never the reverse.
3. **Stability over features** — LTS releases. A working version stays working.
4. **Own every line** — Apache 2.0 licensed. No CLA, no dual-licensing. Fork-friendly. Patent grant included.
5. **Boring technology** — TypeScript, Node.js, Nx. No experiments in the foundation.
6. **Example-driven extensibility** — Core plugins are the reference implementation. Adding a new channel, provider, or tool should be obvious from reading an existing one.
7. **Container-first deployment** — The container IS the product. Security via isolation, not sandboxing.
8. **Source-based updates** — Pull source → rebuild from source tree (plugins included) → restart. Forks and custom plugins are first-class citizens.

## Clean Architecture Layers

```
┌────────────────────────────────────────────────────────┐
│                    Plugins (Adapters)                  │
│                                                        │
│  Channels    Providers    Memory    Tools              │
│  Telegram    Anthropic    Postgres  Shell              │
│  Discord     Google                 File I/O           │
│  Agent       xAI                    Search (glob/grep) │
│  Voice       Ollama                 Web Search/Fetch   │
│              llama-server           Interaction        │
│                                     MCP Client         │
│                                     Coding Pipeline    │
│                                                        │
│  All plugins implement core interfaces.                │
│  All plugins are replaceable.                          │
│  None are imported by core.                            │
├────────────────────────────────────────────────────────┤
│                  Application Layer                     │
│                                                        │
│  Boot         — composition root, reads YAML config,   │
│                  wires plugins via registrars          │
│  Runtime      — thin compositor, registration,         │
│                  routing, lifecycle                    │
│  TurnHandler  — single message turn processing         │
│  CLI          — rivetos start/stop/status/doctor/      │
│                  init/config/mesh/infra/logs/etc.      │
│                                                        │
│  This layer composes domain + plugins.                 │
│  It is the only layer that knows concrete types.       │
├────────────────────────────────────────────────────────┤
│                    Domain Layer                        │
│                                                        │
│  Agent Loop   — message → LLM → tools → response       │
│  Router       — inbound message → agent → provider     │
│  Workspace    — load/inject workspace files            │
│  Queue        — message ordering, command intercept    │
│  Hooks        — composable pipeline (before/after)     │
│  Delegation   — intra-instance agent-to-agent          │
│  Mesh Deleg.  — cross-instance delegation via HTTP     │
│  Subagent     — child session management               │
│  Skills       — skill discovery and matching           │
│  Heartbeat    — periodic scheduling                    │
│  Safety       — shell danger, workspace fence, audit   │
│  Fallback     — provider fallback chains               │
│  Circuit Break— provider failure tracking, open/close  │
│  Reconnect    — exponential backoff for channels       │
│  Auto-Actions — post-tool automation (format, lint)    │
│  Sessions     — session lifecycle and history          │
│  Mesh         — multi-agent mesh registry + discovery  │
│                                                        │
│  Pure logic. No I/O. Depends only on interfaces        │
│  defined in @rivetos/types.                            │
├────────────────────────────────────────────────────────┤
│                     Types Layer                        │
│                                                        │
│  Provider, Channel, Tool, Memory, Workspace            │
│  Message, ToolCall, InboundMessage, OutboundMessage    │
│  AgentConfig, RuntimeConfig, StreamEvent, HookConfig   │
│  DeploymentConfig, MeshNode, MeshRegistry              │
│  RivetError, ChannelError, MemoryError, ToolError      │
│  SubagentSession, Skill, SkillManager                  │
│                                                        │
│  Interfaces + error classes. Zero dependencies.        │
│  Leaf package. Every other package depends on this.    │
│  Nothing else.                                         │
└────────────────────────────────────────────────────────┘
```

**Dependency Rule:** Every arrow points inward. Plugins depend on types. Domain depends on types. Application depends on domain + types. Nothing depends on plugins.

## Domain Model

### Core Concepts

```
Agent        — a named identity with a provider and workspace config
Turn         — one user message → one assistant response (may include N tool calls)
Session      — a sequence of turns for a given user on a given channel
Workspace    — a directory of markdown files that define agent personality and context
               Core files: CORE.md, USER.md, WORKSPACE.md, MEMORY.md
               Extended:   + CAPABILITIES.md
Transcript   — the permanent, append-only record of all messages across all agents
Mesh         — a fleet of RivetOS instances that can discover and delegate to each other
```

### Value Objects

```
Message      — { role, content, toolCalls?, toolCallId? }
ToolCall     — { id, name, arguments }
ContentPart  — TextPart | ImagePart (multimodal support)
InboundMessage  — platform-normalized incoming message
OutboundMessage — platform-normalized outgoing message
EditResult   — { primary, overflow[] } for multi-message edits
```

### Aggregates

```
AgentLoop    — owns a single turn's execution. Created per turn, not shared.
               Holds: abort controller, steer queue, iteration count.
               Pure: takes interfaces, returns result. No I/O of its own.

Router       — owns agent→provider mapping. Stateless lookup.

Workspace    — owns file loading and system prompt construction.
               Cacheable. Invalidated on file change or explicit clear.

FileMeshRegistry — owns mesh node registration, heartbeat, pruning.
               File-based (mesh.json), syncs across peers.
```

## System Overview

```
┌──────────────────────────────────────────────────────────────┐
│                       RivetOS Runtime                        │
│                                                              │
│  ┌──────────┐    ┌──────────┐    ┌────────────────────────┐  │
│  │ Channels │───>│  Router  │───>│     Turn Handler       │  │
│  │ (plugin) │    │ (domain) │    │     (application)      │  │
│  │          │    │          │    │                        │  │
│  │ Telegram │    │ message  │    │ hooks → media → loop   │  │
│  │ Discord  │    │  → agent │    │  → stream → respond    │  │
│  │ Agent    │    │  → prov  │    │  → memory append       │  │
│  │ Voice    │    │          │    │                        │  │
│  └──────────┘    └──────────┘    └───────────┬────────────┘  │
│       ▲                                      │               │
│       │              ┌───────────────────────┘               │
│       │              ▼                                       │
│  ┌──────────┐    ┌──────────┐    ┌──────────────────────┐    │
│  │ Response │<───│Workspace │    │     Memory           │    │
│  │ sent to  │    │ (domain) │    │    (plugin)          │    │
│  │ channel  │    │          │    │                      │    │
│  │          │    │ CORE.md  │    │ append transcript    │    │
│  │          │    │ USER.md  │    │ search context       │    │
│  │          │    │ MEMORY.md│    │ hybrid FTS+vector    │    │
│  └──────────┘    └──────────┘    └──────────────────────┘    │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │                    Boot Layer                          │  │
│  │                                                        │  │
│  │  Config loader → Registrars → Lifecycle                │  │
│  │                                                        │  │
│  │  registrars/providers.ts  — instantiate providers      │  │
│  │  registrars/channels.ts   — instantiate channels       │  │
│  │  registrars/hooks.ts      — wire safety/fallback/etc   │  │
│  │  registrars/tools.ts      — register all tools         │  │
│  │  registrars/memory.ts     — wire memory backend        │  │
│  │  registrars/agents.ts     — delegation/subagent/skills │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │                Observability Layer                      │ │
│  │                                                         │ │
│  │  Metrics    — turns/min, latency, tokens, errors        │ │
│  │  Health     — GET /health endpoint, full runtime status │ │
│  │  Logger     — structured JSON or pretty-print modes     │ │
│  │  Audit      — append-only log with rotation/retention   │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌───────────────────────────────────────────────────────┐   │
│  │                    Mesh Layer                         │   │
│  │                                                       │   │
│  │  Registry   — mesh.json, heartbeat, pruning           │   │
│  │  Discovery  — seed nodes or mDNS                      │   │
│  │  Delegation — route to remote agents via HTTP         │   │
│  │  Agent Chan — /api/mesh/* endpoints for peer comms    │   │
│  └───────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

## Message Lifecycle

```
1. Channel (plugin) receives inbound message
2. Runtime (application) passes to Router (domain)
3. Router determines: which agent? which provider?
4. Turn Handler creates a turn:
   a. Execute turn:before hooks
   b. Build system prompt from Workspace (domain)
      — Loads CORE.md, USER.md, WORKSPACE.md, MEMORY.md
      — Optionally CAPABILITIES.md for extended context
   c. Resolve attachments via Media module
   d. Create AgentLoop (domain) for this turn:
      i.   Send messages + tools to Provider (plugin) via chatStream()
      ii.  Stream text chunks to channel as they arrive
      iii. If tool calls → execute via Tool (plugin) → append results → go to (i)
      iv.  Check AbortSignal between iterations (/stop)
      v.   Check steer queue between iterations (/steer)
      vi.  Max iteration limit prevents runaway (safety cap)
   e. Execute turn:after hooks
5. Turn Handler sends response back via Channel (plugin)
6. Turn Handler appends user message + response to Memory (plugin)
```

Notice: the domain layer (steps 3, 4d) never touches I/O. It works with interfaces. The application layer (Turn Handler) is the compositor that wires real plugins to domain logic.

## Monorepo Structure

```
rivetOS/
  ARCHITECTURE.md                    ← engineering reference (file-by-file, tech debt)
  ROADMAP.md                         ← release roadmap with build order
  docker-compose.yaml                ← full stack: datahub + agent containers
  .env.example                       ← secret template
  docs/
    ARCHITECTURE.md                  ← this file (design-oriented, for contributors)
    COLLABORATION.md                 ← multi-agent collaboration design
    DECISIONS.md                     ← key design decisions log
    DELEGATION.md                    ← delegation system design
    MEMORY-DESIGN.md                 ← memory system design
    RELEASES.md                      ← release history
    ROADMAP.md                       ← milestone history (M0–M5)
  infra/containers/
    agent/
      Dockerfile                     ← multi-stage, non-root, tini, healthcheck
      project.json                   ← Nx build target
    datahub/
      Dockerfile                     ← postgres + pgvector + shared dirs
      init-db.sh                     ← database initialization
      init-shared.sh                 ← shared directory setup
      project.json                   ← Nx build target
    DATA-PERSISTENCE.md              ← data persistence model documentation
  infra/
    src/
      index.ts                       ← entry point, reads config, picks provider
      orchestrator.ts                ← deploy/preview/destroy orchestration
      components/
        index.ts                     ← abstract component interfaces
        types.ts                     ← infrastructure types
      providers/
        docker/                      ← Docker Compose deployment
        proxmox/                     ← Proxmox LXC deployment
    package.json
    project.json
    tsconfig.json
  .github/
    workflows/
      ci.yml                         ← PR: lint+test, merge: build, release: publish
      containers.yml                 ← container image builds
  packages/
    types/                           ← interfaces only, zero deps
      src/
        index.ts                     ← all exports
        message.ts                   ← Message, ToolCall, ContentPart, TextPart, ImagePart
        provider.ts                  ← Provider, LLMResponse, LLMChunk, ChatOptions, ProviderError
        channel.ts                   ← Channel, InboundMessage, OutboundMessage, EditResult
        tool.ts                      ← Tool, ToolDefinition, ToolContext, ToolResult
        plugin.ts                    ← Plugin, PluginConfig
        memory.ts                    ← Memory, MemoryEntry, MemorySearchResult
        workspace.ts                 ← Workspace, WorkspaceFile
        config.ts                    ← AgentConfig, RuntimeConfig, HookConfig
        deployment.ts                ← DeploymentConfig, DockerConfig, ProxmoxConfig, KubernetesConfig
        events.ts                    ← StreamEvent, SessionState, DelegationRequest, TokenUsage
        hooks.ts                     ← HookEventName, HookContext variants, HookPipeline
        errors.ts                    ← RivetError, ChannelError, MemoryError, ConfigError, ToolError, etc.
        mesh.ts                      ← MeshNode, MeshRegistry, MeshConfig, MeshDelegationRoute
        skill.ts                     ← Skill, SkillManager
        subagent.ts                  ← SubagentSession, SubagentSpawnRequest, SubagentManager
        utils.ts                     ← splitMessage, getTextContent, hasImages, etc.
    core/                            ← domain + application layer
      src/
        domain/
          loop.ts                    ← AgentLoop — the turn executor
          router.ts                  ← Router — message → agent → provider
          workspace.ts               ← WorkspaceLoader — file loading + prompt building
          queue.ts                   ← MessageQueue — ordering, dedup, command intercept
          hooks.ts                   ← HookPipelineImpl — composable async pipeline
          delegation.ts              ← DelegationEngine — intra-instance delegation
          mesh-delegation.ts         ← MeshDelegationEngine — cross-instance via HTTP
          mesh.ts                    ← FileMeshRegistry — file-based mesh registry
          subagent.ts                ← SubagentManagerImpl — child sessions
          skills/                    ← Skill system (7 files)
            index.ts                 ← barrel exports
            manager.ts               ← SkillManagerImpl — discovery, matching, embedding
            list-tool.ts             ← skill_list tool
            manage-tool.ts           ← skill_manage tool
            manage-actions.ts        ← create/edit/patch/delete/retire actions
            manage-helpers.ts        ← changelog, dedup, validation helpers
            frontmatter.ts           ← YAML frontmatter parsing
            security.ts              ← skill content validation
          heartbeat.ts               ← HeartbeatRunner — periodic scheduling
          safety-hooks.ts            ← Shell danger, workspace fence, audit, custom rules
          fallback.ts                ← Provider fallback chains
          circuit-breaker.ts         ← Provider failure tracking, open/half-open/closed
          reconnect.ts               ← ReconnectionManager — exponential backoff
          auto-actions.ts            ← Post-tool automation (format, lint, test, git check)
          session-hooks.ts           ← Session lifecycle hooks (summary, auto-commit)
          constants.ts               ← SILENT_RESPONSES and shared constants
        runtime/
          runtime.ts                 ← Runtime — thin compositor, registration, lifecycle
          turn-handler.ts            ← TurnHandler — single turn processing
          media.ts                   ← Attachment resolution, download, multimodal
          streaming.ts               ← StreamManager — stream events → channel
          sessions.ts                ← SessionManager — session lifecycle and history
          commands.ts                ← CommandHandler — slash commands (/stop, /steer, /new)
          health.ts                  ← HealthServer — GET /health endpoint
          metrics.ts                 ← Runtime metrics collector
          index.ts                   ← Module barrel exports
        security/
          secrets.ts                 ← redactSecrets, ensureEnvPermissions, 1Password resolution
          audit-rotation.ts          ← Audit log rotation, compression, retention
        logger.ts                    ← Structured logger (JSON + pretty modes)
        runtime.ts                   ← Backward-compat re-export → runtime/runtime.ts
        index.ts                     ← Package exports (everything above)
    boot/                            ← composition root
      src/
        index.ts                     ← boot() — load config, call registrars, start
        config.ts                    ← Config loader (YAML → typed config, env var resolution)
        lifecycle.ts                 ← PID file, signals, shutdown
        validate/
          index.ts                   ← validateConfig() entry point
          sections.ts                ← Per-section validators
          cross-refs.ts              ← Cross-reference validation (agent→provider, bindings)
          deployment.ts              ← Deployment config validation
          types.ts                   ← Validation result types
        registrars/
          providers.ts               ← Instantiate and register providers
          channels.ts                ← Instantiate and register channels
          hooks.ts                   ← Wire safety, fallback, auto-actions, sessions, learning
          tools.ts                   ← Register all tool plugins
          memory.ts                  ← Wire memory backend
          agents.ts                  ← Delegation, subagent, skills registration
    cli/                             ← command-line interface
      src/
        index.ts                     ← Entry point, command router
        commands/
          init.ts                    ← Legacy init (directory + default config)
          init/                      ← Interactive wizard (6 phases)
            index.ts                 ← wizard entry point
            wizard.ts                ← phase orchestrator
            types.ts                 ← WizardState, AgentConfig, ChannelConfig
            detect.ts                ← environment detection
            deployment.ts            ← deployment target selection
            agents.ts                ← agent configuration
            channels.ts              ← channel configuration
            review.ts                ← review & confirm
            generate.ts              ← write config + .env
          start.ts                   ← rivetos start
          stop.ts                    ← rivetos stop
          status.ts                  ← rivetos status (enhanced with metrics)
          doctor.ts                  ← rivetos doctor (12 check categories)
          test.ts                    ← rivetos test (smoke test suite)
          update.ts                  ← rivetos update (source-based container rebuild)
          build.ts                   ← rivetos build (container image build)
          config.ts                  ← rivetos config (reopen wizard)
          agent.ts                   ← rivetos agent add/remove/list
          logs.ts                    ← rivetos logs (tail agent output)
          mesh.ts                    ← rivetos mesh list/ping/status/join
          infra.ts                   ← rivetos infra up/preview/destroy
          login.ts                   ← rivetos login (Anthropic OAuth)
          model.ts                   ← rivetos model (switch models)
          provider.ts                ← rivetos provider (manage providers)
          plugins.ts                 ← rivetos plugins (list/info)
          service.ts                 ← rivetos service install/uninstall (systemd)
          skills.ts                  ← rivetos skills list
          version.ts                 ← rivetos version
    nx-plugin/                       ← custom Nx generators/executors (if needed)
  plugins/
    channels/
      telegram/                      ← grammY, Telegram Bot API
        src/
          index.ts                   ← TelegramChannel implementation
          format.ts                  ← Markdown → Telegram HTML formatting
      discord/                       ← discord.js v14
        src/
          index.ts                   ← DiscordChannel implementation
      agent/                         ← HTTP agent-to-agent channel + mesh endpoints
        src/
          index.ts                   ← AgentChannel with /api/mesh/* routes
      voice-discord/                 ← xAI Realtime API + Discord voice
        src/
          index.ts                   ← entry point
          plugin.ts                  ← VoicePlugin orchestrator
          voice-session.ts           ← per-channel voice session management
          xai-client.ts              ← xAI Realtime WebSocket client
          audio-player.ts            ← Opus audio encoding/decoding
          transcript.ts              ← Speech-to-text transcript handling
    providers/
      anthropic/                     ← Claude (native Messages API + OAuth)
        src/
          index.ts                   ← AnthropicProvider with extended thinking
      google/                        ← Gemini (Generative Language API)
        src/
          index.ts                   ← GoogleProvider
      xai/                           ← Grok
        src/
          index.ts                   ← XAIProvider
      ollama/                        ← Ollama (native API)
        src/
          index.ts                   ← OllamaProvider
      llama-server/                  ← llama.cpp server (native API)
        src/
          index.ts                   ← OpenAICompatProvider
    memory/
      postgres/                      ← Full transcript + hybrid search + summary DAG
        src/
          adapter.ts                 ← PostgresMemory — implements Memory interface
          search.ts                  ← Hybrid FTS + vector search with scoring
          scoring.ts                 ← Search result relevance scoring
          embedder.ts                ← OpenAI embedding generation + queue
          expand.ts                  ← Summary expansion (drill into source messages)
          review-loop.ts             ← Learning loop: reflect → synthesize → store
          compactor/                 ← Summary DAG (3 files)
            index.ts                 ← barrel
            compactor.ts             ← CompactionEngine — hierarchical summarization
            types.ts                 ← compaction types
          tools/                     ← Memory-as-tools (4 files)
            index.ts                 ← barrel
            search-tool.ts           ← memory_search tool
            browse-tool.ts           ← memory_browse tool
            stats-tool.ts            ← memory_stats tool
            helpers.ts               ← shared tool helpers
          migrate.ts                 ← Schema migration (v1)
          migrate-v2.ts              ← Schema migration (v2 — embeddings, summaries)
          index.ts                   ← barrel exports
    tools/
      shell/                         ← Shell command execution with safety
      file/                          ← file_read, file_write, file_edit (3 tool files)
      search/                        ← search_glob, search_grep (2 tool files)
      web-search/                    ← internet_search, web_fetch
      interaction/                   ← ask_user, todo (2 tool files)
      mcp-client/                    ← MCP server connection + tool discovery
      coding-pipeline/               ← Build → review → validate loop
  skills/                            ← Optional per-instance skills
```

Every plugin directory includes a README.md that serves as documentation AND a guide for writing your own. The reference plugins ARE the documentation.

## Plugin Interfaces

### Provider — talks to an LLM

```typescript
interface Provider {
  id: string;
  name: string;
  chatStream(messages: Message[], options?: ChatOptions): AsyncIterable<LLMChunk>;
  chat?(messages: Message[], options?: ChatOptions): Promise<LLMResponse>;
  isAvailable(): Promise<boolean>;
  getModel(): string;
  setModel(model: string): void;
}
```

The primary method is `chatStream()` — streaming is the default path. `chat()` is optional for providers that support a non-streaming mode. `getModel()`/`setModel()` allow runtime model switching.

Reference implementation: `plugins/providers/anthropic/`

### Channel — receives and sends messages

```typescript
interface Channel {
  id: string;
  platform: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(message: OutboundMessage): Promise<string | null>;
  edit?(channelId: string, messageId: string, text: string, overflowIds?: string[]): Promise<EditResult | null>;
  react?(messageId: string, emoji: string, channelId: string): Promise<void>;
  startTyping?(channelId: string): void;
  stopTyping?(channelId: string): void;
  onMessage(handler: MessageHandler): void;
  onCommand(handler: CommandHandler): void;
}
```

Key details:
- `send()` takes a full `OutboundMessage` object (not separate text/channelId params)
- `edit()` supports overflow — when edited text exceeds platform limits, the channel handles splitting internally. Returns `EditResult` with primary + overflow message IDs.
- Message splitting, typing indicators, and platform limits are the channel's responsibility
- No `maxMessageLength` on the interface — channels handle this internally

Reference implementation: `plugins/channels/telegram/`

### Tool — an action the agent can take

```typescript
interface Tool extends ToolDefinition {
  execute(
    args: Record<string, unknown>,
    signal?: AbortSignal,
    context?: ToolContext,
  ): Promise<ToolResult>;
}
```

Tools extend `ToolDefinition` (name, description, parameters JSON schema). The `signal` parameter enables abort propagation from `/stop` commands. `context` provides the tool with runtime info (workspace path, agent name, etc.).

Reference implementation: `plugins/tools/shell/`

### Memory — persistent storage and retrieval

```typescript
interface Memory {
  append(entry: MemoryEntry): Promise<string>;
  search(query: string, options?: { agent?: string; limit?: number; scope?: 'messages' | 'summaries' | 'both' }): Promise<MemorySearchResult[]>;
  getContextForTurn(query: string, agent: string, options?: { maxTokens?: number }): Promise<string>;
  getSessionHistory(sessionId: string, options?: { limit?: number }): Promise<Message[]>;
  saveSessionSettings?(sessionId: string, settings: Record<string, unknown>): Promise<void>;
  loadSessionSettings?(sessionId: string): Promise<Record<string, unknown> | null>;
}
```

`getContextForTurn()` builds a context window from recent messages + relevant search results, within a token budget. `getSessionHistory()` restores conversation history from persistent storage on reconnect. Session settings persistence is optional.

Reference implementation: `plugins/memory/postgres/`

## Routing Model

### Static binding

```yaml
channels:
  discord:
    channel_bindings:
      "channel_id_1": opus
      "channel_id_2": grok
```

Message arrives in channel → agent determined by binding → provider determined by agent config.

### Inter-agent messaging (local)

Agent channel plugin (`@rivetos/channel-agent`) exposes an HTTP endpoint. Agents send messages to peers via the `delegate_task` or `subagent_spawn` tools. Incoming agent messages are processed through the full pipeline — memory, hooks, tools, everything.

### Inter-agent messaging (mesh)

`MeshDelegationEngine` extends delegation across instances. When a `delegate_task` targets an agent not available locally, the mesh registry is consulted to find the remote node hosting that agent. Delegation happens transparently via HTTP to the remote agent channel endpoint.

## Interrupt Model

### /stop — Abort current turn
- Each turn creates an `AbortController`
- `/stop` calls `abort()` on it
- `AbortSignal` passed to:
  - Provider `chatStream()` (cancels HTTP request via fetch signal)
  - Tool `execute()` (cancels shell commands, etc.)
  - Checked between tool iterations in AgentLoop
- Response: immediate. No queue delays.

### /steer — Inject mid-turn context
- Pushes a message onto the AgentLoop's steer queue
- Agent sees it as a system message on the next tool iteration
- Use case: "hey, also check X while you're at it"

### /new — Fresh session
- Aborts active turn (if any)
- Clears in-memory conversation history
- Transcript in postgres is unaffected (it's permanent)

### Why this works
AbortController is synchronous signal propagation. When you say stop, the fetch call is cancelled mid-flight. No queue modes, no message coalescing, no waiting for the current turn to finish.

## Hook System

Composable async pipeline with priority ordering (0-99):

**Lifecycle events:** `provider:before`, `provider:after`, `provider:error`, `tool:before`, `tool:after`, `turn:before`, `turn:after`, `turn:reflect`, `skill:before`, `skill:after`, `session:start`, `session:end`, `compact:before`, `compact:after`, `delegation:before`, `delegation:after`

**Built-in hooks (wired via boot registrars):**
- **Safety hooks** — Shell danger blocker (P10), workspace fence (P15), custom rules (P20), audit logger (P90)
- **Fallback chains** — Cross-provider failover on 429/503/timeout with circuit breaker integration
- **Auto-actions** — Post-tool format/lint/test/git-check (opt-in)
- **Session hooks** — Daily context loading, session summaries, auto-commit, pre/post-compact

## Configuration

YAML with `${ENV_VAR}` resolution. API keys always via environment variables.

```yaml
runtime:
  workspace: ~/.rivetos/workspace
  default_agent: opus
  max_tool_iterations: 75

agents:
  opus:
    provider: anthropic
    default_thinking: medium
    fallbacks: ['google:gemini-2.5-pro']
  grok:
    provider: xai

providers:
  anthropic:
    model: claude-sonnet-4-20250514
  xai:
    model: grok-4-1-fast-reasoning

channels:
  telegram:
    owner_id: "your-telegram-user-id"
  discord:
    channel_bindings:
      "channel_id": opus

memory:
  postgres:
    connection_string: ${RIVETOS_PG_URL}

# Optional: containerized deployment
deployment:
  target: docker                    # or proxmox, kubernetes, manual
  datahub:
    postgres: true
    shared_storage: true
  image:
    build_from_source: true
  docker:
    network: rivetos
```

## Deployment Model

### Container-First Architecture

RivetOS ships as container images built from source. The container IS the security boundary — agents can only touch what's inside their container.

**Data persistence:** Containers are stateless. All persistent data lives on the host via bind mounts and named volumes:
- `./workspace/` → agent workspace files (CORE.md, memory/, skills/)
- `rivetos-pgdata` → PostgreSQL data
- `rivetos-shared` → shared storage (/rivet-shared/)
- `.env` → API keys and secrets
- `rivet.config.yaml` → deployment configuration

**Update model:** Pull source → rebuild containers from source tree → restart. Plugins live in the source tree and survive updates automatically.

### Deployment Targets

| Target | Implementation | Use Case |
|--------|---------------|----------|
| Docker | Docker Compose | Desktop, single-server, getting started |
| Proxmox | Pulumi + LXC | Homelab, multi-node |
| Kubernetes | Pulumi + K8s (future) | Cloud, production scale |
| Manual | No infra management | User handles their own setup |

### Infrastructure Abstraction

```typescript
// Abstract components — providers implement these
interface RivetAgentComponent { ... }
interface RivetDatahubComponent { ... }

// Docker provider: generates docker-compose, runs it
// Proxmox provider: creates LXC containers via API
// K8s provider: creates Deployments + Services + PVCs
```

The `infra/` package reads `rivet.config.yaml`, selects the appropriate provider, and orchestrates deployment. CLI commands: `rivetos infra up/preview/destroy`.

## Multi-Agent Mesh

Multiple RivetOS instances can form a mesh for cross-instance collaboration:

- **Registry:** File-based `mesh.json` with heartbeat and pruning
- **Discovery:** Seed nodes or mDNS-based auto-discovery
- **Delegation:** Transparent routing — `delegate_task` checks local agents first, then mesh peers
- **Join flow:** `rivetos init --join <host>` discovers existing datahub and registers with the mesh
- **Fleet updates:** `rivetos update --mesh` rolls updates across all mesh nodes with health checks

## LTS Strategy

- **main** branch: current development
- **lts/X.Y** branches: frozen releases
  - Security patches and bug fixes only
  - No new features, no breaking changes
  - Maintained for 12 months minimum
- Semantic versioning: MAJOR.MINOR.PATCH
