# Plugin Development Guide

RivetOS supports five plugin types: **Providers** (talk to LLMs), **Channels** (send/receive messages), **Tools** (agent capabilities), **Memory** (persistent storage), and **Transports** (expose RivetOS to external clients). Every plugin uses the same self-registration contract.

---

## Quick Start: Scaffold a Plugin

```bash
npx rivetos plugin init
# or directly:
npx nx g @rivetos/nx:plugin
# ? What type of plugin? › channel
# ? What is the plugin name? › slack
```

This creates `plugins/{category}/{name}/` with `package.json`, `tsconfig.json`, `src/index.ts`, and a test file.

---

## Architecture Rules

1. **Depend on `@rivetos/types` only.** Plugins do not import from `@rivetos/core` or `@rivetos/boot`. (The memory plugin's workers and the MCP server transport are exceptions because they ship binaries that run outside the runtime.)
2. **Export a `manifest: PluginManifest` const.** This is the entry point boot uses.
3. **Declare `package.json#rivetos`.** This is what discovery reads — without importing the package.
4. **Handle platform concerns internally.** Message splitting, rate limits, API quirks — all inside the plugin.

### `package.json#rivetos`

```json
{
  "name": "@rivetos/channel-slack",
  "rivetos": {
    "type": "channel",
    "name": "slack"
  }
}
```

Boot scans every `plugins/*/*/package.json` (and any `plugin_dirs` from config). The descriptor's `type` and `name` must match the exported `manifest`.

---

## The Manifest Contract

```typescript
import type { PluginManifest, RegistrationContext } from '@rivetos/types'

export const manifest: PluginManifest = {
  type: 'provider',           // 'provider' | 'channel' | 'tool' | 'memory' | 'transport'
  name: 'mistral',
  async register(ctx: RegistrationContext) {
    // 1. Read your config slice
    const cfg = ctx.pluginConfig as { model?: string; api_key?: string } | undefined
    const apiKey = cfg?.api_key ?? ctx.env.MISTRAL_API_KEY ?? ''

    // 2. Construct your plugin
    const provider = new MistralProvider({ model: cfg?.model ?? 'mistral-large-latest', apiKey })

    // 3. Register with the runtime
    ctx.registerProvider(provider)

    // 4. (Optional) Register cleanup
    ctx.registerShutdown(() => provider.close())
  },
}
```

`RegistrationContext` exposes:

| Member | Purpose |
|---|---|
| `config` | Full validated `RivetConfig` (cast in your plugin if you need it) |
| `pluginConfig` | The slice for this plugin — `config.providers[name]`, `config.channels[name]`, `config.memory[name]`, `config.transports[name]`. `undefined` for tool plugins (tools read from `config` directly when needed). |
| `env` | `process.env` snapshot |
| `workspaceDir` | Resolved workspace path |
| `logger` | Scoped logger (`debug` / `info` / `warn` / `error`) |
| `registerProvider` / `registerChannel` / `registerTool` / `registerMemory` | Hand instances to the runtime |
| `registerHook(hook)` | Subscribe to lifecycle events |
| `registerShutdown(fn)` | Called during graceful shutdown |
| `lateBindTool(name)` | Returns a closure that resolves a tool at execution time — used by composite tools (e.g. coding-pipeline) when registration order isn't guaranteed |
| `onRegistrationComplete(fn)` | Fires once after every plugin has registered. Receives `{ tools }`. Used by transports to enumerate the finalized tool set before opening their listening socket. |

Boot has **no per-plugin knowledge.** Every kind of plugin goes through the same loader (`packages/boot/src/registrars/plugins.ts`).

### Activation

A plugin is *discovered* by `package.json#rivetos`, but only *activated* when:

- **Provider / channel / memory / transport** — its name appears in the matching config section (`config.providers[name]`, `config.channels[name]`, `config.memory[name]`, `config.transports[name]`). Channels also accept a legacy alias: `voice-discord` matches `config.channels.voice`.
- **Tool** — always activated (tools decide internally whether their config is sufficient — e.g. `mcp-client` skips itself when no servers are configured).

---

## Provider Plugin

```typescript
interface Provider {
  id: string
  name: string
  chatStream(messages: Message[], options?: ChatOptions): AsyncIterable<LLMChunk>
  chat?(messages: Message[], options?: ChatOptions): Promise<LLMResponse>
  isAvailable(): Promise<boolean>
  getModel(): string
  setModel(model: string): void
}
```

The AgentLoop always calls `chatStream()`. `chat()` is optional. `getModel()` / `setModel()` enable runtime model switching via `/model`.

### `LLMChunk`

```typescript
interface LLMChunk {
  type: 'text' | 'tool_call' | 'thinking' | 'done' | 'error'
  text?: string
  toolCall?: ToolCall
  usage?: TokenUsage
  error?: string
}
```

### Reference implementations

| Provider | Path | Notable |
|---|---|---|
| Anthropic | `plugins/providers/anthropic/` | Adaptive thinking, prompt caching |
| xAI | `plugins/providers/xai/` | Live search, conversation caching |
| Google | `plugins/providers/google/` | Thought signatures for function calling |
| Ollama | `plugins/providers/ollama/` | Native API |
| llama-server | `plugins/providers/llama-server/` | Native llama.cpp (mirostat, typical_p, `<think>`) |
| openai-compat | `plugins/providers/openai-compat/` | Strict OpenAI servers (vLLM/TGI/Groq); folds mid-conversation system messages, consumes native `reasoning_content` |
| claude-cli | `plugins/providers/claude-cli/` | Drives the `claude` binary via stream-json; embedded MCP bridge for hybrid tools |

---

## Channel Plugin

```typescript
interface Channel {
  id: string
  platform: string
  start(): Promise<void>
  stop(): Promise<void>
  send(message: OutboundMessage): Promise<string | null>
  edit?(channelId, messageId, text, overflowIds?): Promise<EditResult | null>
  react?(messageId, emoji, channelId): Promise<void>
  startTyping?(channelId): void
  stopTyping?(channelId): void
  resolveAttachment?(attachment): Promise<ResolvedAttachment | null>
  onMessage(handler: MessageHandler): void
  onCommand(handler: CommandHandler): void
}
```

The runtime calls `edit()` repeatedly while streaming. Channels handle:

- **Throttling** — don't hit the platform on every token
- **Splitting** — when text exceeds the platform limit, split into overflow messages and report the IDs back via `EditResult`
- **Typing** — show while the agent is working

### Reference implementations

| Channel | Path | Notable |
|---|---|---|
| Discord | `plugins/channels/discord/` | Streaming edits, overflow, reactions, embeds |
| Telegram | `plugins/channels/telegram/` | Owner gate, inline keyboards, 4096-char splitting |
| Agent | `plugins/channels/agent/` | HTTPS/mTLS inter-agent + mesh endpoints |
| Voice (Discord) | `plugins/channels/voice-discord/` | xAI Realtime API + Opus codec |

---

## Tool Plugin

```typescript
interface Tool extends ToolDefinition {
  execute(args, signal?, context?): Promise<ToolResult>
}

interface ToolDefinition {
  name: string
  description: string
  parameters: object  // JSON Schema
}
```

- `signal` — `AbortSignal` from the turn. Honor it.
- `context` — workspace path, agent name, config, etc.
- `ToolResult` — `string` for text, `ContentPart[]` for multimodal (text + images).

### Reference implementations

| Tool plugin | Tools registered | Notable |
|---|---|---|
| `tool-shell` | `shell` | Safety categorization, cwd tracking, timeout |
| `tool-file` | `file_read`, `file_write`, `file_edit` | Surgical edits, line numbers, optional backups |
| `tool-search` | `search_glob`, `search_grep` | Glob and grep with file pattern filtering |
| `tool-web-search` | `internet_search`, `web_fetch` | Google CSE + DuckDuckGo fallback, HTML → markdown |
| `tool-interaction` | `ask_user`, `todo` | Structured questions, session-scoped task list |
| `tool-mcp-client` | dynamic | Connects to MCP servers (stdio + HTTP), exposes their tools |
| `tool-coding-pipeline` | `coding_pipeline` | Build → review → validate loop. Uses `lateBindTool` to call delegation/sub-agent tools without hard-coding registration order. |

The memory plugin (`@rivetos/memory-postgres`) additionally registers `memory_search`, `memory_browse`, `memory_stats`. Delegation, sub-agents, and skill management add `delegate_task`, `subagent_*`, and `skill_*` tools at runtime.

---

## Memory Plugin

```typescript
interface Memory {
  append(entry: MemoryEntry): Promise<string>
  search(query, options?): Promise<MemorySearchResult[]>
  getContextForTurn(query, agent, options?): Promise<string>
  getSessionHistory(sessionId, options?): Promise<Message[]>
  saveSessionSettings?(sessionId, settings): Promise<void>
  loadSessionSettings?(sessionId): Promise<Record<string, unknown> | null>
}
```

The PostgreSQL memory plugin (`plugins/memory/postgres/`) is the reference. It implements full transcript storage, hybrid FTS + vector search, summary DAG (hierarchical compaction), event-driven embedding/compaction workers (running as Datahub services on Postgres `LISTEN`/`NOTIFY`), temporal decay scoring, and a review loop for pattern extraction. SQL DDL lives co-located in `plugins/memory/postgres/schema/`.

See [MEMORY-DESIGN.md](MEMORY-DESIGN.md) for the full design.

---

## Transport Plugin

Transports expose RivetOS to external clients. They have no `core` interface — the plugin opens its own listening surface (HTTP, stdio, gRPC, …) inside `manifest.register()`.

```typescript
export const manifest: PluginManifest = {
  type: 'transport',
  name: 'mcp',
  async register(ctx) {
    const cfg = ctx.pluginConfig ?? {}
    const server = createMcpServer(cfg)

    // Defer binding until every other plugin has registered, so the
    // transport sees the full tool set.
    ctx.onRegistrationComplete(async ({ tools }) => {
      server.registerTools(tools)
      await server.listen()
    })

    ctx.registerShutdown(() => server.close())
  },
}
```

Activate via `config.transports.<name>`:

```yaml
transports:
  mcp:
    port: 4321
    tls: true
```

Reference: `plugins/transports/mcp-server/` — a StreamableHTTP MCP server exposing `memory_*`, `web_*`, `skill_*`, and runtime tools to external MCP clients.

---

## Testing

```bash
npx nx run provider-mistral:test       # one plugin
npx nx affected -t test                # only what changed
```

Co-locate tests next to source: `src/index.ts` → `src/index.test.ts`. The framework is Vitest.

---

## Package Structure

```
plugins/{category}/{name}/
├── package.json          # @rivetos/{category}-{name} (or @rivetos/{name} for transports)
├── tsconfig.json         # extends ../../../tsconfig.base.json
├── eslint.config.mjs     # inherits shared config
└── src/
    ├── index.ts          # exports `manifest` + your impl
    ├── index.test.ts
    └── ...
```

`package.json` must include the `rivetos` descriptor:

```json
{
  "name": "@rivetos/provider-mistral",
  "version": "0.4.0-beta.x",
  "private": true,
  "rivetos": { "type": "provider", "name": "mistral" },
  "dependencies": { "@rivetos/types": "workspace:*" }
}
```
