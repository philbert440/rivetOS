---
title: Configuration Reference
sidebar:
  order: 1
description: Every configuration option for RivetOS
---


RivetOS uses a single YAML config file for all settings. API keys and secrets go in `.env`, never in the config file.

**Config file locations** (checked in order):
1. `--config` CLI flag
2. `./config.yaml` (current directory)
3. `~/.rivetos/config.yaml`

**Validate without starting:** `rivetos config validate`

---

## Quick Example

```yaml
runtime:
  workspace: ~/.rivetos/workspace
  default_agent: opus

agents:
  opus:
    provider: anthropic
    default_thinking: medium

providers:
  anthropic:
    model: claude-sonnet-4-20250514
    max_tokens: 8192

channels:
  discord:
    channel_bindings:
      "123456789": opus

memory:
  postgres: {}
```

---

## Environment Variable Resolution

Any string value can reference environment variables with `${VAR_NAME}`:

```yaml
providers:
  anthropic:
    api_key: ${ANTHROPIC_API_KEY}

memory:
  postgres:
    connection_string: ${RIVETOS_PG_URL}
```

Unset variables resolve to empty strings. Recommended: put all secrets in `.env` and reference them.

---

## `runtime`

Top-level runtime configuration.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `workspace` | string | **required** | Path to workspace directory containing CORE.md, USER.md, etc. |
| `default_agent` | string | **required** | Agent to use when no channel binding matches. Must match a key in `agents`. |
| `max_tool_iterations` | number | `100` | Maximum tool call iterations per turn. Safety cap to prevent runaway loops. |
| `skill_dirs` | string[] | `[]` | Directories to scan for skills (in addition to built-in `skills/`). |
| `plugin_dirs` | string[] | `[]` | Additional directories to scan for plugins beyond the default `plugins/`. |

### `runtime.heartbeats`

Array of scheduled agent tasks. Each heartbeat triggers the agent periodically.

```yaml
runtime:
  heartbeats:
    - agent: opus
      schedule: "*/30 * * * *"    # Every 30 minutes
      prompt: "Check for unread emails and calendar events."
      output_channel: discord:123456789
      timezone: America/New_York
      quiet_hours:
        start: 23
        end: 8
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `agent` | string | **required** | Which agent runs this heartbeat. Must match a key in `agents`. |
| `schedule` | string | **required** | Cron expression (e.g., `*/30 * * * *` = every 30 min). |
| `prompt` | string | **required** | The message sent to the agent on each heartbeat tick. |
| `output_channel` | string | — | Channel to deliver output (format: `platform:channel_id`). |
| `timezone` | string | `UTC` | Timezone for schedule evaluation. |
| `quiet_hours.start` | number | — | Hour (0-23) to start quiet period (no heartbeats). |
| `quiet_hours.end` | number | — | Hour (0-23) to end quiet period. |

### `runtime.coding_pipeline`

Configuration for the multi-agent build → review → validate coding loop.

```yaml
runtime:
  coding_pipeline:
    builder_agent: grok
    validator_agent: opus
    max_build_loops: 3
    max_validation_loops: 2
    auto_commit: true
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `builder_agent` | string | — | Agent that writes code. Must match a key in `agents`. |
| `validator_agent` | string | — | Agent that reviews code. Must match a key in `agents`. |
| `max_build_loops` | number | `3` | Max build-fix iterations before giving up. |
| `max_validation_loops` | number | `2` | Max validation rounds per build. |
| `auto_commit` | boolean | `true` | Auto-commit on successful validation. |

### `runtime.fallbacks`

Provider fallback chains. When a provider fails (429, 503, timeout), try the next one.

```yaml
runtime:
  fallbacks:
    - providerId: anthropic
      fallbacks:
        - "google:gemini-2.5-pro"
        - "xai:grok-4-1-fast-reasoning"
```

| Key | Type | Description |
|-----|------|-------------|
| `providerId` | string | Primary provider ID. |
| `fallbacks` | string[] | Ordered list of fallback providers. Format: `provider_id` or `provider_id:model`. |

### `runtime.safety`

Safety hooks configuration.

```yaml
runtime:
  safety:
    shellDanger: true
    audit: true
    workspaceFence:
      allowedDirs:
        - /home/user/projects
        - /tmp
      alwaysAllow:
        - /usr/bin
      tools:
        - shell
        - file_write
        - file_edit
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `shellDanger` | boolean | `true` | Block dangerous shell commands (rm -rf /, etc.). |
| `audit` | boolean | `true` | Log all tool executions to audit log. |
| `workspaceFence` | object | — | Restrict file/shell operations to specific directories. |
| `workspaceFence.allowedDirs` | string[] | **required if fence enabled** | Directories the agent can access. |
| `workspaceFence.alwaysAllow` | string[] | `[]` | Paths always allowed regardless of fence. |
| `workspaceFence.tools` | string[] | all tools | Which tools the fence applies to. |

### `runtime.auto_actions`

Automatic post-tool actions. Run after tool executions complete.

```yaml
runtime:
  auto_actions:
    format: true
    lint: false
    test: false
    gitCheck: true
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `format` | boolean | `false` | Auto-format files after edits. |
| `lint` | boolean | `false` | Auto-lint files after edits. |
| `test` | boolean | `false` | Auto-run tests after code changes. |
| `gitCheck` | boolean | `false` | Check git status after file operations. |

---

## `agents`

Named agent definitions. Each agent maps to a provider and has optional configuration.

```yaml
agents:
  opus:
    provider: anthropic
    default_thinking: medium
    fallbacks:
      - "google:gemini-2.5-pro"
    tools:
      exclude:
        - shell
  grok:
    provider: xai
  local:
    provider: ollama
    local: true
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `provider` | string | **required** | Provider ID. Must match a key in `providers`. |
| `default_thinking` | string | `off` | Default thinking level: `off`, `low`, `medium`, `high`. |
| `fallbacks` | string[] | `[]` | Provider fallback chain for this agent specifically. |
| `local` | boolean | `false` | If true, uses extended workspace context (includes CAPABILITIES.md, daily notes). Use for local models where tokens are free. |
| `tools.exclude` | string[] | `[]` | Tool names to block for this agent. |
| `tools.include` | string[] | all | If set, only these tools are available to this agent. |

---

## `providers`

LLM provider configuration. Each key is a provider ID referenced by agents.

### Anthropic

```yaml
providers:
  anthropic:
    model: claude-sonnet-4-20250514
    max_tokens: 8192
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `model` | string | `claude-sonnet-4-20250514` | Model identifier. |
| `max_tokens` | number | `8192` | Maximum output tokens. |
| `api_key` | string | `${ANTHROPIC_API_KEY}` | API key. Prefer env var. |
| `temperature` | number | — | Sampling temperature (0-1). |

**Auth:** Set `ANTHROPIC_API_KEY` in `.env`, or use OAuth: `rivetos login`

### xAI (Grok)

```yaml
providers:
  xai:
    model: grok-4-1-fast-reasoning
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `model` | string | `grok-4-1-fast-reasoning` | Model identifier. |
| `api_key` | string | `${XAI_API_KEY}` | API key. |
| `max_tokens` | number | `4096` | Maximum output tokens. |
| `temperature` | number | — | Sampling temperature. |
| `live_search` | boolean | — | Enable Grok's live search. |

### Google (Gemini)

```yaml
providers:
  google:
    model: gemini-2.5-pro
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `model` | string | `gemini-2.5-pro` | Model identifier. |
| `api_key` | string | `${GOOGLE_API_KEY}` | API key. |
| `max_tokens` | number | `8192` | Maximum output tokens. |

### Ollama

```yaml
providers:
  ollama:
    model: qwen2.5:32b
    base_url: http://localhost:11434
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `model` | string | **required** | Model name (must be pulled locally). |
| `base_url` | string | `http://localhost:11434` | Ollama API endpoint. |
| `temperature` | number | — | Sampling temperature. |
| `num_ctx` | number | — | Context window size. |

### llama-server

Native provider for `llama-server` binary from llama.cpp. Exposes full sampling controls (mirostat, typical_p, repeat_last_n, seed, etc.).

```yaml
providers:
  llama-server:
    base_url: http://localhost:8080
    model: default
    typical_p: 0.9
    mirostat: 2
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `base_url` | string | `http://localhost:8080` | Must point to your `llama-server` (no trailing `/v1`). |
| `model` | string | `default` | Model alias or path known to the server. |
| `num_ctx` | number | `8192` | Context window (matches server `-c`). |
| `temperature` | number | `0.7` | Sampling temperature. |
| `top_p` | number | `0.9` | Nucleus sampling. |
| `typical_p` | number | `0.9` | Locally typical sampling (llama.cpp specific). |
| `repeat_penalty` | number | `1.1` | Repetition penalty. |
| `repeat_last_n` | number | `64` | Last N tokens for repetition. |
| `mirostat` | number | `0` | 0=off, 1=v1, 2=v2. |
| `mirostat_tau` | number | `5.0` | Target surprise for Mirostat. |
| `mirostat_eta` | number | `0.1` | Learning rate for Mirostat. |
| `seed` | number | `-1` | Random seed (`-1` = random). |
| `api_key` | string | — | Optional (for `--api-key` on server). |

### openai-compat

Provider for strict OpenAI-compatible servers — vLLM, Text Generation Inference (TGI), LocalAI, Together, Fireworks, Groq, etc. Sibling to `llama-server` but tuned for stricter chat-template behavior:

- Folds any post-first `system` message into a `user` message with a `[SYSTEM NOTICE]` prefix (vLLM/Qwen/Llama templates reject mid-conversation system messages)
- Consumes vLLM's native `reasoning_content` / `reasoning` field when a `--reasoning-parser` is configured server-side, with `<think>` regex as fallback
- Supports OpenAI sampling knobs plus vLLM extensions (`top_k`, `min_p`); excludes llama-only knobs (`typical_p`, `mirostat`, `repeat_penalty`)

```yaml
providers:
  openai-compat:
    base_url: http://vllm.local:8000/v1
    model: Qwen/Qwen2.5-72B-Instruct
    api_key: ${VLLM_API_KEY}
    top_k: 40
    min_p: 0.05
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `base_url` | string | **required** | Server URL (must include `/v1` for OpenAI-compatible endpoints). |
| `model` | string | **required** | Model identifier known to the server. |
| `api_key` | string | — | API key (sent as `Authorization: Bearer`). |
| `max_tokens` | number | — | Maximum output tokens. |
| `temperature` | number | — | Sampling temperature. |
| `top_p` | number | — | Nucleus sampling. |
| `top_k` | number | — | vLLM extension; ignored by strict OpenAI servers. |
| `min_p` | number | — | vLLM extension. |
| `presence_penalty` | number | — | Standard OpenAI penalty. |
| `frequency_penalty` | number | — | Standard OpenAI penalty. |
| `seed` | number | — | Reproducible sampling seed. |

### claude-cli

Drives the local `claude` binary (Claude Code CLI) using the user's subscription OAuth token — the sanctioned third-party-harness pattern per Anthropic's April 2026 policy. The CLI owns auth, session caching, and the wire protocol; this provider drives it via `stream-json` and brings up a per-spawn embedded MCP server that exposes every executable RivetOS tool to claude-cli through `--mcp-config`.

```yaml
providers:
  claude-cli:
    binary: claude            # path or name on PATH
    model: claude-opus-4-7    # optional — defaults to whatever the CLI picks
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `binary` | string | `claude` | Path to the `claude` binary. |
| `model` | string | — | Model alias to pass to the CLI. |
| `extra_args` | string[] | `[]` | Additional CLI flags (advanced). |

**Auth:** `claude login` (via the CLI itself). RivetOS does not handle the OAuth flow — the CLI does.

---

## `channels`

Messaging channel configuration. Each key is a channel ID.

### Discord

```yaml
channels:
  discord:
    channel_bindings:
      "123456789012345678": opus
      "987654321098765432": grok
    owner_id: "111222333444555666"
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `channel_bindings` | object | **required** | Maps Discord channel IDs to agent names. |
| `owner_id` | string | — | Discord user ID for owner-only features. |
| `bot_token` | string | `${DISCORD_BOT_TOKEN}` | Bot token. Prefer env var. |

**Setup:** Create a bot at [discord.com/developers](https://discord.com/developers/applications), copy the token, invite the bot to your server.

### Telegram

```yaml
channels:
  telegram:
    owner_id: "123456789"
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `owner_id` | string | **required** | Telegram user ID. Only this user can talk to the bot. |
| `bot_token` | string | `${TELEGRAM_BOT_TOKEN}` | Bot token from @BotFather. |

### Agent (HTTP)

Inter-agent communication channel. Enables delegation between agents and mesh networking.

> **Note:** `secret` is deprecated for agent-channel auth as of Phase 0.5. The
> agent channel now uses mutual TLS (`mesh.tls`). Configure `mesh:` instead of
> relying on the channel secret for cross-node auth.

```yaml
channels:
  agent:
    port: 3100
    # secret no longer used for authentication — see mesh.tls
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `port` | number | `3100` | HTTPS port for agent-to-agent messaging. |
| `secret` | string | — | **Deprecated.** Was the bearer token for agent channel auth. No longer checked; mesh auth is now mTLS via `mesh.tls`. |

---

## `mesh`

Multi-node mesh networking. Allows agents on different nodes to delegate tasks
to each other via mTLS. See [`docs/mesh.md`](mesh.md) for full documentation.

```yaml
mesh:
  enabled: true
  node_name: ct110        # must match the cert CN
  tls: true               # use default cert paths derived from node_name
  agent_channel_port: 3000
  storage_dir: /rivet-shared
  heartbeat_interval_ms: 30000
  stale_threshold_ms: 90000
  discovery:
    mode: seed
    seed_host: ct110.mesh   # use .mesh DNS — matches cert SAN
    seed_port: 3000
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `mesh.enabled` | bool | `false` | Enable mesh networking. |
| `mesh.node_name` | string | hostname | Node name — **must match cert CN**. |
| `mesh.tls` | bool \| object | — | mTLS config. **Required** when `mesh.enabled: true`. |
| `mesh.tls.ca_path` | string | `/rivet-shared/rivet-ca/intermediate/ca-chain.pem` | CA chain PEM. |
| `mesh.tls.cert_path` | string | `/rivet-shared/rivet-ca/issued/<node_name>.crt` | Node cert PEM. |
| `mesh.tls.key_path` | string | `/rivet-shared/rivet-ca/issued/<node_name>.key` | Node private key PEM. |
| `mesh.agent_channel_port` | number | `3000` | HTTPS port for the agent channel. |
| `mesh.storage_dir` | string | `/rivet-shared` | Directory containing `mesh.json`. |
| `mesh.heartbeat_interval_ms` | number | `30000` | Heartbeat write interval. |
| `mesh.stale_threshold_ms` | number | `90000` | Age before a node is marked stale. |
| `mesh.discovery.mode` | string | — | `seed` \| `static` \| `mdns`. |
| `mesh.discovery.seed_host` | string | — | Seed node hostname (use `<nodeName>.mesh`). |
| `mesh.discovery.seed_port` | number | `3100` | Seed node port. |
| `mesh.secret` | string | — | **Deprecated** — retained for `update --mesh` orchestration only. |

---

## `memory`

Memory backend configuration. Currently supports PostgreSQL.

### PostgreSQL

```yaml
memory:
  postgres:
    connection_string: ${RIVETOS_PG_URL}
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `connection_string` | string | `${RIVETOS_PG_URL}` | PostgreSQL connection URL. |

**Required extensions:** `pgvector` (for embedding storage and similarity search).

The memory plugin handles schema creation and migration automatically on first boot.

---

## `transports`

Inbound surfaces that expose RivetOS tools to external clients. Currently: the MCP server transport (`@rivetos/mcp-server`) — a StreamableHTTP MCP server that exposes `memory_*`, `web_*`, `skill_*`, and runtime tools to any MCP-speaking client (Claude Code, Cursor, etc.).

```yaml
transports:
  mcp:
    port: 4321
    bind: 127.0.0.1           # default localhost
    tls:                      # optional mTLS
      ca_path: /rivet-shared/rivet-ca/intermediate/ca-chain.pem
      cert_path: /rivet-shared/rivet-ca/issued/<node>.crt
      key_path: /rivet-shared/rivet-ca/issued/<node>.key
```

The transport is only activated when the matching `transports.<name>` slice is present. The MCP server can also run standalone via the `rivetos-mcp-server` bin shipped by `@rivetos/mcp-server`.

---

## `mcp`

**Outbound** Model Context Protocol — RivetOS *connects to* external MCP servers and exposes their tools to agents (the inverse of the `transports.mcp` plugin above).

```yaml
mcp:
  servers:
    memory:
      transport: stdio
      command: npx
      args: ["-y", "@modelcontextprotocol/server-memory"]
      toolPrefix: mcp_memory
    
    github:
      transport: streamable-http
      url: http://localhost:8080/mcp
      connectTimeout: 5000
      autoReconnect: true
```

### MCP Server Config

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `transport` | string | **required** | `stdio`, `streamable-http`, or `sse`. |
| `command` | string | — | Command to launch (stdio transport). |
| `args` | string[] | `[]` | Command arguments (stdio transport). |
| `env` | object | `{}` | Environment variables for the spawned process. |
| `cwd` | string | — | Working directory for the spawned process. |
| `url` | string | — | Server URL (HTTP/SSE transport). |
| `toolPrefix` | string | — | Prefix for tool names (prevents collisions between servers). |
| `connectTimeout` | number | `10000` | Connection timeout in milliseconds. |
| `autoReconnect` | boolean | `true` | Auto-reconnect on disconnect. |

---

## `deployment`

Optional. Captures the desired runtime topology (datahub host, agent placement,
networking) for documentation and tooling. Provisioning is currently driven by
the Compose files under `infra/docker/` and the scripts under
`infra/scripts/`.

```yaml
deployment:
  target: docker
  
  datahub:
    postgres: true
    shared_storage: true
    shared_mount_path: /rivet-shared
  
  image:
    build_from_source: true
  
  docker:
    network: rivetos-net
    postgres_port: 5432
```

### Top-Level

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `target` | string | **required** | `docker`, `proxmox`, `kubernetes`, or `manual`. |

### `deployment.datahub`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `postgres` | boolean | `true` | Include PostgreSQL in the datahub container. |
| `postgres_version` | string | `16` | PostgreSQL major version. |
| `shared_storage` | boolean | `true` | Create shared storage volume. |
| `shared_mount_path` | string | `/rivet-shared` | Mount path for shared storage inside containers. |

### `deployment.image`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `build_from_source` | boolean | `true` | Build container images from local source tree. |
| `registry` | string | — | Container registry for pre-built images (e.g., `ghcr.io/philbert440`). |
| `agent_image` | string | `rivetos-agent` | Agent image name. |
| `datahub_image` | string | `rivetos-datahub` | Datahub image name. |
| `tag` | string | `latest` | Image tag. |

### `deployment.docker`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `network` | string | `rivetos-net` | Docker network name. |
| `postgres_port` | number | `5432` | Host port for PostgreSQL. |
| `project_name` | string | `rivetos` | Docker Compose project name. |

### `deployment.proxmox`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `api_url` | string | — | Proxmox API URL (e.g., `https://192.168.1.1:8006`). |
| `nodes` | array | — | Node definitions (see below). |
| `network.bridge` | string | `vmbr0` | Network bridge. |
| `network.subnet` | string | — | Subnet for container IPs. |
| `network.gateway` | string | — | Default gateway. |

**Node definition:**

| Key | Type | Description |
|-----|------|-------------|
| `name` | string | Node name (e.g., `pve1`). |
| `host` | string | Node IP or hostname. |
| `role` | string | `datahub`, `agents`, or `both`. |
| `ctid_start` | number | Starting container ID. |

### `deployment.kubernetes`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `namespace` | string | `rivetos` | Kubernetes namespace. |
| `storage_class` | string | — | Storage class for PVCs. |
| `resources.cpu` | string | `500m` | CPU request per agent pod. |
| `resources.memory` | string | `512Mi` | Memory request per agent pod. |

---

## Environment Variables

These are typically set in `.env`:

| Variable | Used By | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | provider-anthropic | Anthropic API key |
| `XAI_API_KEY` | provider-xai | xAI API key |
| `GOOGLE_API_KEY` | provider-google | Google AI API key |
| `DISCORD_BOT_TOKEN` | channel-discord | Discord bot token |
| `TELEGRAM_BOT_TOKEN` | channel-telegram | Telegram bot token |
| `RIVETOS_PG_URL` | memory-postgres | PostgreSQL connection string |
| `RIVETOS_AGENT_SECRET` | channel-agent | **Deprecated** — was the bearer secret for agent mesh. No longer used for agent-channel auth (replaced by mTLS). |
| `RIVETOS_LOG_LEVEL` | core | Log level: `error`, `warn`, `info`, `debug` |
| `RIVETOS_LOG_FORMAT` | core | Log format: `pretty` (default) or `json` |
| `GOOGLE_CSE_ID` | tool-web-search | Google Custom Search Engine ID |
| `GOOGLE_CSE_KEY` | tool-web-search | Google CSE API key |
| `OPENAI_API_KEY` | memory-postgres (embeddings) | OpenAI API key for embeddings |

---

## Full Annotated Example

See [`config.example.yaml`](../config.example.yaml) in the repository root for a complete annotated config file with all options commented.
