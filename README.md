# RivetOS

**Lightweight, stable agent runtime. MIT licensed.**

> Zero bloat. Zero lock-in. Just the loop.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-green.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org)

RivetOS is a personal AI agent runtime built for reliability. A tiny, stable core routes messages between channels and LLM providers. Everything else is a plugin.

## Features

- **Tiny core** — A minimal, stable core that routes messages, executes tools, and manages lifecycle.
- **Streaming-first** — `AsyncIterable<LLMChunk>` from every provider. See responses as they generate.
- **Plugin everything** — Channels, providers, memory, tools — all swappable via clean interfaces.
- **5 providers** — Anthropic (with OAuth subscription auth), Google Gemini, xAI Grok, Ollama, OpenAI-compatible.
- **Full control surface** — `/stop`, `/interrupt`, `/steer`, `/new`, `/status`, `/model`, `/think`, `/reasoning`.
- **Interrupt that works** — `AbortController` propagated to every API call and tool. When you say stop, it stops.
- **Session persistence** — Conversations survive restarts. `/new` is the only thing that clears history.
- **Thinking control** — Toggle reasoning depth per-turn: off, low, medium, high.
- **LTS releases** — Pin a version. It won't break for 12 months.
- **MIT licensed** — No CLA, no dual-licensing, no surprises.

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
┌─────────────────────────────────────────────────────┐
│                     Plugins (Adapters)               │
│                                                      │
│  Channels    Providers    Memory       Tools          │
│  ─────────   ──────────  ──────────   ──────         │
│  Telegram    Anthropic   Postgres     Shell           │
│  (Discord)   Google      (LCM)       (Web Search)    │
│  (CLI)       xAI                     (File I/O)      │
│              Ollama                                   │
│              OpenAI-compat                            │
│                                                      │
│  Plugins implement core interfaces.                  │
│  Plugins depend on @rivetos/types only.              │
├──────────────────────────────────────────────────────┤
│                   Application Layer                   │
│                                                      │
│  Runtime    — wires plugins to domain logic           │
│  Boot       — composition root, reads config          │
│  CLI        — rivetos start/stop/status/doctor        │
├──────────────────────────────────────────────────────┤
│                     Domain Layer                      │
│                                                      │
│  AgentLoop  — message → LLM → tools → response       │
│  Router     — inbound message → agent → provider      │
│  Workspace  — SOUL.md, AGENTS.md → system prompt      │
│  Queue      — message ordering, command interception   │
├──────────────────────────────────────────────────────┤
│                      Types Layer                      │
│                                                      │
│  Provider, Channel, Tool, Memory, Workspace           │
│  Interfaces only. Zero dependencies.                  │
└──────────────────────────────────────────────────────┘
```

**Dependency rule:** Everything points inward. Plugins → Types. Domain → Types. Nothing depends on plugins.

## Plugins

| Plugin | Type | Description |
|--------|------|-------------|
| `provider-anthropic` | Provider | Claude models with OAuth subscription auth + API key support |
| `provider-google` | Provider | Gemini models via Generative Language API |
| `provider-xai` | Provider | Grok models with conversation caching |
| `provider-ollama` | Provider | Native Ollama API with model management |
| `provider-openai-compat` | Provider | Any OpenAI-compatible endpoint (llama-server, vLLM, etc.) |
| `channel-telegram` | Channel | Telegram Bot API via grammY |
| `memory-postgres-lcm` | Memory | Full transcript archive over LCM PostgreSQL tables |
| `tool-shell` | Tool | Shell command execution with AbortSignal |

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
rivetos version                     Show version

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

[MIT](LICENSE) — do whatever you want.

---

[rivetos.dev](https://rivetos.dev) · [GitHub](https://github.com/philbert440/rivetOS)
