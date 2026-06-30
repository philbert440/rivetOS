---
title: Quick Start
sidebar:
  order: 2
description: Get RivetOS running in under 5 minutes
---
Get RivetOS running in under 5 minutes. Two paths: **Docker** (recommended) or **bare-metal**.

---

## Prerequisites

| Requirement | Version | Check |
|---|---|---|
| Node.js | ≥ 24 | `node --version` |
| npm | ≥ 10 | `npm --version` |
| Git | any | `git --version` |
| Docker (optional) | ≥ 24 | `docker --version` |

> **Note:** `npm install` automatically builds all packages via postinstall. No separate build step needed.

## Option A: Interactive Setup (Recommended)

The `rivetos init` wizard walks you through everything — deployment target, agent configuration, API keys, channels, and generates your config automatically.

```bash
git clone https://github.com/philbert440/rivetOS.git
cd rivetOS
npm install
npx rivetos init
```

The wizard will:
1. **Detect your environment** — Docker available? Proxmox? How much memory?
2. **Choose deployment target** — Docker (recommended), Proxmox, or manual
3. **Configure agents** — pick a provider, enter your API key, choose a model
4. **Configure channels** — Discord, Telegram, voice (Discord voice), terminal, or API-only
5. **Review and deploy** — summary of your choices, then one-click deploy

After the wizard completes, your agent is running.

---

## Option B: Docker (Manual)

### 1. Clone and install

```bash
git clone https://github.com/philbert440/rivetOS.git
cd rivetOS
npm install
```

### 2. Create your config

```bash
cp config.example.yaml config.yaml
```

Edit `config.yaml` with your settings:

```yaml
runtime:
  workspace: ~/.rivetos/workspace
  default_agent: myagent

agents:
  myagent:
    provider: anthropic

providers:
  anthropic:
    model: claude-sonnet-4-6
    max_tokens: 8192

channels:
  discord:
    channel_bindings:
      "YOUR_CHANNEL_ID": myagent

memory:
  postgres:
    # Connection string is set via RIVETOS_PG_URL env var
```

### 3. Set up secrets

```bash
cp .env.example .env
```

Edit `.env`:

```bash
ANTHROPIC_API_KEY=sk-ant-...
DISCORD_BOT_TOKEN=...
RIVETOS_PG_URL=postgresql://rivetos:rivetos@localhost:5432/rivetos
```

> **Security:** Never put API keys in `config.yaml`. Always use `.env` or environment variables.

### 4. Build and run with Docker

The unified Compose stack lives at `infra/docker/rivetos/docker-compose.yml`. You can either pass `-f` every time, or set `COMPOSE_FILE` once:

```bash
# (optional) so plain `docker compose ...` finds the unified stack
export COMPOSE_FILE=infra/docker/rivetos/docker-compose.yml
```

```bash
# Build container images from source
npx rivetos build

# Start everything (datahub + agent)
docker compose -f infra/docker/rivetos/docker-compose.yml up -d

# Check status
npx rivetos status

# View logs
npx rivetos logs --follow
```

### 5. Verify

```bash
# Run diagnostics
npx rivetos doctor

# Run smoke tests
npx rivetos test
```

---

## Option C: Bare-Metal (No Docker)

Run RivetOS directly on your machine. You'll need PostgreSQL running separately.

### 1. Clone and install

```bash
git clone https://github.com/philbert440/rivetOS.git
cd rivetOS
npm install
```

### 2. Set up PostgreSQL

RivetOS needs PostgreSQL 16+ with the pgvector extension.

```bash
# Ubuntu/Debian
sudo apt install postgresql-16 postgresql-16-pgvector

# macOS (Homebrew)
brew install postgresql@16
brew install pgvector

# Create database
createdb rivetos
psql rivetos -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

### 3. Create config and secrets

```bash
cp config.example.yaml config.yaml
cp .env.example .env
```

Edit both files as described in Option B, steps 2-3.

### 4. Create workspace

```bash
mkdir -p ~/.rivetos/workspace/memory
```

Add your workspace files (templates ship under `workspace-templates/` in the repo — `rivetos init` copies them in for you):

| File | Purpose | Required? |
|---|---|---|
| `~/.rivetos/workspace/CORE.md` | Agent identity and personality | Yes |
| `~/.rivetos/workspace/USER.md` | Who the agent is helping | Yes |
| `~/.rivetos/workspace/WORKSPACE.md` | Operating rules and conventions | Yes |
| `~/.rivetos/workspace/MEMORY.md` | Context index for the memory system | Optional |
| `~/.rivetos/workspace/CAPABILITIES.md` | Extended tool/skill reference | Optional |

See the [Workspace Files](#workspace-files) section below for details.

### 5. Start

```bash
npx rivetos start
```

### 6. Install as a system service (optional)

```bash
# Generate a systemd unit
npx rivetos service init

# Start it
npx rivetos service start
```

---

## Workspace Files

Workspace files are markdown documents injected into the agent's system prompt. They define who the agent is and how it behaves.

### Required Files

**`CORE.md`** — Agent identity, personality, values, and behavioral rules.
```markdown
# CORE.md — Who You Are

You are a helpful AI assistant named Rivet.

## Working Style
- Be direct and concise
- Show your reasoning
- Ask before making destructive changes
```

**`USER.md`** — Information about the person the agent is helping.
```markdown
# USER.md — About Your Human

- **Name:** Phil
- **Timezone:** America/New_York
- **Preferences:** TypeScript, Next.js, direct communication
```

**`WORKSPACE.md`** — Operating rules, safety boundaries, and conventions.
```markdown
# WORKSPACE.md — Operating Rules

## Safety
- Don't delete files without asking
- Don't send emails without approval
- Keep secrets private

## Every Session
1. Read CORE.md, USER.md, WORKSPACE.md
2. Check recent memory files
3. Get to work
```

### Optional Files

**`MEMORY.md`** — A lightweight index into the memory system. The agent uses this to know what to search for.

**`CAPABILITIES.md`** — Extended reference for tools, skills, and infrastructure. Included in the system prompt for local models where token cost isn't a concern.

**`HEARTBEAT.md`** — Instructions for periodic background tasks. Only injected during heartbeat turns, not regular conversation.

**`memory/YYYY-MM-DD.md`** — Daily notes. The agent reads recent daily notes for context continuity between sessions.

---

## First Conversation

Once your agent is running, talk to it through whichever channel you configured:

**Discord:** Send a message in a bound channel (one listed under `channels.discord.channel_bindings`).
**Telegram:** Message your bot directly, if you configured `channels.telegram`.

> The agent HTTP channel (`POST /api/message`) is an mTLS-authenticated endpoint for **inter-agent / mesh delegation**, not a casual chat API — it expects a `{ fromAgent, message }` envelope over HTTPS with client certs. See [Mesh Networking](/guides/mesh/).

### Useful Commands

In any channel, you can use slash commands:

| Command | What it does |
|---|---|
| `/stop` | Stop the current turn |
| `/interrupt [message]` | Stop the current turn and send a new message |
| `/steer [message]` | Inject guidance into the active turn |
| `/new` | Start a fresh session (clears conversation history) |
| `/status` | Show runtime status |
| `/model [provider] [model]` | Show or switch the current model |
| `/think [level]` | Set thinking depth: off, low, medium, high |
| `/reasoning` | Toggle reasoning (thinking) visibility |
| `/tools` | Toggle tool-call visibility |
| `/context` | Show context-window stats |
| `/memory` | Show memory system health and stats |
| `/clear` | Clear queued messages |
| `/help` | List available commands |

---

## CLI Reference (Quick)

```bash
# Setup
rivetos init                          # Interactive setup wizard
rivetos update                        # Pull latest, rebuild, re-symlink (add --mesh or --bare-metal)
rivetos doctor                        # Health check (config, providers, connectivity)

# Runtime
rivetos start [--config <path>]       # Start the runtime
rivetos stop                          # Stop the running instance
rivetos status                        # Show runtime status and metrics

# Configuration
rivetos config show|validate|edit|path
rivetos config init                   # Generate a default config.yaml

# Agents & models
rivetos agent list|add|remove
rivetos model                         # Show providers + current models
rivetos model <provider> <model>      # Switch default model (persistent)

# Providers
rivetos <provider> status             # anthropic | xai | google | ollama
rivetos ollama models                 # List local Ollama models

# Mesh (multi-node)
rivetos mesh list|ping|status
rivetos mesh join <host>              # Join an existing mesh via a seed node
rivetos keys rotate|list|status       # Manage mesh keys

# Memory & database
rivetos memory queue-status           # Show graphile-worker job queue
rivetos memory backfill-tool-synth    # Enqueue historical tool calls for synthesis
rivetos db migrate|status             # Run / inspect schema migrations

# Containers & service
rivetos build                         # Build container images from source
rivetos service init|start|stop|restart|status|logs

# Introspection
rivetos logs [--lines --follow --since --grep]
rivetos test [--quick]                # Smoke tests (config, provider, memory, tools)
rivetos plugins list
rivetos skills list
```

---

## Next Steps

- **[Channel Setup](/guides/channels/)** — Connect to Discord, Telegram, voice, and agent-to-agent messaging
- **[Provider Setup](/guides/providers/)** — Configure Anthropic, xAI, Google, Ollama, vLLM, llama-server, and claude-cli
- **[Mesh Networking](/guides/mesh/)** — Multi-node fleets with mTLS delegation
- **[Configuration Reference](/reference/config/)** — Every config option explained
- **[Architecture](/reference/architecture/)** — How the system works
- **[Plugins](/guides/plugins/)** — How to write your own channel, provider, or tool
- **[Skills](/guides/skills/)** — How to write and share skills
- **[Deployment](/guides/deployment/)** — Docker, Proxmox, multi-agent, networking
- **[Troubleshooting](/reference/troubleshooting/)** — Common issues and fixes

---

## Quick Troubleshooting

**Agent doesn't respond?**
- Run `npx rivetos doctor` to check connectivity
- Check `npx rivetos logs` for errors
- Verify your API key is set in `.env`

**Docker containers won't start?**
- Run `docker compose -f infra/docker/rivetos/docker-compose.yml logs datahub` to check PostgreSQL
- Ensure port 5432 isn't already in use
- Try `npx rivetos build` to rebuild images

**Memory search returns nothing?**
- Check PostgreSQL connection: `npx rivetos test --quick`
- Embeddings may still be processing — check `npx rivetos status` for queue depth

**Can't find config?**
- Default location: `./config.yaml` or `~/.rivetos/config.yaml`
- Override with: `npx rivetos start --config /path/to/config.yaml`
