# RivetOS

**Lightweight, stable agent runtime. Apache 2.0 licensed.**

> Zero bloat. Zero lock-in. Just the loop.

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-24%2B-green.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org)

RivetOS is a personal AI agent runtime built for reliability. A tiny, stable core routes messages between channels and LLM providers. Everything else is a plugin.

## Features

- **Clean Core** — A minimal runtime that routes messages, executes tools, and manages lifecycle. Platform-specific concerns stay in plugins.
- **Streaming-first** — `AsyncIterable<StreamEvent>` from every provider. See responses as they generate.
- **Plugin everything** — Channels, providers, memory, tools — all swappable via clean interfaces.
- **5 providers** — Anthropic (with OAuth subscription auth), Google Gemini, xAI Grok, Ollama, OpenAI-compatible.
- **4 channels** — Telegram, Discord, Agent (HTTP inter-agent), Voice (xAI Realtime).
- **11 tool plugins** — Shell, file I/O, search, web, interaction, MCP client, coding pipeline.
- **Hook system** — Composable async pipeline for safety, fallback chains, auto-actions, session lifecycle.
- **Multi-agent** — Intra-instance delegation + cross-instance messaging via HTTP.
- **Full control surface** — `/stop`, `/interrupt`, `/steer`, `/new`, `/status`, `/model`, `/think`, `/reasoning`.
- **Interrupt that works** — `AbortController` propagated to every API call and tool. When you say stop, it stops.
- **Session persistence** — Conversations survive restarts. `/new` is the only thing that clears history.
- **Thinking control** — Toggle reasoning depth per-turn: off, low, medium, high.
- **Type-safe monorepo** — 21 packages, all typecheck independently via `tsc --noEmit`.
- **LTS releases** — Pin a version. It won't break for 12 months.
- **Apache 2.0 licensed** — No CLA, no dual-licensing, no surprises. Patent grant included.

## Quick Start

```bash
git clone https://github.com/philbert440/rivetOS.git
cd rivetOS
npm install

# Generate default config
rivetos config init

# Authenticate with Anthropic (Claude subscription)
rivetos anthropic setup

# Start the runtime
rivetos start
```

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                     Plugins (Adapters)                │
│                                                      │
│  Channels    Providers    Memory       Tools          │
│  ─────────   ──────────  ──────────   ──────         │
│  Telegram    Anthropic   Postgres     Shell           │
│  Discord     Google                   File I/O        │
│  Agent       xAI                      Search          │
│  Voice       Ollama                   Web Search/Fetch│
│              OpenAI-compat            Interaction     │
│                                       MCP Client      │
│                                       Coding Pipeline │
│                                                      │
│  Plugins implement core interfaces.                  │
│  Plugins depend on @rivetos/types only.              │
├──────────────────────────────────────────────────────┤
│                   Application Layer                   │
│                                                      │
│  Boot        — composition root, registrars           │
│  Runtime     — thin compositor, registration          │
│  TurnHandler — hooks → media → loop → respond         │
│  CLI         — rivetos start/stop/status/doctor       │
├──────────────────────────────────────────────────────┤
│                     Domain Layer                      │
│                                                      │
│  AgentLoop   — message → LLM → tools → response      │
│  Router      — inbound message → agent → provider     │
│  Workspace   — SOUL.md, AGENTS.md → system prompt     │
│  Hooks       — composable async pipeline              │
│  Queue       — message ordering, command interception  │
├──────────────────────────────────────────────────────┤
│                      Types Layer                      │
│                                                      │
│  Provider, Channel, Tool, Memory, Workspace           │
│  Interfaces only. Zero dependencies.                  │
└──────────────────────────────────────────────────────┘
```

**Dependency rule:** Everything points inward. Plugins → Types. Domain → Types. Nothing depends on plugins.

## Plugins

### Channels

| Plugin | Description |
|--------|-------------|
| `channel-telegram` | Telegram Bot API via grammY. Typing indicators, inline buttons, reactions, message splitting at 4096 chars. |
| `channel-discord` | Discord.js v14. Typing indicators, message splitting at 2000 chars, channel bindings. |
| `channel-agent` | HTTP endpoint for inter-agent messaging. Sync and async modes, shared secret auth, health endpoint. |
| `channel-voice-discord` | xAI Realtime API for voice interaction. |

### Providers

| Plugin | Description |
|--------|-------------|
| `provider-anthropic` | Claude models with OAuth subscription auth + API key support. |
| `provider-google` | Gemini models via Generative Language API. |
| `provider-xai` | Grok models with conversation caching. |
| `provider-ollama` | Native Ollama API with model management. |
| `provider-openai-compat` | Any OpenAI-compatible endpoint (llama-server, vLLM, LM Studio, etc.). |

### Tools

| Plugin | Description |
|--------|-------------|
| `tool-shell` | Shell command execution with safety categorization (read-only/write/dangerous). |
| `tool-file` | `file_read`, `file_write`, `file_edit` with line numbers, backups, surgical edits. |
| `tool-search` | `search_glob` and `search_grep` for file discovery and content search. |
| `tool-web-search` | `web_search` (Google + DuckDuckGo fallback) and `web_fetch` (HTML → markdown). |
| `tool-interaction` | `ask_user` (structured questions) and `todo` (task list). |
| `tool-mcp-client` | Connect to MCP servers via stdio/HTTP/SSE, discover and register their tools. |
| `tool-coding-pipeline` | Build → review → validate loop for autonomous coding. |

### Memory

| Plugin | Description |
|--------|-------------|
| `memory-postgres` | Full transcript archive over PostgreSQL + pgvector. Hybrid FTS+vector search, summary DAG, background compaction. |

## Configuration

```yaml
# ~/.rivetos/config.yaml
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
  local:
    provider: llama-server

providers:
  anthropic:
    model: claude-opus-4-6
    # auth: rivetos anthropic setup
  xai:
    model: grok-4-1-fast
    # auth: XAI_API_KEY env var
  llama-server:
    base_url: http://localhost:8000/v1
    model: rivet-v0.1

channels:
  telegram:
    owner_id: "your-telegram-user-id"
    # auth: TELEGRAM_BOT_TOKEN env var
  discord:
    channel_bindings:
      "channel_id": opus
    # auth: DISCORD_BOT_TOKEN env var

memory:
  postgres:
    # auth: RIVETOS_PG_URL env var
```

API keys always via environment variables. Never in config files.

## CLI Reference

```
rivetos start [--config <path>]     Start the runtime
rivetos stop                        Stop the running instance
rivetos status                      Show runtime status
rivetos doctor                      Check config and connectivity
rivetos config init                 Generate default config.yaml
rivetos config validate             Validate config without starting
rivetos version                     Show version
rivetos logs                        Tail runtime logs with filtering
rivetos skills list                 Show discovered skills
rivetos plugins list                Show loaded plugins with status

rivetos anthropic setup             OAuth login for Claude subscription
rivetos anthropic status            Check auth status
rivetos xai status                  Check xAI connectivity
rivetos google status               Check Google connectivity
rivetos ollama status               Check Ollama connectivity
rivetos ollama models               List available models
rivetos ollama pull <model>         Pull a model
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

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, code style, and PR guidelines.

## License

[Apache License 2.0](LICENSE)

---

[rivetos.dev](https://rivetos.dev) · [GitHub](https://github.com/philbert440/rivetOS)
