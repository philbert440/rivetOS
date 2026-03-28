# Plugin Development Guide

RivetOS is built on four plugin types: **Providers** (talk to LLMs), **Channels** (send/receive messages), **Tools** (agent capabilities), and **Memory** (persistent storage). This guide shows you how to build each one.

---

## Quick Start: Scaffold a Plugin

```bash
npx nx g @rivetos/nx:plugin
# ? What type of plugin? › channel
# ? What is the plugin name? › slack
# ? Short description: › Slack workspace channel integration
```

This creates a complete plugin skeleton at `plugins/channels/slack/` with package.json, types, and a test file.

---

## Architecture Rules

1. **Depend on `@rivetos/types` only.** Plugins never import from `@rivetos/core`, `@rivetos/boot`, or other plugins.
2. **Export a `createPlugin()` factory.** This is the standard entry point that boot uses to load your plugin.
3. **Declare a `rivetos` manifest in `package.json`.** This enables auto-discovery.
4. **Handle platform concerns internally.** Message splitting, rate limits, API format differences — all inside the plugin.

### Plugin Manifest

Every plugin declares itself in `package.json`:

```json
{
  "name": "@rivetos/channel-slack",
  "rivetos": {
    "type": "channel",
    "name": "slack"
  }
}
```

Boot scans `plugins/*/package.json` for the `rivetos` field. Config determines which plugins actually load. Discovery is automatic, activation is explicit.

---

## Provider Plugin

A provider connects to an LLM and streams responses.

### Interface

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

### Key Methods

- **`chatStream()`** — The primary method. Returns an async iterable of chunks. The AgentLoop always calls this, never `chat()`.
- **`isAvailable()`** — Called on boot to verify the provider is reachable. Return `false` if the API key is missing or the endpoint is down.
- **`getModel()` / `setModel()`** — Runtime model switching (via `/model` command).
- **`chat()`** — Optional synchronous mode. Used by some internal tools. If not implemented, the runtime buffers `chatStream()`.

### LLMChunk Types

```typescript
interface LLMChunk {
  type: 'text' | 'tool_call' | 'thinking' | 'done' | 'error';
  text?: string;           // For 'text' and 'thinking'
  toolCall?: ToolCall;     // For 'tool_call'
  usage?: TokenUsage;      // For 'done'
  error?: string;          // For 'error'
}
```

### Complete Example: Mistral Provider

```typescript
// plugins/providers/mistral/src/index.ts

import type { Provider, Message, LLMChunk, ChatOptions } from '@rivetos/types';

export class MistralProvider implements Provider {
  id = 'mistral';
  name = 'Mistral AI';
  private model: string;
  private apiKey: string;

  constructor(config: { model?: string; api_key?: string }) {
    this.model = config.model ?? 'mistral-large-latest';
    this.apiKey = config.api_key ?? process.env.MISTRAL_API_KEY ?? '';
  }

  async *chatStream(
    messages: Message[],
    options?: ChatOptions,
  ): AsyncIterable<LLMChunk> {
    const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        max_tokens: options?.maxTokens ?? 4096,
        stream: true,
      }),
      signal: options?.signal,  // AbortSignal for /stop support
    });

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') {
          yield { type: 'done' };
          return;
        }

        const chunk = JSON.parse(data);
        const delta = chunk.choices?.[0]?.delta;

        if (delta?.content) {
          yield { type: 'text', text: delta.content };
        }

        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            yield {
              type: 'tool_call',
              toolCall: {
                id: tc.id,
                name: tc.function.name,
                arguments: tc.function.arguments,
              },
            };
          }
        }
      }
    }
  }

  async isAvailable(): Promise<boolean> {
    if (!this.apiKey) return false;
    try {
      const res = await fetch('https://api.mistral.ai/v1/models', {
        headers: { 'Authorization': `Bearer ${this.apiKey}` },
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  getModel(): string { return this.model; }
  setModel(model: string): void { this.model = model; }
}

// Standard factory export
export function createPlugin() {
  return {
    name: 'mistral',
    version: '0.1.0',
    description: 'Mistral AI provider',
    async init() {},
    createProvider(config: Record<string, unknown>) {
      return new MistralProvider(config as { model?: string; api_key?: string });
    },
  };
}
```

### Reference Implementations

| Provider | File | Notable Features |
|---|---|---|
| Anthropic | `plugins/providers/anthropic/` | Extended thinking, OAuth, streaming |
| xAI | `plugins/providers/xai/` | Live search, conversation caching |
| Google | `plugins/providers/google/` | Thought signatures for function calling |
| Ollama | `plugins/providers/ollama/` | Native API, model management |
| OpenAI-compat | `plugins/providers/openai-compat/` | Generic — works with any OpenAI-compatible endpoint |

---

## Channel Plugin

A channel connects to a messaging platform and routes messages to/from the runtime.

### Interface

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
  resolveAttachment?(attachment: unknown): Promise<ResolvedAttachment | null>;
  onMessage(handler: MessageHandler): void;
  onCommand(handler: CommandHandler): void;
}
```

### Key Methods

- **`start()` / `stop()`** — Lifecycle. Connect to the platform on start, disconnect on stop.
- **`send()`** — Send a message. Returns the platform message ID (for later edits). Handle message splitting internally if the text exceeds platform limits.
- **`edit()`** — Edit a previously sent message. The `overflowIds` parameter handles overflow — when edited text is longer than the platform limit, split into continuation messages. Return `EditResult` with primary + overflow IDs.
- **`react()`** — Add an emoji reaction to a message.
- **`onMessage()`** — Register the callback that the runtime calls when a message arrives.
- **`onCommand()`** — Register the callback for slash commands (/stop, /new, etc.).

### Streaming Behavior

The runtime calls `edit()` repeatedly as the LLM streams tokens. Your channel must handle:
- **Throttling** — Don't call the platform API on every token. Discord has rate limits.
- **Message splitting** — If the text grows beyond the platform limit during streaming, split into overflow messages.
- **Typing indicators** — Show typing while the agent is working, stop when done.

### Complete Example: Slack Channel

```typescript
// plugins/channels/slack/src/index.ts

import type {
  Channel, OutboundMessage, EditResult,
  InboundMessage, MessageHandler, CommandHandler
} from '@rivetos/types';

export class SlackChannel implements Channel {
  id = 'slack';
  platform = 'slack';
  private messageHandler?: MessageHandler;
  private commandHandler?: CommandHandler;
  private client: any;  // Slack SDK client

  constructor(private config: { bot_token: string; channel_bindings: Record<string, string> }) {}

  async start(): Promise<void> {
    // Connect to Slack via Socket Mode or Events API
    // Register event handlers
    // Call messageHandler when messages arrive
  }

  async stop(): Promise<void> {
    // Disconnect cleanly
  }

  async send(message: OutboundMessage): Promise<string | null> {
    const result = await this.client.chat.postMessage({
      channel: message.channelId,
      text: message.text,
    });
    return result.ts;  // Slack uses timestamps as message IDs
  }

  async edit(
    channelId: string,
    messageId: string,
    text: string,
    overflowIds?: string[],
  ): Promise<EditResult | null> {
    // Slack messages can be up to 40,000 chars — plenty of room
    await this.client.chat.update({
      channel: channelId,
      ts: messageId,
      text,
    });
    return { primary: messageId, overflow: overflowIds ?? [] };
  }

  async react(messageId: string, emoji: string, channelId: string): Promise<void> {
    await this.client.reactions.add({
      channel: channelId,
      timestamp: messageId,
      name: emoji,
    });
  }

  startTyping(channelId: string): void {
    // Slack doesn't have a typing indicator API
  }

  stopTyping(channelId: string): void {}

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  onCommand(handler: CommandHandler): void {
    this.commandHandler = handler;
  }
}

export function createPlugin() {
  return {
    name: 'slack',
    version: '0.1.0',
    description: 'Slack channel plugin',
    async init() {},
    createChannel(config: Record<string, unknown>) {
      return new SlackChannel(config as { bot_token: string; channel_bindings: Record<string, string> });
    },
  };
}
```

### Reference Implementations

| Channel | File | Notable Features |
|---|---|---|
| Discord | `plugins/channels/discord/` | Streaming edits, overflow handling, reactions, embeds |
| Telegram | `plugins/channels/telegram/` | Owner gate, inline keyboards, 4096-char splitting |
| Agent | `plugins/channels/agent/` | HTTP inter-agent messaging, mesh endpoints |

---

## Tool Plugin

A tool gives the agent a capability — file access, shell commands, web searches, etc.

### Interface

```typescript
interface Tool extends ToolDefinition {
  execute(
    args: Record<string, unknown>,
    signal?: AbortSignal,
    context?: ToolContext,
  ): Promise<ToolResult>;
}

interface ToolDefinition {
  name: string;
  description: string;
  parameters: object;  // JSON Schema
}
```

### Key Details

- **`parameters`** — JSON Schema defining what arguments the tool accepts. The LLM uses this to generate valid calls.
- **`signal`** — `AbortSignal` from the turn's `AbortController`. Respect this for long-running operations — when the user sends `/stop`, the signal fires.
- **`context`** — Runtime context: workspace path, agent name, config, etc.
- **Return type** — `string` for text results, or `ContentPart[]` for multimodal results (text + images).

### Complete Example: Database Query Tool

```typescript
// plugins/tools/database/src/index.ts

import type { Tool, ToolResult, ToolContext, ToolPlugin } from '@rivetos/types';

class DatabaseQueryTool implements Tool {
  name = 'database_query';
  description = 'Execute a read-only SQL query against the configured database.';
  parameters = {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'SQL SELECT query to execute',
      },
      limit: {
        type: 'number',
        description: 'Max rows to return (default: 100)',
      },
    },
    required: ['query'],
  };

  private connectionString: string;

  constructor(config: { connection_string: string }) {
    this.connectionString = config.connection_string;
  }

  async execute(
    args: Record<string, unknown>,
    signal?: AbortSignal,
    context?: ToolContext,
  ): Promise<ToolResult> {
    const query = args.query as string;
    const limit = (args.limit as number) ?? 100;

    // Safety: only allow SELECT queries
    if (!query.trim().toUpperCase().startsWith('SELECT')) {
      return 'Error: Only SELECT queries are allowed.';
    }

    try {
      // Your database query logic here
      const results = await runQuery(this.connectionString, `${query} LIMIT ${limit}`, signal);
      return JSON.stringify(results, null, 2);
    } catch (error) {
      return `Error: ${(error as Error).message}`;
    }
  }
}

// Standard factory export
export function createPlugin(): ToolPlugin {
  return {
    name: 'database',
    version: '0.1.0',
    description: 'Database query tool',
    async init() {},
    getTools() {
      return [new DatabaseQueryTool({ connection_string: process.env.DATABASE_URL ?? '' })];
    },
  };
}
```

### Reference Implementations

| Tool | File | Notable Features |
|---|---|---|
| Shell | `plugins/tools/shell/` | Safety categorization, cwd tracking, timeout |
| File | `plugins/tools/file/` | Read with line numbers, surgical edits, backups |
| Search | `plugins/tools/search/` | Glob and grep with file pattern filtering |
| Web | `plugins/tools/web-search/` | Google CSE + DuckDuckGo fallback, HTML → markdown |
| Interaction | `plugins/tools/interaction/` | ask_user (structured questions), todo (task list) |
| MCP Client | `plugins/tools/mcp-client/` | stdio + HTTP transports, dynamic tool discovery |

---

## Memory Plugin

A memory plugin handles persistent storage and retrieval of conversation history.

### Interface

```typescript
interface Memory {
  append(entry: MemoryEntry): Promise<string>;
  search(query: string, options?: SearchOptions): Promise<MemorySearchResult[]>;
  getContextForTurn(query: string, agent: string, options?: ContextOptions): Promise<string>;
  getSessionHistory(sessionId: string, options?: HistoryOptions): Promise<Message[]>;
  saveSessionSettings?(sessionId: string, settings: Record<string, unknown>): Promise<void>;
  loadSessionSettings?(sessionId: string): Promise<Record<string, unknown> | null>;
}
```

### Key Methods

- **`append()`** — Store a message (user, assistant, tool call, or tool result). Called after every turn.
- **`search()`** — Hybrid search across messages and summaries. Used by `memory_search` tool.
- **`getContextForTurn()`** — Build a context window from recent messages + relevant search results, within a token budget. Called automatically at the start of each turn.
- **`getSessionHistory()`** — Restore conversation history from persistent storage on reconnect.
- **`saveSessionSettings()` / `loadSessionSettings()`** — Optional. Persist per-session settings (model, thinking level, etc.).

### Reference Implementation

The PostgreSQL memory plugin (`plugins/memory/postgres/`) is the reference. It implements:
- Full transcript storage with hybrid FTS + vector search
- Summary DAG (hierarchical compaction)
- Background embedding generation
- Temporal decay scoring (Ebbinghaus reinforcement)
- Review loop for pattern extraction

See [MEMORY-DESIGN.md](MEMORY-DESIGN.md) for the full design.

---

## Registration

Plugins are loaded by boot registrars. The convention-based discovery system finds plugins automatically via the `rivetos` manifest in `package.json`. Config determines which plugins are activated.

### Auto-Discovery Flow

1. Boot scans `plugins/*/package.json` (and any `plugin_dirs` from config)
2. Reads the `rivetos` manifest field from each
3. Builds a registry of available plugins by type and name
4. Config references (e.g., `provider: anthropic`) activate the matching plugin
5. Boot dynamically imports the plugin and calls its factory

### Adding Your Plugin to Config

After creating a plugin, reference it in `config.yaml`:

```yaml
# For a provider plugin named "mistral"
providers:
  mistral:
    model: mistral-large-latest

agents:
  myagent:
    provider: mistral

# For a channel plugin named "slack"
channels:
  slack:
    bot_token: ${SLACK_BOT_TOKEN}
    channel_bindings:
      "C12345": myagent
```

---

## Testing

Every plugin should have co-located tests:

```bash
# Run your plugin's tests
npx nx run provider-mistral:test

# Run with watch mode during development
npx nx run provider-mistral:test --watch

# Run only affected plugins
npx nx affected -t test
```

### Test Pattern

```typescript
// plugins/providers/mistral/src/index.test.ts
import { describe, it, expect } from 'vitest';
import { MistralProvider } from './index.js';

describe('MistralProvider', () => {
  it('should report unavailable without API key', async () => {
    const provider = new MistralProvider({ model: 'test' });
    expect(await provider.isAvailable()).toBe(false);
  });

  it('should return correct model name', () => {
    const provider = new MistralProvider({ model: 'mistral-large-latest' });
    expect(provider.getModel()).toBe('mistral-large-latest');
  });

  it('should support model switching', () => {
    const provider = new MistralProvider({ model: 'mistral-small' });
    provider.setModel('mistral-large-latest');
    expect(provider.getModel()).toBe('mistral-large-latest');
  });
});
```

---

## Package Structure

Every plugin follows this layout:

```
plugins/{category}/{name}/
├── package.json          # @rivetos/{category}-{name}
├── tsconfig.json         # Extends root tsconfig.base.json
├── eslint.config.mjs     # Inherits shared config
└── src/
    ├── index.ts          # Main implementation + createPlugin()
    ├── index.test.ts     # Tests
    └── ...               # Additional files as needed
```

The `package.json` must include:
```json
{
  "name": "@rivetos/provider-mistral",
  "version": "0.1.0",
  "private": true,
  "rivetos": {
    "type": "provider",
    "name": "mistral"
  },
  "dependencies": {
    "@rivetos/types": "workspace:*"
  }
}
```
