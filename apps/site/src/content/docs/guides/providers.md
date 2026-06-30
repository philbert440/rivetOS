---
title: Provider Setup
sidebar:
  order: 6
description: How to configure LLM providers — Anthropic, xAI, Google, Ollama, vLLM, llama-server, and claude-cli
---

Providers connect your agents to large language models. Each provider plugin handles API authentication, streaming, tool calling format differences, and thinking/reasoning support so your agent config stays clean.

RivetOS ships with six provider plugins:

| Provider | Models | Thinking Support | Notes |
|----------|--------|:---:|-------|
| **Anthropic** | Claude Opus, Sonnet, Haiku | ✅ | Adaptive thinking, prompt caching |
| **xAI** | Grok 3, Grok 4 | ✅ | Responses API, conversation caching, live search |
| **Google** | Gemini 2.5 Pro, Flash | ✅ | Thought signatures for function calling |
| **Ollama** | Any local model | — | Local inference, no API key needed |
| **OpenAI-compat** | vLLM / TGI / llama.cpp `llama-server` / Groq / Together / Fireworks / LocalAI | ✅ (when `--reasoning-parser` set) | Folds mid-conversation system messages, consumes native `reasoning_content` |
| **Claude CLI** | Anything `claude` supports | ✅ | Drives the local `claude` binary using your subscription OAuth — no API key |

---

## Anthropic (Claude)

### 1. Get an API Key

1. Go to the [Anthropic Console](https://console.anthropic.com/)
2. Sign up or log in
3. Go to **API Keys** → **Create Key**
4. Copy the key (starts with `sk-ant-`)

Prefer subscription/OAuth auth over an API key? Use the **`claude-cli` provider** instead — it drives the local `claude` binary (Claude Code CLI), which owns the OAuth flow. Run `claude login` once via the CLI itself; RivetOS does not handle the OAuth handshake. See the `claude-cli` provider in the [Configuration Reference](/reference/config/).

### 2. Configure

Add your key to `.env`:

```bash
ANTHROPIC_API_KEY=sk-ant-...your-key-here
```

Add to `config.yaml`:

```yaml
providers:
  anthropic:
    model: claude-opus-4-7
    max_tokens: 8192

agents:
  myagent:
    provider: anthropic
    default_thinking: medium
```

### Config Options

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `model` | string | `claude-opus-4-7` | Model identifier |
| `max_tokens` | number | `8192` | Maximum output tokens |
| `api_key` | string | `${ANTHROPIC_API_KEY}` | API key. Use env var |
| `context_window` | number | — | Override the model's context-window size (advanced) |
| `max_output_tokens` | number | — | Hard cap on output tokens |

> For subscription/OAuth auth instead of an API key, use the `claude-cli` provider (it drives the local `claude` binary and owns the OAuth flow).

### Thinking Levels

When `default_thinking` is set on the agent, the provider requests extended thinking with a token budget:

| Level | Budget | Best For |
|-------|--------|----------|
| `off` | — | Simple questions, fast responses |
| `low` | 2,000 tokens | Light reasoning |
| `medium` | 10,000 tokens | Code review, planning |
| `high` | 50,000 tokens | Complex architecture, deep analysis |

### Models

| Model | Speed | Intelligence | Context |
|-------|:-----:|:------------:|:-------:|
| `claude-opus-4-7` | Slow | Highest | 200K |
| `claude-sonnet-4-6` | Fast | High | 200K |
| `claude-haiku-4-5-20251001` | Fastest | Good | 200K |

> **Docs:** [Anthropic API Reference](https://docs.anthropic.com/en/api/getting-started)

---

## xAI (Grok)

### 1. Get an API Key

1. Go to [console.x.ai](https://console.x.ai/)
2. Sign up or log in
3. Create an API key
4. Copy the key (starts with `xai-`)

### 2. Configure

Add your key to `.env`:

```bash
XAI_API_KEY=xai-...your-key-here
```

Add to `config.yaml`:

```yaml
providers:
  xai:
    model: grok-4-1-fast-reasoning

agents:
  grok:
    provider: xai
```

### Config Options

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `model` | string | `grok-4.20-reasoning` | Model identifier |
| `api_key` | string | `${XAI_API_KEY}` | API key |
| `base_url` | string | `https://api.x.ai/v1` | API endpoint |
| `temperature` | number | — | Sampling temperature (not used with reasoning models) |
| `store` | boolean | `true` | Server-side conversation storage. When enabled, only new messages are sent each turn |
| `timeout_ms` | number | `3600000` | Request timeout in milliseconds (default: 1 hour for reasoning) |

### Conversation Caching

When `store: true` (default), xAI stores the conversation server-side. Each turn only sends new messages, reducing token usage and latency. The provider manages `previous_response_id` automatically.

### Models

| Model | Type | Notes |
|-------|------|-------|
| `grok-4.20-reasoning` | Flagship | 2M context, fast + agentic, $2.00/$6.00 per M tokens |
| `grok-4-1-fast-reasoning` | Fast | 10x cheaper ($0.20/$0.50), good for compaction and cheap throughput |

> **Docs:** [xAI API Documentation](https://docs.x.ai/docs)

---

## Google (Gemini)

### 1. Get an API Key

1. Go to [Google AI Studio](https://aistudio.google.com/apikey)
2. Click **Create API Key**
3. Select or create a Google Cloud project
4. Copy the key

### 2. Configure

Add your key to `.env`:

```bash
GOOGLE_API_KEY=AIza...your-key-here
```

Add to `config.yaml`:

```yaml
providers:
  google:
    model: gemini-2.5-pro

agents:
  gemini:
    provider: google
    default_thinking: medium
```

### Config Options

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `model` | string | `gemini-2.5-pro` | Model identifier |
| `api_key` | string | `${GOOGLE_API_KEY}` | API key |
| `max_tokens` | number | `8192` | Maximum output tokens |
| `base_url` | string | `https://generativelanguage.googleapis.com/v1beta` | API endpoint |

### Thinking Levels

| Level | Budget |
|-------|--------|
| `off` | 0 |
| `low` | 1,024 tokens |
| `medium` | 8,192 tokens |
| `high` | 32,768 tokens |

### Models

| Model | Speed | Context | Notes |
|-------|:-----:|:-------:|-------|
| `gemini-2.5-pro` | Medium | 1M | Best reasoning |
| `gemini-2.5-flash` | Fast | 1M | Good balance of speed and quality |

> **Docs:** [Gemini API Documentation](https://ai.google.dev/gemini-api/docs)

---

## Ollama (Local Models)

[Ollama](https://ollama.com/) runs models locally on your machine. No API key needed, no usage costs — just hardware.

### 1. Install Ollama

```bash
# Linux
curl -fsSL https://ollama.com/install.sh | sh

# macOS
brew install ollama

# Or download from https://ollama.com/download
```

### 2. Pull a Model

```bash
ollama pull qwen2.5:32b
```

Browse available models at [ollama.com/library](https://ollama.com/library).

### 3. Configure

No `.env` needed — Ollama runs locally without authentication.

```yaml
providers:
  ollama:
    model: qwen2.5:32b
    base_url: http://localhost:11434

agents:
  local:
    provider: ollama
    local: true    # Extended context (tokens are free)
```

### Config Options

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `model` | string | `llama3.1` | Model name (must be pulled via `ollama pull`) |
| `base_url` | string | `http://localhost:11434` | Ollama API endpoint |
| `temperature` | number | `0.7` | Sampling temperature |
| `top_p` | number | `0.9` | Nucleus sampling threshold |
| `num_ctx` | number | model default | Context window size in tokens |
| `keep_alive` | string | `30m` | How long to keep model loaded in memory |

### Tips

- **Set `local: true` on the agent** — this includes extended workspace context (CAPABILITIES.md, daily notes) since tokens are free with local inference.
- **`num_ctx`** is critical for tool-using agents. Most models default to 2048-4096 tokens, which isn't enough. Set `8192` or higher.
- **`keep_alive`** controls how long the model stays in VRAM after the last request. Set to `0` to unload immediately, or `24h` to keep it warm.
- **Remote Ollama:** If Ollama runs on a different machine, change `base_url` to point at it (e.g., `http://192.0.2.50:11434`).

> **Docs:** [Ollama API Documentation](https://github.com/ollama/ollama/blob/main/docs/api.md)

---

## vLLM (Local / self-hosted)

Dedicated provider for a vLLM server. Exposes the full vLLM surface: sampling
extensions (`top_k`, `min_p`, `repetition_penalty`, `min_tokens`),
`mm_processor_kwargs` / `chat_template_kwargs`, the `extra_body` escape hatch,
`video_url` content blocks, and `reasoning_content` parsing.

Start a server: `vllm serve <model> --port 8000 [--reasoning-parser ...] [--enable-auto-tool-choice]`.

```yaml
providers:
  vllm:
    base_url: http://localhost:8000      # trailing /v1 optional
    model: default                       # 'default' auto-discovers from /v1/models
    top_k: 40
    min_p: 0.05
    # api_key: ${VLLM_API_KEY}           # only if you started vLLM with --api-key

agents:
  local:
    provider: vllm
    local: true                          # extended context — tokens are free
```

Leave `model: default` and the provider auto-selects the served model (and adopts
its context window) from `/v1/models`. For native `<think>` reasoning, start vLLM
with a `--reasoning-parser`; the AI SDK reasoning surface consumes `reasoning_content`.

### Config Options

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `base_url` | string | **required** | vLLM server URL (`/v1` optional). |
| `model` | string | `default` | Served model id; `default` auto-discovers. |
| `api_key` | string | `${VLLM_API_KEY}` | Bearer token (only if vLLM was started with `--api-key`). |
| `max_tokens` | number | `4096` | Maximum output tokens. |
| `temperature` / `top_p` | number | `0.7` / `0.95` | Standard sampling. |
| `top_k` / `min_p` | number | — | vLLM sampling extensions. |
| `presence_penalty` / `frequency_penalty` / `seed` / `stop` | — | — | Standard OpenAI knobs. |
| `repetition_penalty` / `min_tokens` | number | — | vLLM extensions. |
| `mm_processor_kwargs` / `chat_template_kwargs` / `extra_body` | object | — | vLLM passthroughs. |
| `default_tool_choice` | string | `auto` | `auto`, `none`, or `required`. |
| `verify_model_on_init` | boolean | `false` | Probe `/v1/models` at boot. |
| `context_window` / `max_output_tokens` | number | — | Runtime budgeting overrides. |

---

## llama.cpp llama-server (Local)

Dedicated provider for llama.cpp's `llama-server`. Deliberately lean: the standard
OpenAI sampling knobs plus llama.cpp's `top_k` / `min_p` and a generic `extra_body`
escape hatch (grammar, `n_probs`, …). It carries none of the vLLM-only machinery —
use the `vllm` provider for that.

Start a server: `llama-server -m <model.gguf> --port 8080 [--reasoning-format deepseek]`.

```yaml
providers:
  llama-server:
    base_url: http://localhost:8080
    model: default
    top_k: 40
    min_p: 0.05

agents:
  local:
    provider: llama-server
    local: true
```

For native `<think>` reasoning, start `llama-server` with `--reasoning-format deepseek`
so it emits `reasoning_content`. Set `LLAMA_SERVER_API_KEY` only if you started the
server with `--api-key`.

### Config Options

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `base_url` | string | **required** | llama-server URL (`/v1` optional). |
| `model` | string | `default` | Served model id; `default` auto-discovers. |
| `api_key` | string | `${LLAMA_SERVER_API_KEY}` | Bearer token (only if started with `--api-key`). |
| `max_tokens` | number | `4096` | Maximum output tokens. |
| `temperature` / `top_p` | number | `0.7` / `0.95` | Standard sampling. |
| `top_k` / `min_p` | number | — | llama.cpp sampling extensions. |
| `presence_penalty` / `frequency_penalty` / `seed` / `stop` | — | — | Standard OpenAI knobs. |
| `extra_body` | object | — | Escape hatch (grammar, `n_probs`, …). |
| `default_tool_choice` | string | `auto` | `auto`, `none`, or `required`. |
| `verify_model_on_init` | boolean | `false` | Probe `/v1/models` at boot. |
| `context_window` / `max_output_tokens` | number | — | Runtime budgeting overrides. |

---



## Checking Provider Health

```bash
# Run provider connectivity checks
npx rivetos doctor

# Smoke test — send a test message to each provider
npx rivetos test

# Check which providers are loaded
npx rivetos status
```

---

## Next Steps

- **[Channel Setup](/guides/channels/)** — Connect your agents to Discord, Telegram, voice
- **[Configuration Reference](/reference/config/)** — Full option tables for all config sections
- **[Plugin Development](/guides/plugins/)** — Build your own provider plugin
