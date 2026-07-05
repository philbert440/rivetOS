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
    model: claude-sonnet-4-6
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
| `turn_timeout` | number | `900` | Wall-clock timeout for a single agent turn, in seconds. |
| `context` | object | — | Context-management tuning. `context.soft_nudge_pct` (number[]) and `context.hard_nudge_pct` (number) control when the agent is nudged to compact as the window fills. |
| `skill_dirs` | string[] | `[~/.rivetos/workspace/skills]` | Directories to scan for skills. |
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
| `model` | string | provider default | Model override — use a specific model from this provider instead of its default. Lets several agents share one provider at different models. |
| `default_thinking` | string | `off` | Default thinking level: `off`, `low`, `medium`, `high`. |
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
    model: claude-sonnet-4-6
    max_tokens: 8192
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `model` | string | `claude-opus-4-7` | Model identifier. |
| `max_tokens` | number | `8192` | Maximum output tokens. |
| `api_key` | string | `${ANTHROPIC_API_KEY}` | API key. Prefer env var. |
| `context_window` | number | — | Override the model's context-window size (advanced; for budgeting). |
| `max_output_tokens` | number | — | Hard cap on output tokens, independent of `max_tokens`. |

**Auth:** Set `ANTHROPIC_API_KEY` in `.env`. For subscription/OAuth auth instead of an API key, use the `claude-cli` provider (below), which delegates auth to the `claude` binary.

### xAI (Grok)

```yaml
providers:
  xai:
    model: grok-4.20-reasoning
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `model` | string | `grok-4.20-reasoning` | Model identifier. (`grok-4-1-fast-reasoning` is a cheaper tier good for compaction.) |
| `api_key` | string | `${XAI_API_KEY}` | API key. |
| `max_tokens` | number | `4096` | Maximum output tokens. |
| `temperature` | number | — | Sampling temperature. |
| `context_window` | number | — | Override the model's context-window size (advanced). |
| `max_output_tokens` | number | — | Hard cap on output tokens. |

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
| `context_window` | number | — | Override the model's context-window size (advanced). |
| `max_output_tokens` | number | — | Hard cap on output tokens. |

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
| `num_ctx` | number | — | Context window size passed to Ollama. |
| `keep_alive` | string | — | How long Ollama keeps the model loaded between requests (e.g. `5m`, `-1` for always). |
| `context_window` | number | — | Override the context-window size reported to the runtime (advanced). |
| `max_output_tokens` | number | — | Hard cap on output tokens. |

### vllm

Dedicated provider for a vLLM server. Exposes the full vLLM surface.

- Folds any post-first `system` message into a `user` message with a `[SYSTEM NOTICE]` prefix (vLLM/Qwen/Llama templates reject mid-conversation system messages)
- Consumes vLLM's native `reasoning_content` field when a `--reasoning-parser` is configured server-side
- `model: default` auto-discovers the served model (and its context window) from `/v1/models`

```yaml
providers:
  vllm:
    base_url: http://vllm.local:8000      # trailing /v1 optional
    model: default
    top_k: 40
    min_p: 0.05
    # api_key: ${VLLM_API_KEY}            # only if vLLM started with --api-key
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `base_url` | string | **required** | vLLM server URL (`/v1` optional). |
| `model` | string | `default` | Served model id; `default` auto-discovers. |
| `api_key` | string | `${VLLM_API_KEY}` | Bearer token (only if `--api-key` set). |
| `max_tokens` | number | `4096` | Maximum output tokens. |
| `temperature` | number | `0.7` | Sampling temperature. |
| `top_p` | number | `0.95` | Nucleus sampling. |
| `top_k` | number | — | vLLM sampling extension. |
| `min_p` | number | — | vLLM sampling extension. |
| `presence_penalty` | number | — | Standard OpenAI penalty. |
| `frequency_penalty` | number | — | Standard OpenAI penalty. |
| `repetition_penalty` | number | — | vLLM extension. |
| `min_tokens` | number | — | vLLM extension; minimum output tokens. |
| `stop` | string[] | — | Stop sequences. |
| `seed` | number | — | Reproducible sampling seed. |
| `context_window` | number | — | Context-window size reported to the runtime. |
| `max_output_tokens` | number | — | Hard cap on output tokens. |
| `default_tool_choice` | string | `auto` | `auto`, `none`, or `required`. |
| `verify_model_on_init` | boolean | `false` | Probe `/v1/models` at boot to confirm the model is served. |
| `name` | string | — | Display name for the provider. |
| `mm_processor_kwargs` | object | — | vLLM multimodal processor kwargs (passthrough). |
| `chat_template_kwargs` | object | — | vLLM chat-template kwargs (passthrough). |
| `extra_body` | object | — | Arbitrary JSON merged into the request body (vLLM passthrough). |

### llama-server

Dedicated provider for llama.cpp's `llama-server`. Lean by design — standard OpenAI sampling plus llama.cpp's `top_k` / `min_p` and a generic `extra_body` escape hatch. None of the vLLM-only machinery (no `mm_processor_kwargs`, `chat_template_kwargs`, `repetition_penalty`, `min_tokens`, or video).

For native `<think>` reasoning, start `llama-server` with `--reasoning-format deepseek`.

```yaml
providers:
  llama-server:
    base_url: http://localhost:8080
    model: default
    top_k: 40
    min_p: 0.05
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `base_url` | string | **required** | llama-server URL (`/v1` optional). |
| `model` | string | `default` | Served model id; `default` auto-discovers. |
| `api_key` | string | `${LLAMA_SERVER_API_KEY}` | Bearer token (only if `--api-key` set). |
| `max_tokens` | number | `4096` | Maximum output tokens. |
| `temperature` | number | `0.7` | Sampling temperature. |
| `top_p` | number | `0.95` | Nucleus sampling. |
| `top_k` | number | — | llama.cpp sampling extension. |
| `min_p` | number | — | llama.cpp sampling extension. |
| `presence_penalty` | number | — | Standard OpenAI penalty. |
| `frequency_penalty` | number | — | Standard OpenAI penalty. |
| `stop` | string[] | — | Stop sequences. |
| `seed` | number | — | Reproducible sampling seed. |
| `context_window` | number | — | Context-window size reported to the runtime. |
| `max_output_tokens` | number | — | Hard cap on output tokens. |
| `default_tool_choice` | string | `auto` | `auto`, `none`, or `required`. |
| `verify_model_on_init` | boolean | `false` | Probe `/v1/models` at boot to confirm the model is served. |
| `name` | string | — | Display name for the provider. |
| `extra_body` | object | — | Arbitrary JSON merged into the request body (e.g. `grammar`, `n_probs`). |

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
| `allowed_guilds` | string[] | — | If set, only these guild (server) IDs may interact. |
| `allowed_channels` | string[] | — | If set, only these channel IDs may interact (beyond `channel_bindings`). |
| `allowed_users` | string[] | — | If set, only these user IDs may interact. |
| `mention_only` | boolean | `false` | Only respond when the bot is @-mentioned. |
| `mention_only_channels` | string[] | — | Channel IDs where mention-only mode applies (overrides the global setting per-channel). |

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
| `allowed_users` | string[] | — | Additional Telegram user IDs permitted to interact, beyond `owner_id`. |
| `agent` | string | `default_agent` | Agent that handles this channel. |

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
to each other via mTLS. See [`docs/mesh.md`](/guides/mesh/) for full documentation.

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
| `mesh.secret` | string | — | **Ignored** — mesh agent-channel auth is mTLS only. Accepted with a warning for back-compat; remove it from your config. |

---

## `memory`

Memory backend configuration. Currently supports PostgreSQL.

### PostgreSQL

```yaml
memory:
  postgres:
    connection_string: ${RIVETOS_PG_URL}
    # Optional — point the background memory loop at your own endpoints:
    # embed_endpoint: http://your-embed-host:9402/v1
    # delegation_tracking: true
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `connection_string` | string | `${RIVETOS_PG_URL}` | PostgreSQL connection URL. |
| `embed_endpoint` | string | — | OpenAI-compatible embeddings endpoint used by the embedding worker. Overrides the built-in default. |
| `delegation_tracking` | boolean | `false` | Persist delegation events into memory (`ros_messages`, channel `delegation`) for auditing. |

**Required extensions:** `pgvector` (for embedding storage and similarity search).

The memory plugin handles schema creation and migration automatically on first boot.

---

## `tasks`

Durable task engine (phase 1). The embedded `run-task` runner starts when
Postgres is configured and the `0002_ros_tasks` migration has been applied
(`rivetos-memory-migrate`); on unmigrated nodes it logs a warning and stays
inert instead of failing boot.

| Key | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | Start the embedded task runner. Inert while nothing creates tasks. |

Env knobs: `RIVETOS_TASKS_CONCURRENCY` (default 4), `RIVETOS_TASKS_POLL_MS` (default 2000).

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
