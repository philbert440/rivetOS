# RivetOS Architecture

## Design Principles

1. **Domain-Driven Design** — Core domain is pure business logic. No framework dependencies, no I/O, no platform specifics. Plugins adapt the outside world to the domain.
2. **Clean Architecture** — Dependencies point inward. Core knows nothing about Telegram, Discord, PostgreSQL, or Anthropic. Plugins know about core, never the reverse.
3. **Stability over features** — LTS releases. A working version stays working.
4. **Own every line** — Apache 2.0 licensed. No CLA, no dual-licensing. Fork-friendly. Patent grant included.
5. **Boring technology** — TypeScript, Node.js, Nx. No experiments in the foundation.
6. **Example-driven extensibility** — Core plugins are the reference implementation. Adding a new channel, provider, or tool should be obvious from reading an existing one.

## Clean Architecture Layers

```
┌─────────────────────────────────────────────────────┐
│                    Plugins (Adapters)                │
│                                                     │
│  Channels    Providers    Memory    Tools            │
│  Telegram    Anthropic    Postgres  Shell            │
│  Discord     Google                 File I/O         │
│  Agent       xAI                    Search (glob/grep)│
│  Voice       Ollama                 Web Search/Fetch  │
│  CLI         OpenAI-compat         Interaction        │
│                                    MCP Client         │
│                                    Coding Pipeline    │
│                                                     │
│  All plugins implement core interfaces.             │
│  All plugins are replaceable.                       │
│  None are imported by core.                         │
├─────────────────────────────────────────────────────┤
│                  Application Layer                   │
│                                                     │
│  Boot         — composition root, reads YAML config, │
│                  wires plugins via registrars         │
│  Runtime      — thin compositor, registration,       │
│                  routing, lifecycle                   │
│  TurnHandler  — single message turn processing       │
│  CLI          — rivetos start/stop/status/doctor      │
│                                                     │
│  This layer composes domain + plugins.              │
│  It is the only layer that knows concrete types.    │
├─────────────────────────────────────────────────────┤
│                    Domain Layer                       │
│                                                     │
│  Agent Loop   — message → LLM → tools → response    │
│  Router       — inbound message → agent → provider   │
│  Workspace    — load/inject workspace files          │
│  Queue        — message ordering, command intercept  │
│  Hooks        — composable pipeline (before/after)   │
│  Delegation   — intra-instance agent-to-agent        │
│  Subagent     — child session management             │
│  Skills       — skill discovery and matching         │
│  Heartbeat    — periodic scheduling                  │
│  Safety       — shell danger, workspace fence, audit │
│  Fallback     — provider fallback chains             │
│  Auto-Actions — post-tool automation (format, lint)  │
│  Sessions     — session lifecycle and history        │
│                                                     │
│  Pure logic. No I/O. Depends only on interfaces     │
│  defined in @rivetos/types.                         │
├─────────────────────────────────────────────────────┤
│                     Types Layer                      │
│                                                     │
│  Provider, Channel, Tool, Memory, Workspace          │
│  Message, ToolCall, InboundMessage, OutboundMessage  │
│  AgentConfig, RuntimeConfig, StreamEvent, HookConfig │
│                                                     │
│  Interfaces only. Zero dependencies. Leaf package.  │
│  Every other package depends on this. Nothing else. │
└─────────────────────────────────────────────────────┘
```

**Dependency Rule:** Every arrow points inward. Plugins depend on types. Domain depends on types. Application depends on domain + types. Nothing depends on plugins.

## Domain Model

### Core Concepts

```
Agent        — a named identity with a provider and workspace config
Turn         — one user message → one assistant response (may include N tool calls)
Session      — a sequence of turns for a given user on a given channel
Workspace    — a directory of markdown files that define agent personality and context
Transcript   — the permanent, append-only record of all messages across all agents
```

### Value Objects

```
Message      — { role, content, toolCalls?, toolCallId? }
ToolCall     — { id, name, arguments }
InboundMessage  — platform-normalized incoming message
OutboundMessage — platform-normalized outgoing message
```

### Aggregates

```
AgentLoop    — owns a single turn's execution. Created per turn, not shared.
               Holds: abort controller, steer queue, iteration count.
               Pure: takes interfaces, returns result. No I/O of its own.

Router       — owns agent→provider mapping. Stateless lookup.

Workspace    — owns file loading and system prompt construction.
               Cacheable. Invalidated on file change or explicit clear.
```

## System Overview

```
┌──────────────────────────────────────────────────────────────┐
│                       RivetOS Runtime                         │
│                                                               │
│  ┌──────────┐    ┌──────────┐    ┌────────────────────────┐  │
│  │ Channels │───▶│  Router  │───▶│     Turn Handler       │  │
│  │ (plugin) │    │ (domain) │    │     (application)      │  │
│  │          │    │          │    │                         │  │
│  │ Telegram │    │ message  │    │ hooks → media → loop   │  │
│  │ Discord  │    │  → agent │    │  → stream → respond    │  │
│  │ Agent    │    │  → prov  │    │  → memory append       │  │
│  │ Voice    │    │          │    │                         │  │
│  │ CLI      │    │          │    │ Delegates to AgentLoop  │  │
│  └──────────┘    └──────────┘    └───────────┬────────────┘  │
│       ▲                                       │               │
│       │              ┌────────────────────────┘               │
│       │              ▼                                        │
│  ┌──────────┐    ┌──────────┐    ┌──────────────────────┐    │
│  │ Response │◀───│Workspace │    │     Memory            │    │
│  │ sent to  │    │ (domain) │    │    (plugin)           │    │
│  │ channel  │    │          │    │                       │    │
│  │          │    │ SOUL.md  │    │ append transcript      │    │
│  │          │    │ AGENTS.md│    │ search context         │    │
│  │          │    │ memory/  │    │ hybrid FTS+vector      │    │
│  └──────────┘    └──────────┘    └──────────────────────┘    │
│                                                               │
│  ┌──────────────────────────────────────────────────────┐    │
│  │                    Boot Layer                         │    │
│  │                                                      │    │
│  │  Config loader → Registrars → Lifecycle              │    │
│  │                                                      │    │
│  │  registrars/providers.ts  — instantiate providers     │    │
│  │  registrars/channels.ts   — instantiate channels      │    │
│  │  registrars/hooks.ts      — wire safety/fallback/etc  │    │
│  │  registrars/tools.ts      — register all tools        │    │
│  │  registrars/memory.ts     — wire memory backend       │    │
│  │  registrars/agents.ts     — delegation/subagent/skills│    │
│  └──────────────────────────────────────────────────────┘    │
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
   c. Resolve attachments via Media module
   d. Create AgentLoop (domain) for this turn:
      i.   Send messages + tools to Provider (plugin)
      ii.  If text response → stream to channel
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
  docs/                              ← architecture, design docs
  packages/
    types/                           ← interfaces only, zero deps
      src/
        index.ts                     ← all exports
        message.ts                   ← Message, ToolCall, ContentPart
        provider.ts                  ← Provider, LLMResponse, StreamEvent
        channel.ts                   ← Channel, InboundMessage, OutboundMessage
        tool.ts                      ← Tool, ToolDefinition, ToolResult
        memory.ts                    ← Memory, MemoryEntry, MemorySearchResult
        workspace.ts                 ← Workspace, WorkspaceFile
        config.ts                    ← AgentConfig, RuntimeConfig, HookConfig
        events.ts                    ← StreamEvent, StreamHandler
    core/                            ← domain + application layer
      src/
        domain/
          loop.ts                    ← AgentLoop — the turn executor
          router.ts                  ← Router — message → agent → provider
          workspace.ts               ← WorkspaceLoader — file loading + prompt building
          queue.ts                   ← MessageQueue — ordering, dedup
          hooks.ts                   ← HookPipelineImpl — composable async pipeline
          delegation.ts              ← DelegationEngine — intra-instance delegation
          subagent.ts                ← SubagentManagerImpl — child sessions
          skills.ts                  ← SkillManager — discovery and matching
          heartbeat.ts               ← HeartbeatRunner — periodic scheduling
          safety-hooks.ts            ← Shell danger, workspace fence, audit
          fallback.ts                ← Provider fallback chains
          auto-actions.ts            ← Post-tool automation
          session-hooks.ts           ← Session lifecycle hooks
          constants.ts               ← Shared constants
        runtime/
          runtime.ts                 ← Runtime — thin compositor, registration
          turn-handler.ts            ← TurnHandler — single turn processing
          media.ts                   ← Attachment resolution, download, multimodal
          streaming.ts               ← StreamManager — stream events → channel
          sessions.ts                ← Session lifecycle and history
          commands.ts                ← Slash command processing
          index.ts                   ← Public API
        index.ts                     ← Package exports
    boot/                            ← composition root
      src/
        index.ts                     ← boot() — load config, call registrars, start
        config.ts                    ← Config loader (YAML → RuntimeConfig)
        validate.ts                  ← Config schema validation
        lifecycle.ts                 ← PID file, signals, shutdown
        registrars/
          providers.ts               ← Instantiate and register providers
          channels.ts                ← Instantiate and register channels
          hooks.ts                   ← Wire safety, fallback, auto-actions, sessions
          tools.ts                   ← Register all tool plugins
          memory.ts                  ← Wire memory backend
          agents.ts                  ← Delegation, subagent, skills registration
    cli/                             ← command-line interface
      src/
        index.ts                     ← Entry point
        commands/                    ← start, stop, status, doctor, config, etc.
  plugins/
    channels/
      telegram/                      ← grammY, Telegram Bot API
      discord/                       ← discord.js v14
      agent/                         ← HTTP agent-to-agent channel
      voice-discord/                 ← xAI Realtime API
    providers/
      anthropic/                     ← Claude (native Messages API + OAuth)
      google/                        ← Gemini (Generative Language API)
      xai/                           ← Grok
      ollama/                        ← Ollama (native API)
      openai-compat/                 ← Any OpenAI-compatible endpoint
    memory/
      postgres/                      ← Full transcript + hybrid search + summary DAG
    tools/
      shell/                         ← Shell command execution with safety
      file/                          ← file_read, file_write, file_edit
      search/                        ← search_glob, search_grep
      web-search/                    ← web_search, web_fetch
      interaction/                   ← ask_user, todo
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
  chat(messages: Message[], tools?: ToolDefinition[], options?: ProviderOptions): Promise<LLMResponse>;
  stream(messages: Message[], tools?: ToolDefinition[], options?: ProviderOptions): AsyncIterable<StreamEvent>;
  isAvailable(): Promise<boolean>;
}
```

Reference implementation: `plugins/providers/anthropic/`

### Channel — receives and sends messages

```typescript
interface Channel {
  id: string;
  platform: string;
  maxMessageLength?: number;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(channelId: string, text: string, options?: SendOptions): Promise<string | null>;
  edit(messageId: string, text: string, channelId: string): Promise<string | null>;
  react?(messageId: string, emoji: string, channelId: string): Promise<void>;
  startTyping?(channelId: string): void;
  stopTyping?(channelId: string): void;
  onMessage(handler: MessageHandler): void;
  onCommand(handler: CommandHandler): void;
}
```

Message splitting and typing indicators are the channel's responsibility — each plugin handles its own platform limits internally. The runtime never knows about message length or typing refresh intervals.

Reference implementation: `plugins/channels/telegram/`

### Tool — an action the agent can take

```typescript
interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}
```

Reference implementation: `plugins/tools/shell/`

### Memory — persistent storage and retrieval

```typescript
interface Memory {
  append(entry: MemoryEntry): Promise<string>;
  search(query: string, options?: SearchOptions): Promise<MemorySearchResult[]>;
  getContextForTurn(query: string, agent: string, options?: ContextOptions): Promise<string>;
}
```

Reference implementation: `plugins/memory/postgres/`

## Routing Model

### Static binding (current)

```yaml
channels:
  discord:
    channel_bindings:
      "channel_id_1": opus
      "channel_id_2": grok
```

Message arrives in channel → agent determined by binding → provider determined by agent config.

### Inter-agent messaging

Agent channel plugin (`@rivetos/channel-agent`) exposes an HTTP endpoint. Agents send messages to peers via the `agent_message` tool. Incoming agent messages are processed through the full pipeline — memory, hooks, tools, everything.

## Interrupt Model

### /stop — Abort current turn
- Each turn creates an `AbortController`
- `/stop` calls `abort()` on it
- `AbortSignal` passed to:
  - Provider `chat()` (cancels HTTP request via fetch signal)
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

**Lifecycle events:** `provider:before`, `provider:after`, `provider:error`, `tool:before`, `tool:after`, `turn:before`, `turn:after`, `session:start`, `session:end`, `compact:before`, `compact:after`, `delegation:before`, `delegation:after`

**Built-in hooks (wired via boot registrars):**
- **Safety hooks** — Shell danger blocker (P10), workspace fence (P15), custom rules (P20), audit logger (P90)
- **Fallback chains** — Cross-provider failover on 429/503/timeout
- **Auto-actions** — Post-tool format/lint/test (opt-in)
- **Session hooks** — Daily context loading, session summaries, auto-commit

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
    model: claude-opus-4-6
  xai:
    model: grok-4-1-fast

channels:
  telegram:
    owner_id: "your-telegram-user-id"
  discord:
    channel_bindings:
      "channel_id": opus

memory:
  postgres:
    connection_string: ${RIVETOS_PG_URL}
```

## LTS Strategy

- **main** branch: current development
- **lts/X.Y** branches: frozen releases
  - Security patches and bug fixes only
  - No new features, no breaking changes
  - Maintained for 12 months minimum
- Semantic versioning: MAJOR.MINOR.PATCH
