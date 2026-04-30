# RivetOS

**Lightweight, stable agent runtime. Apache 2.0 licensed.**

> Zero bloat. Zero lock-in. Just the loop.

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-24%2B-green.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org)
[![Nx](https://img.shields.io/badge/Nx-22-blue.svg)](https://nx.dev)

RivetOS is a personal AI agent runtime built for reliability. A tiny, stable core routes messages between channels and LLM providers. Everything else — providers, channels, tools, memory — is a plugin.

**Container-first.** The container IS the product. Security via isolation, setup via wizard, updates via source rebuild. One config file drives everything.

## Features

- **Tiny core, fat plugins** — The kernel stays under 5,000 lines. Everything else is swappable.
- **Streaming-first** — `AsyncIterable<StreamEvent>` from every provider. Responses stream in real-time.
- **7 LLM providers** — Anthropic (Claude), xAI (Grok), Google (Gemini), Ollama, llama-server (native llama.cpp), openai-compat (vLLM / TGI / any strict OpenAI-compatible server), claude-cli (Claude Code subscription).
- **4 channel plugins** — Discord, Telegram, Agent (HTTP inter-agent), Voice (xAI Realtime).
- **MCP transport plugin** — Expose RivetOS tools (memory, web, skills) to external MCP clients over StreamableHTTP.
- **20+ built-in tools** — Shell, file I/O, search, web, memory, skills, interaction, MCP client, coding pipeline, delegation, sub-agents.
- **Multi-agent mesh** — Delegate tasks across agents. Local or remote. Transparent routing.
- **Hook system** — Composable pipeline for safety, fallback chains, auto-actions, session lifecycle.
- **Interactive setup** — `rivetos init` walks you through everything step by step.
- **Container deployment** — Docker Compose or Proxmox LXC. Images built from source, plugins included.
- **Source-based updates** — `rivetos update` pulls, rebuilds, restarts. Forks and custom plugins are first-class.
- **Full control surface** — `/stop`, `/steer`, `/new`, `/status`, `/model`, `/think`, `/context`.
- **Interrupt that works** — `AbortController` propagated to every API call and tool.
- **Persistent memory** — PostgreSQL + pgvector. Hybrid FTS + vector search. Summary DAG. Learning loop.
- **Structured observability** — JSON logging, runtime metrics, health endpoints, `rivetos doctor`.
- **LTS releases** — Pin a version. It won't break for 12 months.
- **Apache 2.0** — No CLA, no dual-licensing, no surprises. Patent grant included.

## Quick Start

```bash
git clone https://github.com/philbert440/rivetOS.git
cd rivetOS
npm install

# Interactive setup — configures everything
npx rivetos init

# Or manual setup:
cp config.example.yaml config.yaml
cp .env.example .env
# Edit both files, then:
npx rivetos start
```

See [Getting Started](docs/GETTING-STARTED.md) for the full guide.

## Architecture

```
┌───────────────────────────────────────────────────────────────┐
│                       RivetOS Runtime                         │
│                                                               │
│  ┌──────────┐     ┌──────────┐    ┌────────────────────────┐  │
│  │ Channels │───> │  Router  │───>│     Turn Handler       │  │
│  │ (plugin) │     │ (domain) │    │     (application)      │  │
│  │          │     │          │    │                        │  │
│  │ Discord  │     │ message  │    │ hooks → media → loop   │  │
│  │ Telegram │     │  → agent │    │  → stream → respond    │  │
│  │ Agent    │     │  → prov  │    │  → memory append       │  │
│  │ Voice    │     │          │    │                        │  │
│  └──────────┘     └──────────┘    └───────────┬────────────┘  │
│       ▲                                       │               │
│       │              ┌────────────────────────┘               │
│       │              ▼                                        │
│  ┌──────────┐    ┌──────────┐    ┌──────────────────────┐     │
│  │ Response │<───│Workspace │    │     Memory           │     │
│  │ sent to  │    │ (domain) │    │    (plugin)          │     │
│  │ channel  │    │          │    │                      │     │
│  │          │    │ CORE.md  │    │ append transcript    │     │
│  │          │    │ USER.md  │    │ search context       │     │
│  │          │    │ MEMORY.md│    │ hybrid FTS+vector    │     │
│  └──────────┘    └──────────┘    └──────────────────────┘     │
│                                                               │
│  ┌──────────────┐  ┌──────────┐  ┌────────────────────────┐   │
│  │ Observability│  │   Mesh   │  │      Boot Layer        │   │
│  │              │  │          │  │                        │   │
│  │ Metrics      │  │ Registry │  │ Config → Registrars    │   │
│  │ Health API   │  │ Discover │  │ → Lifecycle            │   │
│  │ Audit logs   │  │ Delegate │  │                        │   │
│  └──────────────┘  └──────────┘  └────────────────────────┘   │
└───────────────────────────────────────────────────────────────┘
```

**Dependency rule:** Everything points inward. Plugins → Types. Domain → Types. Nothing depends on plugins.

## Monorepo Structure

```
rivetOS/
├── packages/
│   ├── types/          # Interfaces & contracts — zero dependencies
│   ├── core/           # Domain logic, agent loop, runtime, observability
│   ├── boot/           # Composition root, plugin wiring, validation
│   ├── cli/            # CLI commands (rivetos start/stop/init/doctor/...)
│   └── nx-plugin/      # @rivetos/nx — generators, executors, dev tooling
├── plugins/
│   ├── channels/       # discord, telegram, agent, voice-discord
│   ├── providers/      # anthropic, google, xai, ollama, llama-server, openai-compat, claude-cli
│   ├── memory/         # postgres (pgvector + FTS + summary DAG + workers)
│   ├── tools/          # shell, file, search, web-search, interaction, mcp-client, coding-pipeline
│   └── transports/     # mcp-server (expose RivetOS tools over MCP StreamableHTTP)
├── apps/
│   └── site/           # Astro docs site
├── infra/              # Container Dockerfiles, Compose files, provisioning scripts
└── docs/               # Full documentation (incl. example configs under docs/examples/)
```

Skills are user-managed and live outside the source tree (default: `~/.rivetos/workspace/skills/`). See [docs/SKILLS.md](docs/SKILLS.md).

## Plugins

### Providers

| Plugin | Description |
|--------|-------------|
| `provider-anthropic` | Claude models — streaming, adaptive thinking, prompt caching |
| `provider-google` | Gemini models via Generative Language API (thought signatures) |
| `provider-xai` | Grok models with live search and caching |
| `provider-ollama` | Local Ollama models (native API) |
| `provider-llama-server` | llama.cpp `llama-server` binary (native API, mirostat, typical_p, etc.) |
| `provider-openai-compat` | Strict OpenAI-compatible servers (vLLM, TGI, Groq, Together, Fireworks, LocalAI) |
| `provider-claude-cli` | Drives the local `claude` binary (Claude Code) using the user's subscription OAuth token |

### Channels

| Plugin | Description |
|--------|-------------|
| `channel-discord` | Discord with streaming edits, reactions, overflow handling |
| `channel-telegram` | Telegram with owner gate, inline keyboards, 4096-char splitting |
| `channel-agent` | HTTP inter-agent messaging and mesh endpoints |
| `channel-voice-discord` | Discord voice via xAI Realtime API (STT/TTS) |

### Tools

| Plugin | Description |
|--------|-------------|
| `tool-shell` | Shell execution with safety categorization |
| `tool-file` | `file_read`, `file_write`, `file_edit` with surgical edits |
| `tool-search` | `search_glob` and `search_grep` |
| `tool-web-search` | Google CSE + DuckDuckGo fallback, HTML → markdown |
| `tool-interaction` | `ask_user` (structured questions) and `todo` (task list) |
| `tool-mcp-client` | MCP protocol client (stdio + HTTP transports) |
| `tool-coding-pipeline` | Multi-agent build → review → validate loop |

The memory plugin (`@rivetos/memory-postgres`) additionally registers `memory_search`, `memory_browse`, and `memory_stats`. Delegation, sub-agents, and skill management add `delegate_task`, `subagent_*`, and `skill_*` tools at runtime.

### Transports

| Plugin | Description |
|--------|-------------|
| `transport-mcp` (`@rivetos/mcp-server`) | Exposes RivetOS tools (memory, web, skills, runtime) to external MCP clients over StreamableHTTP |

## Configuration

```yaml
runtime:
  workspace: ~/.rivetos/workspace
  default_agent: opus

agents:
  opus:
    provider: anthropic
    default_thinking: medium
    fallbacks: ['google:gemini-2.5-pro']

providers:
  anthropic:
    model: claude-sonnet-4-20250514

channels:
  discord:
    channel_bindings:
      "channel_id": opus

memory:
  postgres: {}
```

API keys always via `.env` — never in config files. See [Config Reference](docs/CONFIG-REFERENCE.md) for every option.

## Workspace Files

Markdown files injected into the agent's system prompt:

| File | Purpose |
|------|---------|
| `CORE.md` | Agent identity, personality, behavioral rules |
| `USER.md` | Who the owner is |
| `WORKSPACE.md` | Operating rules, safety boundaries, conventions |
| `MEMORY.md` | Lightweight context index (query-based) |
| `CAPABILITIES.md` | Extended tool/skill reference (local models) |
| `HEARTBEAT.md` | Background task instructions |
| `memory/YYYY-MM-DD.md` | Daily notes for continuity |

## CLI Reference

```
Setup:
  rivetos init                    Interactive setup wizard
  rivetos update                  Pull latest, rebuild, restart
  rivetos doctor                  12-category health check
  rivetos test                    Smoke test (provider, memory, tools)

Runtime:
  rivetos start [--config ...]    Start the runtime
  rivetos stop                    Stop the running instance
  rivetos status                  Runtime status with metrics
  rivetos logs [options]          Tail logs (--follow, --level, --since)

Configuration:
  rivetos config show|validate|edit|path   View or validate config
  rivetos agent add|remove|list   Manage agents
  rivetos model [provider] [mod]  Show or switch models
  rivetos keys rotate|list        Rotate / list mesh SSH keys

Containers & Service:
  rivetos build                   Build container images from source
  rivetos service install         Install systemd unit

Mesh:
  rivetos mesh list|ping|status   Mesh management
  rivetos mesh join <host>        Join an existing mesh

Memory:
  rivetos memory backfill-tool-synth   Synthesize content for historical tool calls
  rivetos memory queue-status     Show ros_tool_synth_queue state
  rivetos db ...                  Low-level DB inspection helpers

Development:
  rivetos plugin init             Scaffold a new plugin
  rivetos skill init              Scaffold a new skill
  rivetos skill validate          Validate skill frontmatter
  rivetos plugins list            Show configured plugins
  rivetos skills list             Show discovered skills
```

## Development

```bash
npm install          # Install + build all packages
npm run ci           # Lint + build + test (what CI runs)

npx nx run core:test           # Test a single package
npx nx affected -t test        # Test only what you changed
npx nx g @rivetos/nx:plugin    # Scaffold a new plugin
npx nx graph                   # Interactive dependency graph
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full development guide.

## Documentation

- [Getting Started](docs/GETTING-STARTED.md) — Zero to running in 5 minutes
- [Architecture](docs/ARCHITECTURE.md) — System design and plugin model
- [Config Reference](docs/CONFIG-REFERENCE.md) — Every config option explained
- [Plugins](docs/PLUGINS.md) — How to write channels, providers, and tools
- [Skills](docs/SKILLS.md) — How to write and share skills
- [Deployment](docs/DEPLOYMENT.md) — Docker, Proxmox, multi-agent, backup
- [Troubleshooting](docs/TROUBLESHOOTING.md) — Common issues and fixes
- [Examples](docs/examples/) — Ready-to-use config files

## License

[Apache License 2.0](LICENSE)

---

[rivetos.dev](https://rivetos.dev) · [GitHub](https://github.com/philbert440/rivetOS)
