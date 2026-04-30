---
title: Provider Setup
sidebar:
  order: 6
description: How to configure LLM providers — Anthropic, xAI, Google, Ollama, llama-server, openai-compat, and claude-cli
---

Providers connect your agents to large language models. Each provider plugin handles API authentication, streaming, tool calling format differences, and thinking/reasoning support so your agent config stays clean.

RivetOS ships with seven provider plugins:

| Provider | Models | Thinking Support | Notes |
|----------|--------|:---:|-------|
| **Anthropic** | Claude Opus, Sonnet, Haiku | ✅ | Adaptive thinking, prompt caching |
| **xAI** | Grok 3, Grok 4 | ✅ | Responses API, conversation caching, live search |
| **Google** | Gemini 2.5 Pro, Flash | ✅ | Thought signatures for function calling |
| **Ollama** | Any local model | — | Local inference, no API key needed |
| **llama.cpp server** | Any model served by `llama-server` | — | Native sampling (mirostat, typical_p), `<think>` tags, lenient tools |
| **OpenAI-compat** | vLLM / TGI / Groq / Together / Fireworks / LocalAI | ✅ (when `--reasoning-parser` set) | Folds mid-conversation system messages, consumes native `reasoning_content` |
| **Claude CLI** | Anything `claude` supports | ✅ | Drives the local `claude` binary using your subscription OAuth — no API key |

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

### Conversation Caching

When `store: true` (default), xAI stores the conversation server-side. Each turn only sends new messages, reducing token usage and latency. The provider manages `previous_response_id` automatically.

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

## llama.cpp server (Local)

The native provider for [`llama-server`](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md) — the built-in HTTP server from the llama.cpp project.

It uses the native `/completion` and `/infill` endpoints (not the OpenAI compat layer). This gives full access to llama.cpp sampling parameters (`typical_p`, `mirostat`, `repeat_last_n`, `seed`, etc.), native `<think>` / `<thinking>` tag support, and lenient JSON tool-call parsing.

### 1. Install & Run llama-server

```bash
# Build from source (recommended for latest features)
git clone https://github.com/ggerganov/llama.cpp
cd llama.cpp
make -j server

# Or use prebuilt binaries from https://github.com/ggerganov/llama.cpp/releases

# Run with a model (adjust -m, --host, --port)
./llama-server -m models/Meta-Llama-3.1-70B-Instruct-Q4_K_M.gguf \
  --host 0.0.0.0 --port 8080 \
  -c 32768 --n-gpu-layers 99
```

### 2. Configure

```yaml
providers:
  local:
    provider_type: llama-server   # or just use the default "llama-server"
    base_url: http://localhost:8080
    model: llama3.1:70b            # any model name your server knows
    num_ctx: 32768
    typical_p: 0.9
    repeat_last_n: 64
    mirostat: 2
    mirostat_tau: 5.0
    seed: 42

agents:
  local:
    provider: local
    local: true
```

### Config Options

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `base_url` | string | `http://localhost:8080` | Must point to your `llama-server` (no `/v1`) |
| `model` | string | `default` | Model alias or path known to the server |
| `num_ctx` | number | `8192` | Context window (matches server `-c`) |
| `temperature` | number | `0.7` | Sampling temperature |
| `top_p` | number | `0.9` | Nucleus sampling |
| `typical_p` | number | `0.9` | Locally typical sampling (llama.cpp specific) |
| `repeat_penalty` | number | `1.1` | Repetition penalty |
| `repeat_last_n` | number | `64` | Last N tokens to consider for repetition |
| `mirostat` | number | `0` | 0=off, 1=Mirostat v1, 2=v2 |
| `mirostat_tau` | number | `5.0` | Target surprise value |
| `mirostat_eta` | number | `0.1` | Learning rate for Mirostat |
| `seed` | number | `-1` | Random seed (`-1` = random) |
| `first_chunk_timeout_ms` | number | `120000` | Timeout for first token |
| `chunk_timeout_ms` | number | `30000` | Timeout between tokens |

**Note:** This provider is **llama.cpp-specific**. It talks directly to the native llama-server endpoints (not the OpenAI-compat layer). A future generic `openai` provider is planned for OpenRouter, Together, Fireworks, vLLM, etc.

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
