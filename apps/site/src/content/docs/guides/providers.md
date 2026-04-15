---
title: Provider Setup
sidebar:
  order: 6
description: How to configure LLM providers — Anthropic, xAI, Google, Ollama, and OpenAI-compatible
---

Providers connect your agents to large language models. Each provider plugin handles API authentication, streaming, tool calling format differences, and thinking/reasoning support so your agent config stays clean.

RivetOS ships with five provider plugins:

| Provider | Models | Thinking Support | Notes |
|----------|--------|:---:|-------|
| **Anthropic** | Claude Opus, Sonnet, Haiku | ✅ | Extended thinking, OAuth login |
| **xAI** | Grok 3, Grok 4 | ✅ | Responses API, conversation caching |
| **Google** | Gemini 2.5 Pro, Flash | ✅ | Thought signatures for function calling |
| **Ollama** | Any local model | — | Local inference, no API key needed |
| **OpenAI-Compatible** | Any OpenAI-format API | — | vLLM, llama-server, LM Studio, OpenRouter, etc. |

---

## Anthropic (Claude)

### 1. Get an API Key

1. Go to the [Anthropic Console](https://console.anthropic.com/)
2. Sign up or log in
3. Go to **API Keys** → **Create Key**
4. Copy the key (starts with `sk-ant-`)

Alternatively, use **OAuth login** (no API key needed):

```bash
npx rivetos login
```

This opens a browser, authenticates with Anthropic, and stores tokens locally. The provider auto-detects OAuth tokens vs API keys.

### 2. Configure

Add your key to `.env`:

```bash
ANTHROPIC_API_KEY=sk-ant-...your-key-here
```

Add to `config.yaml`:

```yaml
providers:
  anthropic:
    model: claude-sonnet-4-20250514
    max_tokens: 8192

agents:
  myagent:
    provider: anthropic
    default_thinking: medium
```

### Config Options

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `model` | string | `claude-opus-4-6` | Model identifier |
| `max_tokens` | number | `8192` | Maximum output tokens |
| `api_key` | string | `${ANTHROPIC_API_KEY}` | API key. Use env var |
| `base_url` | string | `https://api.anthropic.com` | API endpoint (for proxies) |
| `token_path` | string | — | Path to OAuth token file (set automatically by `rivetos login`) |

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
| `claude-opus-4-6` | Slow | Highest | 200K |
| `claude-sonnet-4-20250514` | Fast | High | 200K |
| `claude-haiku-3-5-20241022` | Fastest | Good | 200K |

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

### Conversation Caching and Continuation Logic

The xAI provider uses the Responses API with server-side conversation storage (`store: true` by default). After the continuation logic fix (PR #72), only the newest user/assistant/tool turn is sent along with `previous_response_id`. Full history is never re-sent. `XAIExtendedChatOptions.conversationId` was promoted to the shared `@rivetos/types/ChatOptions` interface. Use the `rivet-provider-update-workflow` skill (via `skill_manage`) or the `rivetos update --mesh` command to keep provider plugins current across a fleet. See `plugins/providers/xai/README.md` and `workspace/CORE.md` for agent developers. The provider manages `previous_response_id` automatically.

### Models

| Model | Type | Notes |
|-------|------|-------|
| `grok-4.20-reasoning` | Flagship | 2M context, fast + agentic, $2.00/$6.00 per M tokens |
| `grok-4-1-fast-reasoning` | Fast | 10x cheaper ($0.20/$0.50), good for compaction/fallback |

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

## OpenAI-Compatible

A generic provider that works with any API that follows the OpenAI Chat Completions format. Useful for:

- **[vLLM](https://docs.vllm.ai/)** — High-throughput inference server
- **[llama-server](https://github.com/ggerganov/llama.cpp/tree/master/examples/server)** — llama.cpp's built-in server
- **[LM Studio](https://lmstudio.ai/)** — Desktop app with a local server mode
- **[OpenRouter](https://openrouter.ai/)** — Unified API for 100+ models
- **[Together AI](https://www.together.ai/)** — Cloud inference with open models

### Configure

For a local server (no API key):

```yaml
providers:
  local-llm:
    base_url: http://localhost:8000/v1
    model: my-model
    max_tokens: 8192

agents:
  local:
    provider: local-llm
    local: true
```

For a hosted service (with API key):

```yaml
providers:
  openrouter:
    base_url: https://openrouter.ai/api/v1
    model: anthropic/claude-sonnet-4-20250514
    api_key: ${OPENROUTER_API_KEY}
    max_tokens: 8192

agents:
  router:
    provider: openrouter
```

### Config Options

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `base_url` | string | **required** | API endpoint URL (must serve `/chat/completions`) |
| `model` | string | `default` | Model identifier sent with requests |
| `api_key` | string | — | API key (if required by the endpoint) |
| `max_tokens` | number | `4096` | Maximum output tokens |
| `temperature` | number | `0.6` | Sampling temperature |
| `top_p` | number | `0.9` | Nucleus sampling threshold |
| `num_ctx` | number | — | Context window size (for llama-server) |
| `id` | string | `openai-compat` | Custom provider ID |
| `name` | string | `OpenAI Compatible` | Custom display name |
| `first_chunk_timeout_ms` | number | `120000` | Max wait for first SSE chunk (2 min default) |
| `chunk_timeout_ms` | number | `30000` | Max wait between subsequent chunks |
| `repeat_penalty` | number | — | Repetition penalty (for llama-server) |

### Multiple Instances

You can configure multiple OpenAI-compatible providers with different `id` values:

```yaml
providers:
  vllm-70b:
    base_url: http://gpu-server:8000/v1
    model: meta-llama/Llama-3.1-70B
    id: vllm-70b
    name: "Llama 70B (vLLM)"

  lmstudio:
    base_url: http://localhost:1234/v1
    model: loaded-model
    id: lmstudio
    name: "LM Studio"
```

---

## Fallback Chains

When a provider fails (429 rate limit, 503 overloaded, timeout), RivetOS can automatically try the next provider in a fallback chain.

Configure at the agent level:

```yaml
agents:
  opus:
    provider: anthropic
    fallbacks:
      - "google:gemini-2.5-pro"
      - "xai:grok-4-1-fast-reasoning"
```

Or globally:

```yaml
runtime:
  fallbacks:
    - providerId: anthropic
      fallbacks:
        - "google:gemini-2.5-pro"
        - "xai:grok-4-1-fast-reasoning"
```

Format: `provider_id` uses the provider's default model, `provider_id:model` overrides the model.

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
