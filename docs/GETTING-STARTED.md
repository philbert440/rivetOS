# Getting started

Get RivetOS running in under 5 minutes. Two paths: **Docker** (recommended) or **bare-metal**.

---

## Prerequisites

| Requirement | Version | Check |
|---|---|---|
| Node.js | ≥ 22 (24 used in CI/containers) | `node --version` |
| npm | ≥ 10 | `npm --version` |
| Git | any | `git --version` |
| Docker (optional) | ≥ 24 | `docker --version` |

> **Note:** `npm install` automatically builds all packages via postinstall. No separate build step needed.

## Option A: interactive setup (recommended)

The supported install path is a **stable tagged release** (pin a tag from [GitHub Releases](https://github.com/philbert440/rivetOS/releases)). Cloning default `main` is the development path.

The `rivetos init` wizard walks you through deployment target, agent configuration, and API keys, then generates your config automatically. Human UX is RivetHub; the wizard no longer collects social-bot tokens.

```bash
git clone https://github.com/philbert440/rivetOS.git
# production: git checkout <tag>
cd rivetOS
npm install
npx rivetos init
```

The wizard will:
1. **Detect your environment**: Docker available? Proxmox? How much memory?
2. **Choose deployment target**: Docker (recommended), Proxmox, or manual
3. **Configure agents**: pick a provider, enter your API key, choose a model
4. **Join a RivetHub mesh** (optional): datahub SSH target, node name, optional advertise host — enrolls via the same path as `rivetos mesh enroll`
5. **Owner user id** for a single-owner `users.json` seed at `$RIVETOS_SHARED_DIR/rivetos/users.json` (default `owner`; existing file is left in place). First init on an install that has no `users.json` writes `unmappedIsOwner: false` (fail closed) — a missing file used to be treated as permissive (unmapped devices resolve as the owner). This file is the only per-user routing source (`rivetos user add` writes it; override the path with `RIVETOS_USERS_FILE`). den loads the registry once at boot (no watcher) — restart den / the rivetos node after `rivetos user add` for routing to take effect.
6. **Review and deploy**: summary of your choices, then one-click deploy

Social bots (Discord, Telegram, Voice) were removed in Phase 5; human UX is RivetHub.

For non-interactive / distro installs, pass a JSON answers file:

```bash
npx rivetos init --answers-file /path/to/answers.json
```

Every prompt that would fire on this run must be present as a key. A missing key is a hard error that names the key (no silent defaults). A value of `{ "default": true }` opts into that prompt's interactive default.

```json
{
  "deployment": "manual",
  "agents": [
    {
      "name": { "default": true },
      "provider": "xai",
      "apiKey": "xai-...",
      "model": { "default": true },
      "thinking": { "default": true }
    }
  ],
  "postgresUrl": "postgres://rivetos:...@datahub:5432/rivetos",
  "joinMesh": true,
  "meshHub": "rivet@192.0.2.10",
  "meshName": "node-a",
  "meshAdvertise": "192.0.2.11",
  "ownerId": { "default": true },
  "confirm": true
}
```

| Key | Required when | Notes |
|-----|----------------|-------|
| `existingConfig` | A config already exists | `deploy` \| `reconfigure` \| `validate` \| `overwrite` \| `cancel` |
| `overwriteConfirm` | `existingConfig` is `overwrite` | boolean (`{ "default": true }` → `false`) |
| `deployment` | wizard runs | `docker` \| `proxmox` \| `manual` (no default) |
| `dockerContinue` | `deployment` is `docker` and Docker was not detected | boolean |
| `agents` | wizard runs | non-empty array; each entry is one agent (no add-another loop) |
| `agents[].name` | each agent | `{ "default": true }` → `rivet` on the first agent |
| `agents[].provider` | each agent | no default |
| `agents[].apiKey` | providers that need a key | `{ "default": true }` uses `$ANTHROPIC_API_KEY` / `$XAI_API_KEY` / `$GOOGLE_API_KEY` when set. Optional for `vllm` / `llama-server` (omit or empty = unauthenticated server; ignored when blank). Not collected for `claude-cli`. |
| `agents[].baseUrl` | `ollama` / `vllm` / `llama-server` | interactive URL defaults |
| `agents[].model` | each agent, including `claude-cli` | provider default model |
| `agents[].thinking` | each agent | `{ "default": true }` → `medium` |
| `postgresUrl` | `deployment` is `manual` | `postgres://…` |
| `joinMesh` | wizard runs | boolean (`{ "default": true }` → `false`) |
| `meshHub` | `joinMesh` is `true` | `user@host` |
| `meshName` | `joinMesh` is `true` | DNS-label node name. `{ "default": true }` is rejected — the interactive hostname-derived default is not a silent answers default |
| `meshAdvertise` | optional when joining | omit or `{ "default": true }` to auto-detect |
| `ownerId` | wizard runs | `{ "default": true }` → `owner` |
| `confirm` | wizard runs | `{ "default": true }` → `true` |
| `deployNow` | `deployment` is `docker`, **or** `existingConfig` is `deploy` | `{ "default": true }` → `true` |

After the wizard completes, your agent is running.

---

## Option B: Docker (manual)

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

# channels: social bots removed in Phase 5 — use RivetHub
# optional agent mesh: channels.agent: { port: 3100, agent_id: opus }


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

## Option C: bare-metal (no Docker)

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

Add your workspace files (templates ship under `workspace-templates/` in the repo; `rivetos init` copies them in for you):

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

## Workspace files

Workspace files are markdown documents injected into the agent's system prompt. They define who the agent is and how it behaves.

### Required files

**`CORE.md`**: agent identity, personality, values, and behavioral rules.
```markdown
# CORE.md — Who You Are

You are a helpful AI assistant named Rivet.

## Working Style
- Be direct and concise
- Show your reasoning
- Ask before making destructive changes
```

**`USER.md`**: information about the person the agent is helping.
```markdown
# USER.md — About Your Human

- **Name:** Phil
- **Timezone:** America/New_York
- **Preferences:** TypeScript, Next.js, direct communication
```

**`WORKSPACE.md`**: operating rules, safety boundaries, and conventions.
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

### Optional files

**`MEMORY.md`**: a lightweight index into the memory system. The agent uses this to know what to search for.

**`CAPABILITIES.md`**: extended reference for tools, skills, and infrastructure. Included in the system prompt for local models where token cost isn't a concern.

**`HEARTBEAT.md`**: instructions for periodic background tasks. Only injected during heartbeat turns, not regular conversation.

**`memory/YYYY-MM-DD.md`**: daily notes. The agent reads recent daily notes for context continuity between sessions.

---

## First conversation

Once your agent is running, talk to it through RivetHub:

**Hub:** Open RivetHub pointed at this node's gateway and start a harness session.

> The agent HTTP channel (`POST /api/message`) is an mTLS-authenticated endpoint for **inter-agent / mesh delegation**, not a casual chat API; it expects a `{ fromAgent, message }` envelope over HTTPS with client certs. See [Mesh Networking](mesh.md).

### Useful commands

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

## CLI reference (quick)

```bash
# Setup
rivetos init                          # Interactive setup wizard
rivetos init --answers-file FILE      # Non-interactive (JSON answers)
rivetos update                        # Pull latest, rebuild, re-symlink (add --mesh or --bare-metal)
rivetos doctor                        # Health check (config, providers, connectivity)

# Runtime
rivetos start [--config <path>]       # Start the runtime
rivetos stop                          # Stop the running instance
rivetos status                        # Show runtime status and metrics

# Configuration
rivetos config show|validate|edit|path
rivetos config init                   # Same as rivetos init — setup wizard

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
rivetos memory retry-failed --task extract-wiki --dry-run  # Plan reset of dead jobs
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

## Next steps

- **[Configuration Reference](CONFIG-REFERENCE.md)**: every config option explained
- **[Architecture](ARCHITECTURE.md)**: how the system works
- **[Plugins](PLUGINS.md)**: how to write your own channel, provider, or tool
- **[Skills](SKILLS.md)**: how to write and share skills
- **[Deployment](DEPLOYMENT.md)**: Docker, Proxmox, multi-agent, networking
- **[Troubleshooting](TROUBLESHOOTING.md)**: common issues and fixes

---

## Quick troubleshooting

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
- Embeddings may still be processing: check `npx rivetos status` for queue depth

**Can't find config?**
- Default location: `./config.yaml` or `~/.rivetos/config.yaml`
- Override with: `npx rivetos start --config /path/to/config.yaml`
