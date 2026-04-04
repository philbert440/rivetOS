# RivetOS

**Lightweight, stable agent runtime. Apache 2.0 licensed.**

> Zero bloat. Zero lock-in. Just the loop.

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-24%2B-green.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org)

RivetOS is a personal AI agent runtime built for reliability. A tiny, stable core routes messages between channels and LLM providers. Everything else is a plugin.

## Features

- **Clean Core** — Minimal runtime that routes messages, executes tools, and manages lifecycle. Platform-agnostic.
- **Streaming-first** — `AsyncIterable<LLMChunk>` from every provider. See responses as they generate.
- **Plugin everything** — Channels, providers, memory, tools — all swappable via clean interfaces.
- **6 providers** — Anthropic (with OAuth), Google Gemini, xAI Grok, Ollama, OpenAI-compatible.
- **Multi-agent** — Delegation (intra-instance), subagent sessions, cross-instance HTTP messaging.
- **Hook system** — Async composable pipeline for safety, auto-actions, fallback chains, session lifecycle.
- **11 coreutils** — Shell, file read/write/edit, glob, grep, web search, web fetch, ask user, todo, memory.
- **Full control surface** — `/stop`, `/interrupt`, `/steer`, `/new`, `/status`, `/model`, `/think`, `/reasoning`.
- **Interrupt that works** — `AbortController` propagated to every API call and tool. When you say stop, it stops.
- **Session persistence** — Conversations survive restarts. `/new` is the only thing that clears history.
- **Thinking control** — Toggle reasoning depth per-turn: off, low, medium, high.
- **LTS releases** — Pin a version. It won't break for 12 months.
- **Apache 2.0 licensed** — No CLA, no dual-licensing, no surprises. Patent grant included.

## Quick Start

```bash
git clone https://github.com/philbert440/rivetOS.git
cd rivetOS
npm install

# Generate default config
rivetos init

# Authenticate with Anthropic (Claude subscription)
rivetos login

# Start the runtime
rivetos start
```

## Architecture

```
┌───────────────────────────────────────────────────────────┐
│                      Plugins (Adapters)                    │
│                                                           │
│  Channels       Providers       Memory       Tools         │
│  Telegram       Anthropic       Postgres     Shell         │
│  Discord        Google Gemini                File I/O      │
│  Agent (HTTP)   xAI Grok                    Search        │
│  Voice          Ollama                       Web           │
│                 OpenAI-compat                Interaction   │
│                                              MCP Client   │
│  Plugins implement @rivetos/types.                        │
│  Plugins depend on types only. No cross-plugin imports.   │
├───────────────────────────────────────────────────────────┤
│                   Composition Layer                        │
│                                                           │
│  Boot    — reads config, registers plugins                 │
│  CLI     — rivetos start/stop/status/doctor/init           │
├───────────────────────────────────────────────────────────┤
│                   Application Layer                        │
│                                                           │
│  Runtime       — thin compositor: registration + routing   │
│  TurnHandler   — single message turn processing            │
│  Media         — attachment resolution + multimodal        │
│  StreamManager — stream events → channel delivery          │
├───────────────────────────────────────────────────────────┤
│                     Domain Layer                           │
│                                                           │
│  AgentLoop · Router · Workspace · HookPipeline · Queue     │
│  Delegation · Subagent · Skills · Heartbeat · Fallback     │
│  Pure logic. No I/O. Depends only on @rivetos/types.       │
├───────────────────────────────────────────────────────────┤
│                      Types Layer                           │
│                                                           │
│  Provider · Channel · Tool · Memory · Workspace · Plugin   │
│  Interfaces only. Zero dependencies.                       │
└───────────────────────────────────────────────────────────┘
```

**Dependency rule:** Everything points inward. Plugins → Types. Domain → Types. Nothing depends on plugins.

## Plugins

| Package | Type | Description |
|---------|------|-------------|
| `@rivetos/provider-anthropic` | Provider | Claude models with OAuth subscription auth + API key |
| `@rivetos/provider-google` | Provider | Gemini models via Generative Language API |
| `@rivetos/provider-xai` | Provider | Grok models with conversation caching |
| `@rivetos/provider-ollama` | Provider | Native Ollama API with model management |
| `@rivetos/provider-openai-compat` | Provider | Any OpenAI-compatible endpoint (llama-server, vLLM, etc.) |
| `@rivetos/channel-telegram` | Channel | Telegram Bot API via grammY |
| `@rivetos/channel-discord` | Channel | Discord via discord.js v14 |
| `@rivetos/channel-agent` | Channel | HTTP endpoint for agent-to-agent messaging |
| `@rivetos/channel-voice-discord` | Channel | xAI Realtime API (WIP) |
| `@rivetos/memory-postgres` | Memory | Full transcript + hybrid FTS/semantic search + summary DAG |
| `@rivetos/tool-shell` | Tool | Shell execution with command categorization + safety |
| `@rivetos/tool-file` | Tool | File read/write/edit with backup + safety rails |
| `@rivetos/tool-search` | Tool | Glob + grep file discovery and content search |
| `@rivetos/tool-web-search` | Tool | Web search (Google + DuckDuckGo) + web fetch (HTML → markdown) |
| `@rivetos/tool-interaction` | Tool | ask_user (structured questions) + todo (task list) |
| `@rivetos/tool-mcp-client` | Tool | Connect to MCP servers (stdio/HTTP/SSE), discover + use tools |
| `@rivetos/tool-coding-pipeline` | Tool | Build → review → validate coding loop |

## Configuration

```yaml
# ~/.rivetos/config.yaml
runtime:
  workspace: ~/.rivetos/workspace
  default_agent: opus
  max_tool_iterations: 15

agents:
  opus:
    provider: anthropic
    default_thinking: medium
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
      "channel-id": opus

memory:
  postgres:
    # connection_string via RIVETOS_PG_URL env var
```

API keys always via environment variables. Never in config files.

## CLI

```
rivetos start [--config <path>]     Start the runtime
rivetos stop                        Stop the running instance
rivetos status                      Show runtime status
rivetos doctor                      Check config and connectivity
rivetos init                        First-run setup
rivetos login                       OAuth login for Anthropic
rivetos config validate             Dry-run config validation
rivetos logs                        Tail runtime logs
rivetos skills list                 Show discovered skills
rivetos plugins list                Show loaded plugins
rivetos version                     Show version
```

## Workspace Files

RivetOS injects markdown files from your workspace into the agent's system prompt:

| File | Purpose |
|------|---------|
| `SOUL.md` | Agent personality and behavior |
| `IDENTITY.md` | Who the agent is |
| `USER.md` | Who the owner is |
| `AGENTS.md` | Operating instructions |
| `TOOLS.md` | Tool usage notes |
| `MEMORY.md` | Long-term curated memory |
| `memory/YYYY-MM-DD.md` | Daily notes |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache License 2.0](LICENSE)

---

[rivetos.dev](https://rivetos.dev) · [GitHub](https://github.com/philbert440/rivetOS)
