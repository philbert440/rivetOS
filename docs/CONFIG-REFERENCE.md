# Configuration reference

RivetOS uses a single YAML config file for all settings. API keys and secrets go in `.env`, never in the config file.

**Config file locations** (checked in order):

1. `--config` CLI flag
2. `./config.yaml` (current directory)
3. `~/.rivetos/config.yaml`

**Validate without starting:** `rivetos config validate`

---

## Quick example

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
  # social channels removed Phase 5 — use RivetHub

memory:
  postgres: {}
```

---

## Environment variable resolution

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

| Key             | Type     | Default                         | Description                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------- | -------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `workspace`     | string   | **required**                    | Path to workspace directory containing CORE.md, USER.md, etc.                                                                                                                                                                                                                                                                                                                                          |
| `default_agent` | string   | **required**                    | Agent to use when no channel binding matches. Must match a key in `agents`.                                                                                                                                                                                                                                                                                                                            |
| `turn_timeout`  | number   | `900`                           | Wall-clock timeout for a single agent turn, in seconds.                                                                                                                                                                                                                                                                                                                                                |
| `context`       | object   | —                               | Context-management tuning. `context.soft_nudge_pct` (number[]) and `context.hard_nudge_pct` (number) control when the agent is nudged to compact as the window fills.                                                                                                                                                                                                                                  |
| `skill_dirs`    | string[] | `[~/.rivetos/workspace/skills]` | Directories to scan for skills.                                                                                                                                                                                                                                                                                                                                                                        |
| `plugin_dirs`   | string[] | `[]`                            | Additional directories to scan for plugins beyond the default `plugins/`.                                                                                                                                                                                                                                                                                                                              |
| `experimental`  | boolean  | `false` (omit)                  | Nightly / experimental switch. When `true`, boot sets `RIVETOS_EXPERIMENTAL=1` on the env map passed wholesale to den-server `loadConfig` (same map the in-process gateway builds). Not process-env prefix passthrough (`RIVETOS_DEN_*` / `RIVETOS_USER*`). den-server currently has no dedicated field for the key; it is present on the env object den is constructed from. Stable installs omit it. |

### `runtime.heartbeats`

Array of scheduled agent tasks. Each heartbeat triggers the agent periodically.

```yaml
runtime:
  heartbeats:
    - agent: opus
      schedule: '*/30 * * * *' # Every 30 minutes
      prompt: 'Check for unread emails and calendar events.'
      output_channel: '' # no social channel output
      timezone: America/New_York
      quiet_hours:
        start: 23
        end: 8
```

| Key                 | Type   | Default      | Description                                                    |
| ------------------- | ------ | ------------ | -------------------------------------------------------------- |
| `agent`             | string | **required** | Which agent runs this heartbeat. Must match a key in `agents`. |
| `schedule`          | string | **required** | Cron expression (e.g., `*/30 * * * *` = every 30 min).         |
| `prompt`            | string | **required** | The message sent to the agent on each heartbeat tick.          |
| `output_channel`    | string | —            | Channel to deliver output (format: `platform:channel_id`).     |
| `timezone`          | string | `UTC`        | Timezone for schedule evaluation.                              |
| `quiet_hours.start` | number | —            | Hour (0-23) to start quiet period (no heartbeats).             |
| `quiet_hours.end`   | number | —            | Hour (0-23) to end quiet period.                               |

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

| Key                          | Type     | Default                       | Description                                             |
| ---------------------------- | -------- | ----------------------------- | ------------------------------------------------------- |
| `shellDanger`                | boolean  | `true`                        | Block dangerous shell commands (rm -rf /, etc.).        |
| `audit`                      | boolean  | `true`                        | Log all tool executions to audit log.                   |
| `workspaceFence`             | object   | —                             | Restrict file/shell operations to specific directories. |
| `workspaceFence.allowedDirs` | string[] | **required if fence enabled** | Directories the agent can access.                       |
| `workspaceFence.alwaysAllow` | string[] | `[]`                          | Paths always allowed regardless of fence.               |
| `workspaceFence.tools`       | string[] | all tools                     | Which tools the fence applies to.                       |

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

| Key        | Type    | Default | Description                             |
| ---------- | ------- | ------- | --------------------------------------- |
| `format`   | boolean | `false` | Auto-format files after edits.          |
| `lint`     | boolean | `false` | Auto-lint files after edits.            |
| `test`     | boolean | `false` | Auto-run tests after code changes.      |
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

| Key                | Type     | Default          | Description                                                                                                                                  |
| ------------------ | -------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider`         | string   | **required**     | Provider ID. Must match a key in `providers`.                                                                                                |
| `model`            | string   | provider default | Model override — use a specific model from this provider instead of its default. Lets several agents share one provider at different models. |
| `default_thinking` | string   | `off`            | Default thinking level: `off`, `low`, `medium`, `high`.                                                                                      |
| `local`            | boolean  | `false`          | If true, uses extended workspace context (includes CAPABILITIES.md, daily notes). Use for local models where tokens are free.                |
| `tools.exclude`    | string[] | `[]`             | Tool names to block for this agent.                                                                                                          |
| `tools.include`    | string[] | all              | If set, only these tools are available to this agent.                                                                                        |

---

## `providers`

LLM provider configuration. Each key is a provider ID referenced by agents.

### OpenAI Codex CLI (ChatGPT subscription)

```yaml
providers:
  codex-cli:
    model: default
    sandbox: read-only
    session: resume
```

Runs `codex exec --json` using the same login as the Codex TUI. Install Codex, run `codex login`, and add `@rivetos/provider-codex-cli` to `plugins`; no `OPENAI_API_KEY` is required. RivetOS unsets every `OPENAI_*` variable in the child environment so a stray API key cannot silently bill the API instead of the ChatGPT subscription. `model: default` follows the CLI's configured model. Codex uses its own tools in the sandbox — RivetOS tools are not forwarded.

Options are `binary`, `model`, `reasoning_effort` (`low` through `xhigh`), `cwd`, `sandbox` (`read-only`, `workspace-write`, or `danger-full-access`), `approve_for_me`, `skip_git_repo_check`, `profile`, `session` (`resume` or `replay`), `context_window`, and `max_output_tokens`. The default sandbox is `read-only`; broaden it deliberately. `skip_git_repo_check` defaults to `true` only for `read-only`; for `workspace-write` and `danger-full-access` it defaults to `false` (set the key explicitly to override). Prefer an explicit `cwd` when widening the sandbox.

### Anthropic

```yaml
providers:
  anthropic:
    model: claude-sonnet-4-6
    max_tokens: 8192
```

| Key                        | Type     | Default                | Description                                                                |
| -------------------------- | -------- | ---------------------- | -------------------------------------------------------------------------- |
| `model`                    | string   | `claude-opus-4-7`      | Model identifier.                                                          |
| `max_tokens`               | number   | `8192`                 | Maximum output tokens.                                                     |
| `api_key`                  | string   | `${ANTHROPIC_API_KEY}` | API key. Prefer env var.                                                   |
| `token_command`            | string[] | —                      | Argv that prints a bearer token on stdout (no shell). Wins over `api_key`. |
| `token_ttl_ms`             | number   | `300000`               | Cache lifetime for a minted token.                                         |
| `token_command_timeout_ms` | number   | `5000`                 | Mint timeout; the helper is SIGKILL'd on expiry.                           |
| `context_window`           | number   | —                      | Override the model's context-window size (advanced; for budgeting).        |
| `max_output_tokens`        | number   | —                      | Hard cap on output tokens, independent of `max_tokens`.                    |

**Auth:** Set `ANTHROPIC_API_KEY` in `.env`, or set `token_command` to an argv helper that mints a short-lived token (cached, reminted on expiry or HTTP 401). For subscription/OAuth auth instead of an API key, use the `claude-cli` provider (below), which delegates auth to the `claude` binary.

### xAI (Grok)

```yaml
providers:
  xai:
    model: grok-4.20-reasoning
```

| Key                        | Type     | Default               | Description                                                                          |
| -------------------------- | -------- | --------------------- | ------------------------------------------------------------------------------------ |
| `model`                    | string   | `grok-4.20-reasoning` | Model identifier. (`grok-4-1-fast-reasoning` is a cheaper tier good for compaction.) |
| `api_key`                  | string   | `${XAI_API_KEY}`      | API key.                                                                             |
| `token_command`            | string[] | —                     | Argv that prints a bearer token on stdout (no shell). Wins over `api_key`.           |
| `token_ttl_ms`             | number   | `300000`              | Cache lifetime for a minted token.                                                   |
| `token_command_timeout_ms` | number   | `5000`                | Mint timeout; the helper is SIGKILL'd on expiry.                                     |
| `max_tokens`               | number   | `4096`                | Maximum output tokens.                                                               |
| `temperature`              | number   | —                     | Sampling temperature.                                                                |
| `context_window`           | number   | —                     | Override the model's context-window size (advanced).                                 |
| `max_output_tokens`        | number   | —                     | Hard cap on output tokens.                                                           |

### Google (Gemini)

```yaml
providers:
  google:
    model: gemini-2.5-pro
```

| Key                 | Type   | Default             | Description                                          |
| ------------------- | ------ | ------------------- | ---------------------------------------------------- |
| `model`             | string | `gemini-2.5-pro`    | Model identifier.                                    |
| `api_key`           | string | `${GOOGLE_API_KEY}` | API key.                                             |
| `max_tokens`        | number | `8192`              | Maximum output tokens.                               |
| `context_window`    | number | —                   | Override the model's context-window size (advanced). |
| `max_output_tokens` | number | —                   | Hard cap on output tokens.                           |

### Ollama

```yaml
providers:
  ollama:
    model: qwen2.5:32b
    base_url: http://localhost:11434
```

| Key                 | Type   | Default                  | Description                                                                           |
| ------------------- | ------ | ------------------------ | ------------------------------------------------------------------------------------- |
| `model`             | string | **required**             | Model name (must be pulled locally).                                                  |
| `base_url`          | string | `http://localhost:11434` | Ollama API endpoint.                                                                  |
| `temperature`       | number | —                        | Sampling temperature.                                                                 |
| `num_ctx`           | number | —                        | Context window size passed to Ollama.                                                 |
| `keep_alive`        | string | —                        | How long Ollama keeps the model loaded between requests (e.g. `5m`, `-1` for always). |
| `context_window`    | number | —                        | Override the context-window size reported to the runtime (advanced).                  |
| `max_output_tokens` | number | —                        | Hard cap on output tokens.                                                            |

### vllm

Dedicated provider for a vLLM server. Exposes the full vLLM surface.

- Folds any post-first `system` message into a `user` message with a `[SYSTEM NOTICE]` prefix (vLLM/Qwen/Llama templates reject mid-conversation system messages)
- Consumes vLLM's native `reasoning_content` field when a `--reasoning-parser` is configured server-side
- `model: default` auto-discovers the served model (and its context window) from the models listing (`<base><api_prefix>/models`)

```yaml
providers:
  vllm:
    base_url: http://vllm.local:8000 # trailing /v1 optional
    model: default
    top_k: 40
    min_p: 0.05
    # api_key: ${VLLM_API_KEY}            # only if vLLM started with --api-key
```

z.ai / GLM (OpenAI-compatible coding endpoint has no `/v1` segment — `api_prefix: ""` is enough; models listing is at `<base>/models`):

```yaml
providers:
  vllm:
    name: GLM (Z.ai)
    base_url: https://api.z.ai/api/coding/paas/v4
    api_prefix: ''
    api_key: ${ZAI_API_KEY}
    model: glm-5.3-flash
```

Use `models_url` only if the models listing lives somewhere other than `<base><api_prefix>/models`.

| Key                        | Type     | Default           | Description                                                                                                |
| -------------------------- | -------- | ----------------- | ---------------------------------------------------------------------------------------------------------- |
| `base_url`                 | string   | **required**      | vLLM server URL (`/v1` optional; stripped and re-appended via `api_prefix`).                               |
| `api_prefix`               | string   | `"/v1"`           | OpenAI-compat path prefix. `""` means none (chat at `<base>/chat/completions`).                            |
| `models_url`               | string   | —                 | Optional absolute URL when the models listing is hosted elsewhere (overrides `<base><api_prefix>/models`). |
| `probe_models`             | boolean  | `true`            | When `false`, skip the models probe/discovery and treat the provider as available.                         |
| `model`                    | string   | `default`         | Served model id; `default` auto-discovers.                                                                 |
| `api_key`                  | string   | `${VLLM_API_KEY}` | Bearer token (only if `--api-key` set).                                                                    |
| `token_command`            | string[] | —                 | Argv that prints a bearer token on stdout (no shell). Wins over `api_key`.                                 |
| `token_ttl_ms`             | number   | `300000`          | Cache lifetime for a minted token.                                                                         |
| `token_command_timeout_ms` | number   | `5000`            | Mint timeout; the helper is SIGKILL'd on expiry.                                                           |
| `models`                   | string[] | —                 | Static model catalog floor for `listModels()` (building block — no UI/harness reader yet; floor first).    |
| `models_ttl_ms`            | number   | `60000`           | Background refresh interval for the endpoint model catalog (`listModels()` building block).                |
| `max_tokens`               | number   | `4096`            | Maximum output tokens.                                                                                     |
| `temperature`              | number   | `0.7`             | Sampling temperature.                                                                                      |
| `top_p`                    | number   | `0.95`            | Nucleus sampling.                                                                                          |
| `top_k`                    | number   | —                 | vLLM sampling extension.                                                                                   |
| `min_p`                    | number   | —                 | vLLM sampling extension.                                                                                   |
| `presence_penalty`         | number   | —                 | Standard OpenAI penalty.                                                                                   |
| `frequency_penalty`        | number   | —                 | Standard OpenAI penalty.                                                                                   |
| `repetition_penalty`       | number   | —                 | vLLM extension.                                                                                            |
| `min_tokens`               | number   | —                 | vLLM extension; minimum output tokens.                                                                     |
| `stop`                     | string[] | —                 | Stop sequences.                                                                                            |
| `seed`                     | number   | —                 | Reproducible sampling seed.                                                                                |
| `context_window`           | number   | —                 | Context-window size reported to the runtime.                                                               |
| `max_output_tokens`        | number   | —                 | Hard cap on output tokens.                                                                                 |
| `default_tool_choice`      | string   | `auto`            | `auto`, `none`, or `required`.                                                                             |
| `verify_model_on_init`     | boolean  | `false`           | Reject availability when the pinned model is missing from the models listing.                              |
| `name`                     | string   | —                 | Display name for the provider.                                                                             |
| `mm_processor_kwargs`      | object   | —                 | vLLM multimodal processor kwargs (passthrough).                                                            |
| `chat_template_kwargs`     | object   | —                 | vLLM chat-template kwargs (passthrough).                                                                   |
| `extra_body`               | object   | —                 | Arbitrary JSON merged into the request body (vLLM passthrough).                                            |

### llama-server

Dedicated provider for llama.cpp's `llama-server`. Lean by design: standard OpenAI sampling plus llama.cpp's `top_k` / `min_p` and a generic `extra_body` escape hatch. None of the vLLM-only machinery (no `mm_processor_kwargs`, `chat_template_kwargs`, `repetition_penalty`, `min_tokens`, or video).

For native `<think>` reasoning, start `llama-server` with `--reasoning-format deepseek`.

```yaml
providers:
  llama-server:
    base_url: http://localhost:8080
    model: default
    top_k: 40
    min_p: 0.05
```

| Key                        | Type     | Default                   | Description                                                                                 |
| -------------------------- | -------- | ------------------------- | ------------------------------------------------------------------------------------------- |
| `base_url`                 | string   | **required**              | llama-server URL (`/v1` optional).                                                          |
| `model`                    | string   | `default`                 | Served model id; `default` auto-discovers.                                                  |
| `api_key`                  | string   | `${LLAMA_SERVER_API_KEY}` | Bearer token (only if `--api-key` set).                                                     |
| `token_command`            | string[] | —                         | Argv that prints a bearer token on stdout (no shell). Wins over `api_key`.                  |
| `token_ttl_ms`             | number   | `300000`                  | Cache lifetime for a minted token.                                                          |
| `token_command_timeout_ms` | number   | `5000`                    | Mint timeout; the helper is SIGKILL'd on expiry.                                            |
| `models`                   | string[] | —                         | Static model catalog floor for `listModels()` (building block — no UI/harness reader yet).  |
| `models_ttl_ms`            | number   | `60000`                   | Background refresh interval for the endpoint model catalog (`listModels()` building block). |
| `max_tokens`               | number   | `4096`                    | Maximum output tokens.                                                                      |
| `temperature`              | number   | `0.7`                     | Sampling temperature.                                                                       |
| `top_p`                    | number   | `0.95`                    | Nucleus sampling.                                                                           |
| `top_k`                    | number   | —                         | llama.cpp sampling extension.                                                               |
| `min_p`                    | number   | —                         | llama.cpp sampling extension.                                                               |
| `presence_penalty`         | number   | —                         | Standard OpenAI penalty.                                                                    |
| `frequency_penalty`        | number   | —                         | Standard OpenAI penalty.                                                                    |
| `stop`                     | string[] | —                         | Stop sequences.                                                                             |
| `seed`                     | number   | —                         | Reproducible sampling seed.                                                                 |
| `context_window`           | number   | —                         | Context-window size reported to the runtime.                                                |
| `max_output_tokens`        | number   | —                         | Hard cap on output tokens.                                                                  |
| `default_tool_choice`      | string   | `auto`                    | `auto`, `none`, or `required`.                                                              |
| `verify_model_on_init`     | boolean  | `false`                   | Probe `/v1/models` at boot to confirm the model is served.                                  |
| `name`                     | string   | —                         | Display name for the provider.                                                              |
| `extra_body`               | object   | —                         | Arbitrary JSON merged into the request body (e.g. `grammar`, `n_probs`).                    |

### claude-cli

Drives the local `claude` binary (Claude Code CLI) using the user's subscription OAuth token, the sanctioned third-party-harness pattern per Anthropic's April 2026 policy. The CLI owns auth, session caching, and the wire protocol; this provider drives it via `stream-json` and brings up a per-spawn embedded MCP server that exposes every executable RivetOS tool to claude-cli through `--mcp-config`.

```yaml
providers:
  claude-cli:
    binary: claude # path or name on PATH
    model: claude-opus-4-7 # optional — defaults to whatever the CLI picks
```

| Key                       | Type           | Default   | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------- | -------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `binary`                  | string         | `claude`  | Path to the `claude` binary.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `model`                   | string         | —         | Model alias to pass to the CLI.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `extra_args`              | string[]       | `[]`      | Additional CLI flags (advanced).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `allowed_api_key_sources` | string[]       | —         | Extra `apiKeySource` values besides `none`. Unset keeps the OAuth-only gate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `permission_mode`         | string         | `default` | `--permission-mode`. The provider code default is `default` (Claude Code's manual mode). `dontAsk` elsewhere in this document is the grok-cli default and matches that provider's code; it is not this provider's default.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `permission_prompts`      | `ui` \| `none` | unset     | Headless claude-code task executor only (not the interactive chat path). Unset passes no `--permission-prompts` flag, so the CLI invocation is unchanged. `none` passes `--permission-prompts none` and the CLI denies a prompt immediately instead of waiting out its decision timeout. `ui` passes `--permission-prompts host` and `--permission-prompt-tool mcp__rivetos__request_permission`. The embedded bridge parks the call, emits an approval-request, and returns the decision. Answer from the task page or `POST /api/tasks/:id/approvals/:requestId` with `{"decision":"allow"\|"deny"}`. Unanswered prompts deny after `permission_timeout_ms` (default 60s); the outcome is appended to the row at `spec.permissionDecisions`. `GET /api/tasks/:id/wait?onApproval=return` yields the parked prompt instead of blocking until the task ends. The default wait does not. |
| `permission_timeout_ms`   | number         | `60000`   | How long a headless `ui` prompt stays parked before it denies. Positive integer, at most 600000. Unset uses 60000. The interactive chat path does not read this key.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

**Auth:** `claude login` (via the CLI itself). RivetOS does not handle the OAuth flow; the CLI does. On system init, a reported `apiKeySource` other than `none` kills the spawn unless it is listed in `allowed_api_key_sources`. Set that only for an Anthropic-compatible proxy the CLI reaches through its own `apiKeyHelper` (the value is the source string the CLI prints, matched exactly). The default stays unset: subscription OAuth is the sanctioned pattern, and API-key auth bills the console. Listing a source does not stop RivetOS from deleting `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` on the child.

### opencode-cli

Drives the local OpenCode CLI (`opencode`) for harness id `opencode` by shelling `opencode run --format json`. Default `model` is `zai/glm-5.3-flash`. The installed CLI owns backend, endpoint, and credentials. RivetOS sets no HTTP protocol. Add `@rivetos/provider-opencode-cli` to `plugins`.

```yaml
providers:
  opencode-cli:
    binary: opencode # path or name on PATH
    # model: zai/glm-5.3-flash  # RivetOS default --model; CLI owns backend
```

| Key      | Type   | Default             | Description                   |
| -------- | ------ | ------------------- | ----------------------------- |
| `binary` | string | `opencode`          | Path or name on PATH.         |
| `model`  | string | `zai/glm-5.3-flash` | Model id passed as `--model`. |

**Auth:** The installed OpenCode CLI owns backend, endpoint, and credentials. RivetOS sets no HTTP protocol and ships no OpenCode key or OAuth.

### pi-cli

Drives the local `pi` binary (`@earendil-works/pi-coding-agent`) headlessly — print/JSON or RPC. Harness id is `pi`; roster command is `pi`. Recommended default backend is z.ai GLM (reuse the coding-plan / Anthropic-compat key). Add `@rivetos/provider-pi-cli` to `plugins`.

```yaml
providers:
  pi-cli:
    binary: pi # path or name on PATH
    # model: glm-4.6 # optional — omit for the CLI's configured model
```

| Key      | Type   | Default | Description                     |
| -------- | ------ | ------- | ------------------------------- |
| `binary` | string | `pi`    | Path to the `pi` binary.        |
| `model`  | string | —       | Model alias to pass to the CLI. |

**Auth:** whatever backend `pi` is configured to use (z.ai GLM recommended). RivetOS does not ship a dedicated `pi` API key; reuse the coding-plan credentials.

### qwen-code

Drives the local `qwen` binary (`@qwen-code/qwen-code`) headlessly — `-p` plus Claude-shaped stream-json. Harness id is `qwen-code`; roster command is `qwen`; provider id matches harness id. Add `@rivetos/provider-qwen-code` to `plugins`.

```yaml
providers:
  qwen-code:
    binary: qwen # path or name on PATH; $QWEN_BINARY when unset
    # model: qwen3-coder-plus # optional — omit for the CLI's configured model
    # home: ~/.qwen # accepted for parity with the other CLI providers; currently unused (RivetOS reads the node's ~/.qwen; qwen itself always writes there)
```

| Key                 | Type   | Default   | Description                                                                                                                               |
| ------------------- | ------ | --------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `binary`            | string | `qwen`    | Path to the `qwen` binary. `$QWEN_BINARY` overrides when `binary` is unset (provider + setup script).                                     |
| `model`             | string | —         | Model id passed via `-m`. Optional.                                                                                                       |
| `home`              | string | `~/.qwen` | Accepted for parity with the other CLI providers; currently unused (RivetOS reads the node's `~/.qwen`; qwen itself always writes there). |
| `cwd`               | string | —         | Working directory for the spawn.                                                                                                          |
| `name`              | string | —         | Display name for the provider.                                                                                                            |
| `context_window`    | number | —         | Context-window size reported to the runtime.                                                                                              |
| `max_output_tokens` | number | —         | Hard cap on output tokens.                                                                                                                |

qwen-code 0.23.4 has no env or flag to relocate `~/.qwen`; qwen always writes there. `$QWEN_HOME` is the same RivetOS-side lookup override for `rivetos plugins install`, `rivetos doctor`, and the setup script.

**Auth:** OpenAI-compatible / API-key only (Qwen OAuth free tier is discontinued). Configure `modelProviders` in `~/.qwen/settings.json`. Effort is per-model (`capabilities.reasoning.efforts`); there is no CLI `--effort` flag.

---

## `channels`

Messaging channel configuration. Each key is a channel type / plugin name.

> **Phase 5:** Telegram, Discord, and voice-discord channel plugins were **removed**.
> Human UX is RivetHub. Optional remaining first-party channel: `channels.agent` (mesh).
> Stale `channels.telegram:` / `channels.discord:` / `channels.voice*` in fleet config yields an
> **unknown channel type warning** at boot; registration is skipped; nodes do not crash-loop.

### grok-cli

Drives the local Grok Build `grok` binary headlessly — one `grok -p <prompt> --output-format streaming-messages-json --include-partial-messages` call per turn — on the user's Grok Build subscription (OIDC login in `~/.grok`), not the metered xAI API. The CLI owns auth and its own tools/MCP servers. Default `session: resume` keeps one grok session per RivetOS conversation (`--session-id` on the first turn with the full transcript, `--resume` after with only the newest user turn). `session: replay` re-sends the whole conversation every turn. NDJSON `stream_event` deltas (reasoning, text) are emitted as they arrive; usage, `sessionId`, and cost come from the final `result` line. This is what lets `provider: grok-cli` agents answer mesh delegations, heartbeat tasks and chat.

```yaml
providers:
  grok-cli:
    binary: ~/.grok/bin/grok # default ~/.grok/bin/grok, then `grok` on PATH
    # model: grok-4.5                    # optional; omit for the CLI's configured model
    permission_mode: dontAsk # tools denied unless `allow` rules cover them
    reasoning_effort: medium # low|medium|high; a turn's `thinking` overrides
    # max_turns: 20                      # optional cap; omit to let grok decide
    no_plan: true
    system_prompt: prepend # prepend | override | off
    session: resume # resume | replay
    cwd: ~/.rivetos/workspace
    # allow: [Read, Grep]                # --allow rules for tool-using turns
```

| Key                | Default                         | Notes                                                                                                                                                                                          |
| ------------------ | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `binary`           | `~/.grok/bin/grok`, else `grok` | Grok Build CLI. `isAvailable()` = `grok --version` exits 0.                                                                                                                                    |
| `model`            | CLI default (optional)          | Passed as `-m` when set. Omit to use the CLI's configured model.                                                                                                                               |
| `permission_mode`  | `dontAsk`                       | `--permission-mode`. `dontAsk` auto-denies tools not covered by `allow`.                                                                                                                       |
| `reasoning_effort` | CLI default                     | `--reasoning-effort`. Per-turn `thinking` (`low`/`medium`/`high`+) overrides.                                                                                                                  |
| `max_turns`        | unset                           | `--max-turns`, only passed when set. Unset lets grok run its tool loop to completion; `1` = answer only, and any tool call then ends the turn as `error_max_turns`.                            |
| `no_plan`          | `true`                          | `--no-plan` — plan mode would swallow a headless run.                                                                                                                                          |
| `system_prompt`    | `prepend`                       | `prepend` = RivetOS system prompt at the top of the prompt, grok keeps its own; `override` = `--system-prompt-override`; `off` = dropped. Applies on first turn and on later `--resume` turns. |
| `session`          | `resume`                        | `resume` = one grok session per RivetOS conversation (`~/.rivetos/grok-cli-sessions.json`). `replay` = full transcript every turn, no session flags.                                           |
| `allow`            | —                               | List of `--allow` rules (Claude Code rule syntax).                                                                                                                                             |
| `tools`            | —                               | `--tools` pass-through.                                                                                                                                                                        |
| `cwd`              | —                               | Working directory for the spawned grok (`--cwd`).                                                                                                                                              |

Limits: incremental streaming is live. `streaming-messages-json` prints NDJSON `stream_event` deltas as they arrive. The older `--output-format json` blob is only a fallback when a turn emits no NDJSON and exits 0. There is no RivetOS tool bridge (grok cannot call `delegate_task`/`memory_*` as RivetOS tools; it has its own MCP servers from `~/.grok/config.toml`). Session capture is the rivet-memory Grok hooks' job.

---

## `channels`

Messaging channel configuration. Each key is a channel type / plugin name.

> **Phase 5:** Telegram, Discord, and voice-discord channel plugins were **removed**.
> Human UX is RivetHub. Optional remaining first-party channel: `channels.agent` (mesh).
> Stale `channels.telegram:` / `channels.discord:` / `channels.voice*` in fleet config yields an
> **unknown channel type warning** at boot; registration is skipped; nodes do not crash-loop.

### Agent (HTTP)

Inter-agent communication channel. Enables delegation between agents and mesh networking.

> **Note:** for cross-node (mesh) auth, `secret` is superseded by mutual TLS
> (`mesh.tls`) as of Phase 0.5; configure `mesh:` for node-to-node traffic.
> The standalone `channels.agent` plugin **still enforces** its bearer
> `secret` when configured; it is deprecated, not dead. The plugin's fate is
> decided when the gateway subsumes agent HTTP ingress (phase 1/5).

```yaml
channels:
  agent:
    port: 3100
    secret: ${AGENT_CHANNEL_SECRET} # still enforced by this plugin when set
```

| Key      | Type   | Default | Description                                                                                                                                                 |
| -------- | ------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `port`   | number | `3100`  | HTTPS port for agent-to-agent messaging.                                                                                                                    |
| `secret` | string | —       | **Deprecated but enforced.** Bearer token checked by the standalone agent channel plugin when set. Mesh node-to-node auth uses mTLS via `mesh.tls` instead. |

---

## `mesh`

Multi-node mesh networking. Allows agents on different nodes to delegate tasks
to each other via mTLS. See [`docs/mesh.md`](mesh.md) for full documentation.

```yaml
mesh:
  enabled: true
  node_name: <node_name> # must match the cert CN
  tls: true # default cert paths derived from node_name and RIVETOS_SHARED_DIR
  agent_channel_port: 3000
  # storage_dir omitted → $RIVETOS_SHARED_DIR (unset → product default shared root)
  heartbeat_interval_ms: 30000
  stale_threshold_ms: 90000
  discovery:
    mode: seed
    seed_host: <node_name>.mesh # use .mesh DNS — matches cert SAN
    seed_port: 3000
```

| Key                          | Type           | Default                                                  | Description                                                                                                              |
| ---------------------------- | -------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `mesh.enabled`               | bool           | `false`                                                  | Enable mesh networking.                                                                                                  |
| `mesh.node_name`             | string         | hostname                                                 | Node name — **must match cert CN**.                                                                                      |
| `mesh.tls`                   | bool \| object | —                                                        | mTLS config. **Required** when `mesh.enabled: true`.                                                                     |
| `mesh.tls.ca_path`           | string         | `$RIVETOS_SHARED_DIR/rivet-ca/intermediate/ca-chain.pem` | CA chain PEM. Unset `RIVETOS_SHARED_DIR` → product default.                                                              |
| `mesh.tls.cert_path`         | string         | `$RIVETOS_SHARED_DIR/rivet-ca/issued/<node_name>.crt`    | Node cert PEM.                                                                                                           |
| `mesh.tls.key_path`          | string         | `$RIVETOS_SHARED_DIR/rivet-ca/issued/<node_name>.key`    | Node private key PEM.                                                                                                    |
| `mesh.agent_channel_port`    | number         | `3000`                                                   | HTTPS port for the agent channel.                                                                                        |
| `mesh.storage_dir`           | string         | `$RIVETOS_SHARED_DIR` (unset → product default)          | Directory containing `mesh.json`.                                                                                        |
| `mesh.heartbeat_interval_ms` | number         | `30000`                                                  | Heartbeat write interval.                                                                                                |
| `mesh.stale_threshold_ms`    | number         | `90000`                                                  | Age before a node is marked stale.                                                                                       |
| `mesh.discovery.mode`        | string         | —                                                        | `seed` \| `static` \| `mdns`.                                                                                            |
| `mesh.discovery.seed_host`   | string         | —                                                        | Seed node hostname (use `<nodeName>.mesh`).                                                                              |
| `mesh.discovery.seed_port`   | number         | `3100`                                                   | Seed node port.                                                                                                          |
| `mesh.secret`                | string         | —                                                        | **Ignored** — mesh agent-channel auth is mTLS only. Accepted with a warning for back-compat; remove it from your config. |

---

## `den`

Embedded node gateway (den-server in-process). Off by default. See [`docs/DEN.md`](DEN.md) and [`docs/GATEWAY-MTLS.md`](GATEWAY-MTLS.md). Independent of `mesh.discovery.mode`.

```yaml
den:
  enabled: true
  host: 127.0.0.1
  port: 5174
  advertise_mdns: false
  # Off-loopback (host: 0.0.0.0) will not boot without TLS:
  # tls_cert: $RIVETOS_SHARED_DIR/rivet-ca/issued/<node_name>.crt
  # tls_key: $RIVETOS_SHARED_DIR/rivet-ca/issued/<node_name>.key
```

| Key                 | Type     | Default                                          | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------- | -------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`           | boolean  | `false`                                          | Embed the den gateway in this process.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `host`              | string   | `127.0.0.1`                                      | Bind address. Off-loopback requires TLS.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `port`              | number   | `5174`                                           | HTTP/WS (or HTTPS) port.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `tls_cert`          | string   | —                                                | Node TLS cert PEM path. Required off-loopback. Env: `RIVETOS_DEN_TLS_CERT`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `tls_key`           | string   | —                                                | Node TLS key PEM path. Env: `RIVETOS_DEN_TLS_KEY`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `token`             | string   | —                                                | Legacy; ignored. Gateway auth is device mTLS.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `terminal`          | object   | —                                                | Local PTY terminals. Off by default. See `den.terminal.*`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `static_dir`        | string   | hub dist                                         | Override for the built hub app served at `/`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `root_redirect`     | string   | —                                                | 302 target for `GET /`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `files_root`        | string   | `$RIVETOS_SHARED_DIR` (unset → product default)  | Shared filestore root for `/api/files/*`. Empty string disables the routes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `files_open`        | boolean  | —                                                | Opt-out of the files security gate. Defaults to `terminal.open` when unset.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `devices`           | object   | —                                                | Mesh device enrollment (Settings → Devices). Off unless `devices.enabled`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `advertise_mdns`    | boolean  | `false`                                          | Publish `_rivethub._tcp` via mDNS so LAN apps can find this node. No-op unless the gateway actually started.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `allowed_origins`   | string[] | —                                                | Extra browser origins (`scheme://host[:port]`) allowed to call the gateway. See **Browser origin policy** below. Env: `RIVETOS_DEN_ALLOWED_ORIGINS`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `allowed_hosts`     | string[] | —                                                | Extra `Host` names a plain-HTTP (no TLS) gateway accepts from loopback callers, e.g. a local reverse proxy's name. Env: `RIVETOS_DEN_ALLOWED_HOSTS`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `allowed_harnesses` | string[] | `RIVETOS_DEN_ALLOWED_HARNESSES` (standalone den) | Harness ids this node offers for **new** launches (Agents picker, `POST /term`, control-plane session create, harness-session tasks). Unset = every registered harness. Empty = none. Unknown ids warn at validate time. Boot copies the YAML key onto the embedded den; a standalone den reads the env (comma/space list). `GET /api/harnesses` stamps `allowed` when set; off-list create/spawn/preset/task is refused (`harness_not_allowed`). Existing sessions / real resumes still work; a never-seen resume key on `/term` or `POST /api/harnesses/:id/sessions` does not mint an off-list spawn. The task runner re-checks on the node that claims the row (legacy `claude-cli` targets canonicalize to `claude-code` first). |

**Harness allow-list.** When `den.allowed_harnesses` is set, the den stamps each `GET /api/harnesses` row with `allowed: true|false` (alongside `installed`). RivetHub web and Android **new-conversation / Agents** pickers keep only rows where `installed !== false` and `allowed !== false` (absent fields count as true, so older dens and unset allow-lists behave as today). Existing-session drawers still list off-list harnesses so previously started sessions remain visible and resumable. A fresh spawn, preset save, or harness-session task that names an off-list harness is refused with `harness_not_allowed` (HTTP 403). Resumes of existing sessions still work when the resume target exists. The task runner enforces the list on the node that claims the row.

**Phone pairing.** Den redeems pairing codes at `POST /api/devices/pair` from
the records in `RIVETOS_DEN_PAIRING_DIR` (default `~/.rivetos/devices/pairing`).
The CLI (`rivetos pair` / `rivetos local --device`) reads the same variable when
writing records, so both sides stay on one directory; device PKCS#12 files still
land under `~/.rivetos/devices/` and den deletes them from there after redeem.
Settings → Pair a phone runs the CLI named by `RIVETOS_DEN_PAIR_CLI` (default
`$RIVETOS_ROOT/packages/cli/dist/index.js`; the in-process gateway passes the
install's own CLI) as `rivetos pair <name> --json`, and `rivetos pair --check
--json` to decide whether to offer pairing at all. The QR points at `den.host`
when that is a concrete address, else the node's first LAN address.

**Browser origin policy.** The gateway answers a browser only when the request's `Origin` is one of:

- the gateway itself (same host and port — the RivetHub web app it serves);
- the RivetHub desktop app (`app://bundle`);
- another den in the mesh roster (`mesh.json`), so cross-node RivetHub works without configuration;
- an entry in `den.allowed_origins`.

Requests without an `Origin` (the Android app, hooks, CLI tools, mesh peers) are unaffected. Any other origin gets `403`, on HTTP requests and on WebSocket upgrades alike, and no response ever carries `Access-Control-Allow-Origin: *`. On a plain-HTTP gateway, loopback callers must also address it by a loopback name (`127.0.0.1`, `localhost`, `[::1]`, `*.localhost`) or a name in `den.allowed_hosts`. If you open RivetHub through a name the mesh roster doesn't list (a Tailscale MagicDNS name, a reverse proxy), add that origin to `den.allowed_origins` on the nodes it calls.

---

## `memory`

Memory backend configuration. Supported backends: `postgres` (default path today) and
`sqlite` (opt-in file store for the in-process `Memory` contract). Set exactly one — both
together is a validation error. Optional `memory.capture` controls write-path behaviour
for harness capture hooks that post through `@rivetos/capture-core`.

### Capture redaction

Off by default. When enabled, `@rivetos/capture-core` redacts common secret
shapes (and optional operator regexes) in message `content`, `tool_result`, and
`tool_args` **before** the batch is posted or spooled. Logs report a span count
only — never the matched text. Placeholders are deterministic
(`[REDACTED:bearer]`, `[REDACTED:pattern:0]`, …). Regex scanning of `content`
and `tool_result` is limited to the first 16,000 UTF-16 units (the same budget
the writer keeps after the field cap). `tool_args` string leaves are not
field-capped, so they are scanned in full. Built-in assignment / secret-key
detectors match exact stems and underscore/hyphen compounds (`SECRET_KEY`,
`db_password`) — bare `key`/`auth` only behind a separator, so ordinary fields
like `author` / `token_count` are kept. Split secrets (half in `content`, half
in `tool_result`) are not reassembled — each field is redacted independently.

```yaml
memory:
  capture:
    redaction:
      enabled: false
      builtins: true
      # patterns:
      #   - '\\b[Mm][Yy][Pp]refix-[a-z0-9]{20,}\\b'
```

| Key        | Type     | Default | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------- | -------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`  | boolean  | `false` | Run the write-path redactor.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `builtins` | boolean  | `true`  | Built-in detectors (Bearer/Basic auth, credential assignments, PEM private keys, common token shapes, JWTs). Ignored when `enabled` is false.                                                                                                                                                                                                                                                                                                                  |
| `patterns` | string[] | —       | Extra JS regex **source** strings. Only the `g` flag is applied — do not wrap in `/…/flags`, and do not use Python-style `(?i)` at the start of the pattern (it does not compile in JS). For case-insensitivity spell out character classes (e.g. `[Mm][Yy][Pp]refix`); RegExp modifier groups like `(?i:…)` need a newer V8 than the repo's Node 22 floor. Invalid sources are a config error. Nested-quantifier shapes such as `(a+)+` are rejected (ReDoS). |

Hooks that do not load YAML yet can enable the same built-ins with
`RIVETOS_CAPTURE_REDACTION=1` (or `true` / `yes` / `on`). An explicit
`redaction: { enabled: false }` on `createCaptureWriter` wins over the env.
Wiring YAML → every hook process is separate from validation; until boot
injects this block, set the env (or pass `CaptureWriterOptions.redaction`) to
turn it on. Config validation warns when `enabled: true` because nothing
consumes the YAML block yet.

### PostgreSQL

```yaml
memory:
  postgres:
    connection_string: ${RIVETOS_PG_URL}
    # Optional — point the background memory loop at your own endpoints:
    # embed_endpoint: http://your-embed-host:9402/v1
    # delegation_tracking: true
```

| Key                              | Type     | Default             | Description                                                                                                                                                                                                                                                                              |
| -------------------------------- | -------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connection_string`              | string   | `${RIVETOS_PG_URL}` | PostgreSQL connection URL.                                                                                                                                                                                                                                                               |
| `embed_endpoint`                 | string   | —                   | Embeddings endpoint base used by the embedding worker and query-time search.                                                                                                                                                                                                             |
| `embed_model`                    | string   | —                   | Embedding model id (required when an embed URL is set).                                                                                                                                                                                                                                  |
| `embed_api_key`                  | string   | —                   | Static bearer for the embed endpoint (also honors `RIVETOS_EMBED_API_KEY`). Does **not** fall back to `OPENAI_API_KEY` — that would send a global OpenAI credential to whatever `embed_endpoint` is configured.                                                                          |
| `embed_token_command`            | string[] | —                   | Argv that prints a bearer token on stdout (no shell). Wins over `embed_api_key`.                                                                                                                                                                                                         |
| `embed_token_ttl_ms`             | number   | `300000`            | Cache lifetime for a minted embed token.                                                                                                                                                                                                                                                 |
| `embed_token_command_timeout_ms` | number   | `5000`              | Mint timeout for `embed_token_command`.                                                                                                                                                                                                                                                  |
| `embed_wire_shape`               | string   | `openai`            | `openai` → `POST <base>/v1/embeddings`; `native` → `POST <base>` with `{texts,input}`.                                                                                                                                                                                                   |
| `embed_expected_dims`            | number   | —                   | When set, must equal the embedding column width (`halfvec(1024)`). Rejects any vector whose length differs (longer vectors null out — truncation is `EMBED_TRUNCATE_DIMS` only). Any other configured value bricks inserts and vector search. Worker env: `RIVETOS_EMBED_EXPECTED_DIMS`. |
| `delegation_tracking`            | boolean  | `false`             | Persist delegation events into memory (`ros_messages`, channel `delegation`) for auditing.              |
| `embedded`                       | object   | —                   | In-process PGlite transport for the same postgres backend. Mutually exclusive with `connection_string`. |

**Required extensions:** `pgvector` (for embedding storage and similarity search).

The memory plugin handles schema creation and migration automatically on first boot.

### Embedded PGlite

Presence of `memory.postgres.embedded` starts Postgres-in-WASM inside `rivetos start` and exposes it on a loopback wire socket. Existing `pg` clients keep using `RIVETOS_PG_URL` (injected at boot). Do not set `connection_string` in the same block — that is a validation error.

```yaml
memory:
  postgres:
    embedded:
      data_dir: ~/.rivetos/pglite
      port: 5433
      auto_migrate: true
      max_connections: 96
```

Effective URL: `postgres://postgres:postgres@127.0.0.1:<port>/postgres`.

| Key               | Type    | Default             | Description                                              |
| ----------------- | ------- | ------------------- | -------------------------------------------------------- |
| `data_dir`        | string  | `~/.rivetos/pglite` | File-backed PGlite directory (`~` expanded).             |
| `port`            | integer | `5433`              | Loopback TCP port (5432 may already be a host Postgres). |
| `auto_migrate`    | boolean | `true`              | Run memory migrations in-process after the owner starts. |
| `max_connections` | integer | `96`                | Socket multiplexer cap. The library default is 1.        |

Contract:

- The socket exists only while the node process runs. A second process on the same `data_dir` attaches (does not open the directory twice) via `rivetos-owner.lock`.
- Single owner. Stale lock (dead pid) is unlinked and replaced.
- `LISTEN`/`NOTIFY` is not delivered across socket connections — task completion waiter and graphile-worker use polling.
- Export with `pg_dump` ≥ 18 (this engine is PostgreSQL 18.3). RSS is about 650 MB per 170 MB on-disk database.
- Without `RIVETOS_EMBED_URL` / `embed_endpoint` (lite mode), boot sets `rivet.defer_embed_enqueue=on` so capture INSERTs do not require the graphile schema. In lite mode nothing ever enqueues embed jobs: rows are stored un-embedded (full-text + trigram recall only). When you later configure an embedding endpoint, restart the node — the embedding worker's `enqueue-idle` cron backfills every un-embedded row.

Day-2 commands (no extra daemon):

- `rivetos start` / `rivetos start --role migrate` — foreground start now loads `~/.rivetos/.env` (same non-overriding merge as systemd `EnvironmentFile=`). Migrate acquires or attaches; in-process when this process owns the engine, async spawn when attaching.
- `rivetos db migrate` / `rivetos db status` — same acquire-or-attach wrap. `--config <path>` selects the YAML (not forwarded to the migrator). `db migrate --url` bypasses the embedded engine and talks to that Postgres URL. `db status` on embedded prints data dir, size on disk, owner, socket port, and `_rivetos_migrations` count. If no node is running, `db status` boots the engine for the duration of the command and labels the owner `this command (no node running)`.
- `rivetos doctor` — does not warn that `RIVETOS_PG_URL` is missing when `memory.postgres.embedded` is set; if the socket refuses, it says to start the node.

### SQLite (opt-in)

Presence of `memory.sqlite` registers the `@rivetos/memory-sqlite` plugin. No Postgres or
PGlite process is required for the in-process `Memory` path (chat append, session/task
history, settings, search). HTTP `/api/capture` and memory HTTP/MCP routes still need
a Postgres pool — the memory MCP sidecar has no sqlite path yet. Compaction, wiki, and
multi-user routing come later. With an embedding endpoint set, messages are embedded in the
background by a job loop inside the runtime (no worker service), vectors are stored in the
file, and search fuses full-text, a literal-match arm and a vector arm with the same ranking
policy as Postgres; without one, search is full-text only. Single-user: one file holds
all transcripts; routed users in the tenancy registry are not isolated. If `memory.sqlite`
is set, remove or ignore a stale `RIVETOS_PG_URL` in `~/.rivetos/.env` so the MCP sidecar
does not keep reading an old Postgres store while chat appends write sqlite. The parent
directory is created mode `0700` and the DB file (plus `-wal`/`-shm`) is `0600`. With this
block unset, behaviour is unchanged.

```yaml
memory:
  sqlite:
    path: ~/.rivetos/memory.sqlite
```

| Key    | Type   | Default | Description                                                                        |
| ------ | ------ | ------- | ---------------------------------------------------------------------------------- |
| `path` | string | —       | Required. File path (`~` expanded) or `:memory:`. Relative paths are cwd-relative. |
| `embed_endpoint` | string | `RIVETOS_EMBED_URL` | Embedding endpoint. Set → background embedding + vector search. Unset → full-text only; nothing is queued, and rows written meanwhile are embedded by a sweep once an endpoint is set. |
| `embed_model` | string | `RIVETOS_EMBED_MODEL` | Required with an endpoint. Changing it clears the stored vectors and re-embeds (in the process that runs the job loop): vectors from different models are not comparable. |
| `embed_api_key` | string | `RIVETOS_EMBED_API_KEY` | Bearer key. No fallback to any other provider key. |
| `embed_token_command` | string[] | `RIVETOS_EMBED_TOKEN_COMMAND` (JSON argv) | Command that prints a bearer token; wins over the key. |
| `embed_token_ttl_ms` | number | — | How long a minted token is reused before the command runs again. |
| `embed_wire_shape` | `openai` \| `native` | `RIVETOS_EMBED_WIRE_SHAPE`, else `openai` | Request shape, as for Postgres. |
| `embed_expected_dims` | number | `RIVETOS_EMBED_EXPECTED_DIMS` | Require exactly this vector width. Unset: vectors longer than 1024 are truncated to 1024. A store keeps one width: a vector of another width fails its job unless this key names the new width, in which case the stored vectors are cleared and re-embedded. |
| `embed_timeout_ms` | number | `RIVETOS_EMBED_TIMEOUT_MS`, else 8000 | Per-request timeout, clamped to 500–60000. |
| `embed_query_instruction` | string | `RIVETOS_EMBED_QUERY_INSTRUCTION`, else the same default as Postgres | Prefix for search queries. Empty string disables. |
| `compactor_endpoint` | string | `RIVETOS_COMPACTOR_URL` | OpenAI-compatible chat base URL (`/chat/completions` is appended). Unset → no summaries are written and no conversation text is sent anywhere. |
| `compactor_model` | string | `RIVETOS_COMPACTOR_MODEL` | Model that writes summaries. Required with an endpoint. |
| `compactor_api_key` | string | `RIVETOS_COMPACTOR_API_KEY` | Bearer key for the summarization endpoint. |
| `compactor_token_command` | string[] | — | Command that prints a bearer token; wins over the key. |
| `compactor_timeout_ms` | number | `600000` | Per-request timeout. |
| `workers` | boolean | `true` when an embedding or summarization endpoint is set | Run the in-process job loop. `false` queues work without draining it, and a model change is not applied on open: stored vectors are cleared only by a process that runs the job loop (or calls `runJobs()`). |

The file is opened with WAL, a 5s busy timeout, and foreign keys on. Without an embedding
endpoint search is FTS5 only and no embedding work is queued; rows written meanwhile are
embedded once an endpoint is configured. Embedding jobs retry with backoff; a job that runs
out of attempts during an outage is revived by a ten-minute sweep.

With a summarization endpoint the same job loop compacts conversations into leaf, branch and
root summaries, using the prompts and batch policy of the Postgres compaction worker. A sweep
every five minutes queues conversations that have a full window of unsummarized messages, have
been idle, or have gone stale. Summaries are searchable (`scope: summaries` or `both`) and are
embedded when an embedding endpoint is set. The worker's `COMPACT_LEAF_BATCH`,
`COMPACT_BRANCH_BATCH`, `COMPACT_ROOT_BATCH`, `COMPACT_MIN_LEAFS`, `COMPACT_MIN_BRANCHES`,
`COMPACT_IDLE_MINUTES`, `COMPACT_STALE_MINUTES` and `COMPACT_STALE_MIN_BATCH` variables tune it.

---

## `tasks`

Durable task engine (phase 1). The embedded `run-task` runner starts when
Postgres is configured and the `0002_ros_tasks` migration has been applied
(`rivetos-memory-migrate`); on unmigrated nodes it logs a warning and stays
inert instead of failing boot.

With no `pgUrl`, `sqlite_path` is the engine instead: same `ros_tasks` rows
in that file, polled by this process (no graphile-worker, no `LISTEN`). If
both are set, Postgres wins and the sqlite file is not opened. Relative
paths are cwd-relative. Keep this file separate from any other app database.

| Key           | Type    | Default | Description                                                                   |
| ------------- | ------- | ------- | ----------------------------------------------------------------------------- |
| `enabled`     | boolean | `true`  | Start the embedded task runner. Inert while nothing creates tasks.            |
| `sqlite_path` | string  | —       | Task file when there is no pgUrl. Ignored (with a warning) when pgUrl is set. |

Env knobs: `RIVETOS_TASKS_CONCURRENCY` (default 4), `RIVETOS_TASKS_POLL_MS` (default 2000).

Headless harness executors can also be keyed under `tasks.harnesses` (`pi`, `qwen-code`, …) with `binary` / `model` / `cwd` / `home` — see the site architecture sample. For qwen-code, `providers.qwen-code.home` is accepted for parity with the other CLI providers and currently unused; `tasks.harnesses.qwen-code.home` is where the task executor looks for qwen's `projects/` sessions (default `~/.qwen`). Neither key relocates qwen's own writes.

#### Task isolation (claude-code): `isolation` / `allowed_tools`

A delegated `claude-code` task runs as the service user, so by default it loads that user's personal Claude Code setup: `~/.claude/settings.json` (permission rules and default mode, hooks, enabled plugins), the plugins' MCP servers, and the user-level `CLAUDE.md`. `tasks.harnesses.claude-code.isolation` chooses whether a task inherits that:

```yaml
tasks:
  harnesses:
    claude-code:
      isolation: isolated # inherit (default) | isolated
      allowed_tools:
        - mcp__rivetos # the embedded RivetOS bridge's tools
        - 'Bash(git status:*)'
```

- `inherit` (default) passes no extra flags; nothing changes for a node that does not set the key.
- `isolated` spawns with `--setting-sources project` and `--strict-mcp-config`: no personal settings, permission rules, hooks, plugins or user `CLAUDE.md`, and the embedded RivetOS bridge is the only MCP server. The per-checkout `.claude/settings.local.json` is personal too and is not loaded either. The RivetOS capture hooks are supplied by the runtime through an inline `--settings` object, so task transcripts keep working. With `providers.claude-cli.permission_prompts` unset it also passes `--permission-prompts none`, so every prompt — built-in or MCP — is denied rather than left to the CLI's default.
- Project settings (`.claude/settings.json` in the task's working directory) load at both levels: they belong to the repository, not the operator.
- `allowed_tools` is passed as `--allowedTools` at both levels. Under `isolated` the operator's own allow rules are gone, so list what a headless run may call without a prompt (or set `providers.claude-cli.permission_mode`).
- The node setting is a floor. A task can tighten it with `spec.isolation: isolated` on `POST /api/tasks`; a spec cannot loosen an `isolated` node (the spec is caller-controlled, and a task can create child tasks), and an unknown value is ignored.
- `isolated` removes the operator's personal setup. It does not sandbox the working tree: a repository's own `.claude/settings.json` hooks and allow rules still apply, so point isolated tasks at trees you trust.
- Under `isolated`, unless `permission_mode` is `bypassPermissions` or `permission_prompts` is `ui` (the broker answers prompts), list `mcp__rivetos` in `allowed_tools` or the bridge's own tools are denied; boot warns when it is missing.

#### Model lists: `tasks.harnesses.<id>.models` / `efforts` / `models_mode`

The den discovers each harness's model list from the harness itself where it can (Claude's global config cache, Grok's and Codex's catalog caches, Codex's `codex debug models`, Kimi's and OpenCode's config, Hermes's configured endpoint) and falls back to a built-in static list. `GET /api/harnesses` reports where the list came from as `capabilities.modelsSource`: `discovered`, `config`, `merged`, or `static`.

```yaml
tasks:
  harnesses:
    codex:
      models_mode: merge # discover (default) | replace | merge
      models:
        - { id: my-gateway/gpt-x, label: 'GPT-X via gateway', default: true }
        - { id: gpt-5.5, efforts: [{ id: low }, { id: high, default: true }] }
      efforts: # same treatment as models
        - { id: ultra, label: Ultra }
```

- `discover` — the discovered list, falling back to the static one. A `models` / `efforts` list is ignored (the validator warns).
- `replace` — the key you set (`models`, `efforts`, or both) replaces that list; a key you leave out keeps the discovered or static one. **A `models` or `efforts` list with no `models_mode` means `replace`** (the historical meaning, so older configs do not change). Under a pinned, non-empty `models` list (`modelsSource: config`), an agent preset that names a model outside it is refused with a 400 on save; under the other modes it is saved with one warning in the den log.
- `merge` — the discovered list plus the config entries, deduped by id; a config entry wins on `label`, `default`, and `efforts`, and a config `default: true` becomes the only default. Use this for a custom gateway that serves ids the harness's own catalog does not know.

Entries are `{ id, label?, default?, efforts? }`; malformed rows are dropped and an empty list keeps the discovered one. Model ids pass the same token rule as the spawn path: 1–64 characters from `A-Z a-z 0-9 . _ [ ] : / -`, `~` allowed after the first character, no `..`. For Codex, the literal id `default` (what pre-discovery clients stored) means "the CLI's own default": no model flag is passed and it is never vetted.

---

## `transports`

Inbound surfaces that expose RivetOS tools to external clients. Currently: the MCP server transport (`@rivetos/mcp-server`), a StreamableHTTP MCP server that exposes `memory_*`, `web_*`, `skill_*`, and runtime tools to any MCP-speaking client (Claude Code, Cursor, etc.).

```yaml
transports:
  mcp:
    port: 4321
    bind: 127.0.0.1 # default localhost
    tls: # optional mTLS
      ca_path: $RIVETOS_SHARED_DIR/rivet-ca/intermediate/ca-chain.pem
      cert_path: $RIVETOS_SHARED_DIR/rivet-ca/issued/<node_name>.crt
      key_path: $RIVETOS_SHARED_DIR/rivet-ca/issued/<node_name>.key
```

The transport is only activated when the matching `transports.<name>` slice is present. The MCP server can also run standalone via the `rivetos-mcp-server` bin shipped by `@rivetos/mcp-server`.

---

## `mcp`

**Outbound** Model Context Protocol. RivetOS _connects to_ external MCP servers and exposes their tools to agents (the inverse of the `transports.mcp` plugin above).

```yaml
mcp:
  servers:
    memory:
      transport: stdio
      command: npx
      args: ['-y', '@modelcontextprotocol/server-memory']
      toolPrefix: mcp_memory

    github:
      transport: streamable-http
      url: http://localhost:8080/mcp
      connectTimeout: 5000
      autoReconnect: true
```

### MCP server config

| Key              | Type     | Default      | Description                                                  |
| ---------------- | -------- | ------------ | ------------------------------------------------------------ |
| `transport`      | string   | **required** | `stdio`, `streamable-http`, or `sse`.                        |
| `command`        | string   | —            | Command to launch (stdio transport).                         |
| `args`           | string[] | `[]`         | Command arguments (stdio transport).                         |
| `env`            | object   | `{}`         | Environment variables for the spawned process.               |
| `cwd`            | string   | —            | Working directory for the spawned process.                   |
| `url`            | string   | —            | Server URL (HTTP/SSE transport).                             |
| `toolPrefix`     | string   | —            | Prefix for tool names (prevents collisions between servers). |
| `connectTimeout` | number   | `10000`      | Connection timeout in milliseconds.                          |
| `autoReconnect`  | boolean  | `true`       | Auto-reconnect on disconnect.                                |

---

## `deployment`

Optional. Declares the intended deployment target so tooling (`rivetos update`,
`rivetos config`) can choose the right path. Provisioning itself is driven by
the Compose files under `infra/docker/` and the scripts under `infra/scripts/`.
Only `target` is read; any other key under `deployment` is warned as unknown.

```yaml
deployment:
  target: docker
```

### Keys

| Key      | Type   | Default      | Description                                     |
| -------- | ------ | ------------ | ----------------------------------------------- |
| `target` | string | **required** | `docker`, `proxmox`, `kubernetes`, or `manual`. |

---

## Environment variables

These are typically set in `.env`.

The MCP sidecar (`services/mcp-sidecar`, one process per harness) selects its
memory backend with `RIVETOS_MCP_TRANSPORT`. `den` (the default when
`RIVET_DEN_URL` is set and `RIVETOS_USER_ID` is empty) calls this node's den
over loopback HTTPS and opens no Postgres pool. `RIVET_DEN_URL` and
`RIVET_DEN_CA` are set by the den for sessions it spawns; a hand-started
harness gets them from `rivetos_resolve_den` (`den.port`, default 5174, and
`den.tls_ca` or `RIVETOS_DEN_TLS_CA`). A non-empty `RIVETOS_USER_ID` stays on
`pg`, because loopback den calls are the owner pool.

| Variable                | Used By                                 | Description                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`     | provider-anthropic                      | Anthropic API key                                                                                                                                                                                                                                                                                                                                                           |
| `XAI_API_KEY`           | provider-xai                            | xAI API key                                                                                                                                                                                                                                                                                                                                                                 |
| `GOOGLE_API_KEY`        | provider-google                         | Google AI API key                                                                                                                                                                                                                                                                                                                                                           |
| `RIVETOS_PG_URL`        | memory-postgres, mcp-sidecar            | PostgreSQL connection string (node owner database). The sidecar uses it only for transport `pg`.                                                                                                                                                                                                                                                                            |
| `RIVETOS_MCP_TRANSPORT` | mcp-sidecar                             | `den` or `pg`. Default `den` when `RIVET_DEN_URL` is set and `RIVETOS_USER_ID` is empty; otherwise `pg` when `RIVETOS_PG_URL` is set. `den` is HTTPS to the local den with no sidecar Postgres pool. A routed user id keeps `pg`.                                                                                                                                           |
| `RIVET_DEN_URL`         | mcp-sidecar                             | Den origin for the sidecar (`https://127.0.0.1:<den.port>`, default port 5174). Den-spawned sessions already have it. The memory launcher fills it from `~/.rivetos/config.yaml` when unset.                                                                                                                                                                                |
| `RIVET_DEN_CA`          | mcp-sidecar                             | PEM path for the den's CA. The launcher exports it as `NODE_EXTRA_CA_CERTS` when that is unset, from `den.tls_ca`, else `RIVETOS_DEN_TLS_CA`, else `/rivet-shared/rivet-ca/intermediate/chain.pem`. For an https den URL a missing file unsets `RIVET_DEN_URL`; a plain-http URL needs no CA and is kept.                                                                   |
| `RIVETOS_PG_POOL_MAX`   | boot                                    | Max connections for the one host-owned Postgres pool per runtime process (shared by the task engine, heartbeats, memory and the API). Default 8, min 4.                                                                                                                                                                                                                     |
| `RIVETOS_USERS_FILE`    | den, memory-postgres, claude-cli        | Optional explicit path to the tenancy registry (`users.json`). When unset, RivetOS loads `$RIVETOS_SHARED_DIR/rivetos/users.json`, then `~/.rivetos/users.json`. Per-user memory routing comes only from this file — a user is routable iff their record has a usable `pgUrl`. A present-but-invalid shared-dir file fails closed (does not fall through to the home file). |
| `RIVETOS_OWNER_USER_ID` | den, users-registry, `rivetos user add` | Node-owner user id used by the fail-closed seed and the CLI missing-file seed. Default `owner` (fleet compatibility); deployments override this env var. Forwarded to the embedded den.                                                                                                                                                                                     |
| `RIVETOS_AGENT_SECRET`  | channel-agent                           | **Deprecated** — was the bearer secret for agent mesh. No longer used for agent-channel auth (replaced by mTLS).                                                                                                                                                                                                                                                            |
| `RIVETOS_LOG_LEVEL`     | core                                    | Log level: `error`, `warn`, `info`, `debug`                                                                                                                                                                                                                                                                                                                                 |
| `RIVETOS_LOG_FORMAT`    | core                                    | Log format: `pretty` (default) or `json`                                                                                                                                                                                                                                                                                                                                    |
| `GOOGLE_CSE_ID`         | tool-web-search                         | Google Custom Search Engine ID                                                                                                                                                                                                                                                                                                                                              |
| `GOOGLE_CSE_KEY`        | tool-web-search                         | Google CSE API key                                                                                                                                                                                                                                                                                                                                                          |
| `RIVETOS_EMBED_API_KEY` | memory-postgres / embedding-worker      | Optional static bearer for the configured embed endpoint. Opt-in — `OPENAI_API_KEY` is not used as a fallback.                                                                                                                                                                                                                                                              |
| `RIVETOS_TAGGER_URL` | compaction-worker | Session tagger endpoint (env only, like the compactor: there is no `memory.postgres` key, the worker is the sole consumer). Unset → the worker tags with `RIVETOS_COMPACTOR_URL` / `_MODEL`. `SESSION_TAGGING=0` (or `false`/`no`/`off`) turns tagging off; the worker then reads none of the `RIVETOS_TAGGER_*` settings, so leftovers cannot stop it from starting. |
| `RIVETOS_TAGGER_MODEL` | compaction-worker | Tagger model id; defaults to `RIVETOS_COMPACTOR_MODEL`. |
| `RIVETOS_TAGGER_API_KEY` | compaction-worker | Static bearer for the tagger endpoint; defaults to `RIVETOS_COMPACTOR_API_KEY` only when the URL also defaulted. |
| `RIVETOS_TAGGER_TOKEN_COMMAND` | compaction-worker | JSON argv that prints a bearer token (no shell). Wins over the static key. `RIVETOS_TAGGER_TOKEN_TTL_MS` / `RIVETOS_TAGGER_TOKEN_COMMAND_TIMEOUT_MS` tune it. A rejected token (401) is re-minted once. Like the static key, it requires `RIVETOS_TAGGER_URL`: the worker refuses to start rather than send a tagger credential to the compactor endpoint. |
| `RIVETOS_TAGGER_WIRE_SHAPE` | compaction-worker | `openai` (default) or `native`. |
| `RIVETOS_TAGGER_TIMEOUT_SECONDS` | compaction-worker | Per-attempt tagger timeout, default 60. Tagging is best-effort: after the job's attempts it is logged and dropped, never left dead. |
| `RIVETOS_TAGGER_TRANSIENT_STATUSES` | compaction-worker | 4xx codes the tagger endpoint returns while overloaded, retried like a 5xx (`openai` shape only). |
| `QWEN_BINARY`           | provider-qwen-code, setup script        | Override path/name of the `qwen` binary (default `qwen` on PATH). Honoured by the provider and the rivet-memory setup script.                                                                                                                                                                                                                                               |
| `QWEN_HOME`             | plugins install, doctor, setup script   | Override where RivetOS looks for qwen's `settings.json` / `projects/` (default `~/.qwen`). Does not relocate where qwen itself writes — qwen-code 0.23.4 has no env/flag to move `~/.qwen`.                                                                                                                                                                                 |

### Compaction worker

`services/compaction-worker` reads its own environment (systemd unit, or the
`compaction-worker` service in `infra/docker/rivetos/docker-compose.yml`).
The full list is the header of `services/compaction-worker/src/index.ts`;
these control which LLM it calls. An invalid value exits at startup.

| Variable | Description |
| --- | --- |
| `RIVETOS_COMPACTOR_URL` | Required. OpenAI-compatible base URL (`http://` or `https://`); the worker appends `/chat/completions`. |
| `RIVETOS_COMPACTOR_MODEL` | Required. Chat model id. |
| `RIVETOS_COMPACTOR_API_KEY` | Bearer key for the primary, if it needs one. |
| `RIVETOS_COMPACTOR_TRANSIENT_STATUSES` | Comma list of 4xx codes the **primary** returns while overloaded (e.g. `403,404` for NVIDIA's free tier). They retry with the 5xx backoff and, once retries run out, fail as retryable instead of marking the level terminal. Only 4xx codes are accepted. |
| `RIVETOS_COMPACTOR_FALLBACKS` | Ordered, comma-separated `url\|model\|KEY_ENV\|STATUSES` entries tried when the primary fails. `KEY_ENV` names the variable holding that endpoint's key (empty for none), so keys stay out of the list. `STATUSES` is that endpoint's own `;`-separated transient 4xx list; the primary's list does not apply to fallbacks, since OpenRouter's 403/404 are permanent. Example: `https://integrate.api.nvidia.com/v1\|google/gemma-4-31b-it\|NVIDIA_API_KEY\|403;404,https://openrouter.ai/api/v1\|openai/gpt-oss-120b\|OPENROUTER_API_KEY`. |
| `RIVETOS_COMPACTOR_FALLBACK_COOLDOWN_MINUTES` | Default 15. After an outage (network, timeout, 5xx, empty answers, 401/402/403/404/429, and other non-request-scoped 4xx such as 405/409/415/426), later calls stay on the endpoint that answered this long before trying the primary again. A request-scoped 400/413/422, or an answer the caller rejects (unparseable wiki JSON), moves only that call to the next endpoint and does not clear an active failover. Listing 400/401/413/422 in a transient-status list is accepted but warned: those codes then retry like a 5xx and can sticky-failover after exhaustion. |
| `RIVETOS_COMPACTOR_FALLBACK_ATTEMPT_TIMEOUT_SECONDS` | Default 300. Per-attempt timeout on a **middle** fallback only (not the primary, not the last endpoint), so a hung fallback hands over in minutes. The primary and the last endpoint keep the full `LLM_TIMEOUT_MS` (60 min) — configuring fallbacks does not cut a slow local primary. |

---

## Full annotated example

See [`config.example.yaml`](../config.example.yaml) in the repository root for a complete annotated config file with all options commented.
