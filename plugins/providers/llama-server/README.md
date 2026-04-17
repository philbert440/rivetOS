# @rivetos/provider-llama-server

llama.cpp server (llama-server) provider for RivetOS — native llama-server sampling, reasoning, and tool-use semantics.

Part of [RivetOS](https://rivetos.dev) — the open-source agent runtime.

## What it does

Speaks directly to [llama-server](https://github.com/ggml-org/llama.cpp/tree/master/tools/server) at `POST /v1/chat/completions`. This is **not** a generic OpenAI-compat shim — it is built for one server and exposes llama-server's actual knobs.

If you want to hit vLLM, OpenRouter, Together, Fireworks, or OpenAI proper, use a different provider. Features, sampling parameters, streaming semantics, and tool-call shapes here are tuned for llama.cpp.

## Features

- **Streaming SSE** — text, reasoning, and tool-call deltas
- **Reasoning** — native `reasoning_content` (llama-server `--reasoning-format deepseek`) plus inline `<think>` block parsing for deepseek-legacy / models that emit thoughts in content
- **Tool calling** — OpenAI-style function calling with lenient JSON parsing for malformed arguments (a known llama-server quirk)
- **llama-native sampling** — `top_k`, `min_p`, `typical_p`, `repeat_penalty`, `repeat_last_n`, `presence_penalty`, `frequency_penalty`, `mirostat` (+tau/eta), `seed`
- **Stream timeouts** — configurable first-chunk and inter-chunk timeouts
- **Optional API key** — sends `Authorization: Bearer` only when `apiKey` is set (matches llama-server `--api-key`)
- **Multimodal** — image parts forwarded as `image_url` blocks for models loaded with `--mmproj`
- **Health check** — `isAvailable()` hits `GET /health`

## Installation

```bash
npm install @rivetos/provider-llama-server
```

## Configuration

In `config.yaml`:

```yaml
providers:
  llama-server:
    base_url: http://localhost:8080
    # api_key: optional, matches llama-server --api-key
    model: default              # alias set by llama-server --alias
    max_tokens: 4096
    temperature: 0.8
    top_p: 0.95
    # llama-native knobs (all optional — server defaults apply if omitted)
    top_k: 40
    min_p: 0.05
    repeat_penalty: 1.1
    repeat_last_n: 64
    presence_penalty: 0.0
    frequency_penalty: 0.0
    # mirostat: 2
    # mirostat_tau: 5.0
    # mirostat_eta: 0.1
    # seed: 42
    context_window: 32768
    max_output_tokens: 4096
```

You can register multiple instances pointing at different llama-server endpoints by using distinct IDs:

```yaml
providers:
  llama-qwen:
    base_url: http://gerty:8080
    model: qwen3-32b
  llama-gemma:
    base_url: http://gerty:8081
    model: gemma4-27b
```

## Why not OpenAI-compat?

This is the dedicated native provider for llama.cpp's `llama-server`. Earlier versions used a generic OpenAI-compat wrapper that had accumulated too many llama-specific hacks. This version uses the native endpoints directly and exposes all llama.cpp sampling parameters cleanly.

## License

MIT
