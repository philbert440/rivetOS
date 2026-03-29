# RivetOS Architecture

## Design Principles

1. **Domain-Driven Design** — Core domain is pure business logic. No framework dependencies, no I/O, no platform specifics. Plugins adapt the outside world to the domain.
2. **Clean Architecture** — Dependencies point inward. Core knows nothing about Telegram, Discord, PostgreSQL, or Anthropic. Plugins know about core, never the reverse.
3. **Stability over features** — LTS releases. A working version stays working.
4. **Own every line** — MIT licensed. No CLA, no dual-licensing. Fork-friendly.
5. **Boring technology** — TypeScript, Node.js, Nx. No experiments in the foundation.
6. **Example-driven extensibility** — Core plugins are the reference implementation. Adding a new channel, provider, or tool should be obvious from reading an existing one.

## Clean Architecture Layers

```
┌─────────────────────────────────────────────────────┐
│                    Plugins (Adapters)                │
│                                                     │
│  Channels    Providers    Memory    Tools            │
│  Telegram    Anthropic    Postgres  Shell            │
│  Discord     xAI         (future)  Web Search       │
│  CLI         Ollama                File I/O          │
│  Voice       OpenAI-compat         Coding Pipeline   │
│                                                     │
│  All plugins implement core interfaces.             │
│  All plugins are replaceable.                       │
│  None are imported by core.                         │
├─────────────────────────────────────────────────────┤
│                  Application Layer                   │
│                                                     │
│  Runtime         — orchestrates startup, shutdown,   │
│                    wires plugins together             │
│  Config Loader   — reads TOML, resolves env vars,    │
│                    instantiates plugins               │
│                                                     │
│  This layer composes domain + plugins.              │
│  It is the only layer that knows concrete types.    │
├─────────────────────────────────────────────────────┤
│                    Domain Layer                       │
│                                                     │
│  Agent Loop      — message → LLM → tools → response │
│  Router          — inbound message → agent → provider│
│  Workspace       — load/inject workspace files       │
│  Lifecycle       — start, stop, interrupt, steer     │
│                                                     │
│  Pure logic. No I/O. Depends only on interfaces     │
│  defined in @rivetos/types.                         │
├─────────────────────────────────────────────────────┤
│                     Types Layer                      │
│                                                     │
│  Provider, Channel, Tool, Memory, Workspace          │
│  Message, ToolCall, InboundMessage, OutboundMessage  │
│  AgentConfig, RuntimeConfig, StreamEvent             │
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
┌─────────────────────────────────────────────────────────┐
│                      RivetOS Runtime                     │
│                                                          │
│  ┌──────────┐    ┌──────────┐    ┌──────────────────┐   │
│  │ Channels │───▶│  Router  │───▶│   Agent Loop     │   │
│  │ (plugin) │    │ (domain) │    │   (domain)       │   │
│  │          │    │          │    │                   │   │
│  │ Telegram │    │ message  │    │ build context     │   │
│  │ Discord  │    │  → agent │    │ call provider     │   │
│  │ CLI      │    │  → prov  │    │ execute tools     │   │
│  │ Voice    │    │          │    │ check abort/steer │   │
│  └──────────┘    └──────────┘    └────────┬──────────┘   │
│       ▲                                    │              │
│       │              ┌─────────────────────┘              │
│       │              ▼                                    │
│  ┌──────────┐    ┌──────────┐    ┌──────────────────┐   │
│  │ Response │◀───│Workspace │    │     Memory        │   │
│  │ sent to  │    │ (domain) │    │    (plugin)       │   │
│  │ channel  │    │          │    │                   │   │
│  │          │    │ SOUL.md  │    │ append transcript  │   │
│  │          │    │ AGENTS.md│    │ search context     │   │
│  │          │    │ memory/  │    │ hybrid FTS+vector  │   │
│  └──────────┘    └──────────┘    └──────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

## Message Lifecycle

```
1. Channel (plugin) receives inbound message
2. Runtime (application) passes to Router (domain)
3. Router determines: which agent? which provider?
4. Runtime asks Workspace (domain) to build system prompt
5. Runtime asks Memory (plugin) for relevant transcript context
6. Runtime creates AgentLoop (domain) for this turn:
   a. Send messages + tools to Provider (plugin)
   b. If text response → done
   c. If tool calls → execute via Tool (plugin) → append results → go to (a)
   d. Check AbortSignal between iterations (/stop)
   e. Check steer queue between iterations (/steer)
   f. Max iteration limit prevents runaway
7. Runtime sends response back via Channel (plugin)
8. Runtime appends user message + response to Memory (plugin)
```

Notice: the domain layer (steps 3, 4, 6) never touches I/O. It works with interfaces. The application layer (Runtime) is the compositor that wires real plugins to domain logic.

## Monorepo Structure

```
rivetOS/
  docs/                              ← architecture, guides
  packages/
    types/                           ← interfaces only, zero deps
      src/
        index.ts                     ← all exports
        message.ts                   ← Message, ToolCall
        provider.ts                  ← Provider, LLMResponse
        channel.ts                   ← Channel, InboundMessage, OutboundMessage
        tool.ts                      ← Tool, ToolDefinition
        memory.ts                    ← Memory, MemoryEntry, MemorySearchResult
        workspace.ts                 ← Workspace, WorkspaceFile
        config.ts                    ← AgentConfig, RuntimeConfig
        events.ts                    ← StreamEvent, StreamHandler
    core/                            ← domain + application layer
      src/
        domain/
          loop.ts                    ← AgentLoop — the turn executor
          router.ts                  ← Router — message → agent → provider
          workspace.ts               ← WorkspaceLoader — file loading + prompt building
        runtime.ts                   ← Runtime — the compositor/orchestrator
        config.ts                    ← Config loader (TOML → RuntimeConfig)
        index.ts                     ← public API
  plugins/
    channels/
      telegram/                      ← grammY, Telegram Bot API
        src/index.ts
        README.md                    ← how to add a channel (reference example)
      discord/                       ← discord.js v14
      voice-discord/                 ← xAI Realtime API
      cli/                           ← local terminal (dev/testing)
    providers/
      anthropic/                     ← Claude (native Messages API)
        src/index.ts
        README.md                    ← how to add a provider (reference example)
      xai/                           ← Grok
      ollama/                        ← Ollama (native API)
      openai-compat/                 ← Any OpenAI-compatible endpoint
    memory/
      postgres/                      ← full transcript + hybrid search
        src/index.ts
        README.md                    ← how to add a memory backend
    tools/
      shell/                         ← shell command execution
      file/                          ← file read/write/search
      web-search/                    ← web search
      web-fetch/                     ← URL fetch + extraction
      coding-pipeline/               ← build → review → validate loop
```

Every plugin directory includes a README.md that serves as documentation AND a guide for writing your own. The reference plugins ARE the documentation.

## Plugin Interfaces

### Provider — talks to an LLM

```typescript
interface Provider {
  id: string;
  name: string;
  chat(messages: Message[], tools?: ToolDefinition[], signal?: AbortSignal): Promise<LLMResponse>;
  isAvailable(): Promise<boolean>;
}
```

Reference implementation: `plugins/providers/anthropic/`

### Channel — receives and sends messages

```typescript
interface Channel {
  id: string;
  platform: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(message: OutboundMessage): Promise<string | null>;
  onMessage(handler: (message: InboundMessage) => Promise<void>): void;
  onCommand(handler: (command: string, args: string, message: InboundMessage) => Promise<void>): void;
}
```

Reference implementation: `plugins/channels/telegram/`

### Tool — an action the agent can take

```typescript
interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<string>;
}
```

Reference implementation: `plugins/tools/shell/`

### Memory — persistent storage and retrieval

```typescript
interface Memory {
  append(entry: MemoryEntry): Promise<string>;
  search(query: string, options?: { agent?: string; limit?: number }): Promise<MemorySearchResult[]>;
  getContextForTurn(query: string, agent: string, options?: { maxTokens?: number }): Promise<string>;
}
```

Reference implementation: `plugins/memory/postgres/`

## Routing Model

### Current: Static binding

```toml
[channels.discord]
channel_bindings = { "channel_id_1" = "opus", "channel_id_2" = "grok" }
```

Message arrives in channel → agent determined by binding → provider determined by agent config.

### Future (if needed): Smart routing

Query classification → tier → provider. Only build this when static routing isn't enough.

## Interrupt Model

The thing that broke OpenClaw. Getting this right matters.

### /stop — Abort current turn
- Each turn creates an `AbortController`
- `/stop` calls `abort()` on it
- `AbortSignal` passed to:
  - Provider `chat()` (cancels HTTP request via fetch signal)
  - Tool `execute()` (cancels shell commands, etc.)
  - Checked between tool iterations in AgentLoop
- Response: immediate. No queue delays. No "processing, please wait."

### /steer — Inject mid-turn context
- Pushes a message onto the AgentLoop's steer queue
- Agent sees it as a system message on the next tool iteration
- Use case: "hey, also check X while you're at it"

### /new — Fresh session
- Aborts active turn (if any)
- Clears in-memory conversation history
- Transcript in postgres is unaffected (it's permanent)

### Why this works where OpenClaw failed
OpenClaw's interrupt model was built on queue modes (collect/steer/interrupt) that coalesced messages and processed them after the current turn. When the current turn was stuck in a long exec call, /stop went into the queue and waited. RivetOS skips the queue entirely — AbortController is synchronous signal propagation. When you say stop, the fetch call is cancelled mid-flight.

## Configuration

TOML. Not JSON (too fragile), not YAML (too ambiguous).

```toml
[runtime]
workspace = "~/.rivetos/workspace"
default_agent = "opus"
max_tool_iterations = 15

[agents.opus]
provider = "anthropic"

[agents.grok]
provider = "xai"

[agents.local]
provider = "ollama"

[providers.anthropic]
model = "claude-opus-4-6"
max_tokens = 8192
# api_key via env: ANTHROPIC_API_KEY

[providers.xai]
model = "grok-4-1-fast"
# api_key via env: XAI_API_KEY

[providers.ollama]
base_url = "http://localhost:11434"
model = "qwen3.5:27b"

[channels.telegram]
# bot_token via env: TELEGRAM_BOT_TOKEN
owner_id = "8093148723"
allowed_users = ["8093148723"]

[channels.discord]
# bot_token via env: DISCORD_BOT_TOKEN
owner_id = "..."
channel_bindings = { "ch1" = "opus", "ch2" = "grok" }

[memory.postgres]
# connection_string via env: RIVETOS_PG_URL
```

**Rule: API keys and secrets always via environment variables. Never in config files.**

## LTS Strategy

- **main** branch: current development
- **lts/X.Y** branches: frozen releases
  - Security patches and bug fixes only
  - No new features, no breaking changes
  - Maintained for 12 months minimum
- Semantic versioning: MAJOR.MINOR.PATCH

## Open Questions

1. **Config format** — TOML vs YAML?
2. **Heartbeat/cron** — Core domain or plugin?
3. **Multi-instance** — One process with multiple agents, or one process per agent?
4. **Streaming** — Stream LLM responses to channels in real-time, or wait for complete?
5. **Plugin discovery** — Explicit in config, or auto-discover from plugins/ directory?
6. **Existing data** — Migration for 66K messages in phil_memory?
7. **Voice** — Same process or separate? Different resource profile (WebSocket, audio).
8. **Web dashboard** — Yes / no / later?
9. **File watching** — Hot-reload workspace files on change, or restart only?
10. **Session persistence** — History survives restarts (from postgres), or fresh each time?
