# @rivetos/provider-openai-compat

OpenAI-compatible provider — llama-server, vLLM, LM Studio, OpenRouter, and more

Part of [RivetOS](https://rivetos.dev) — the open-source agent runtime.

## What it does

Generic provider for any endpoint that speaks the OpenAI Chat Completions API. Works with local inference servers, hosted APIs, and proxy services. Includes lenient JSON parsing for llama-server's occasionally malformed tool call arguments, and configurable stream timeouts to prevent hanging on stalled models.

## Compatible with

- llama-server / llama.cpp
- vLLM
- LM Studio
- OpenRouter
- Together AI
- Fireworks
- text-generation-webui
- LocalAI
- Any OpenAI-compatible endpoint

## Features

- **Streaming** — SSE streaming with text + tool call deltas
- **Tool calling** — OpenAI-format function calling
- **Lenient JSON parsing** — handles malformed tool arguments from local models
- **Stream timeouts** — configurable first-chunk and inter-chunk timeouts
- **Optional auth** — API key optional for local servers
- **Custom identity** — configurable provider ID and display name
- **Context window** — configurable `num_ctx` for llama-server

## Installation

```bash
npm install @rivetos/provider-openai-compat
```

## Configuration

```yaml
providers:
  local:
    plugin: openai-compat
    baseUrl: http://192.168.1.50:8000/v1
    model: qwen3-30b                 # optional
    apiKey: not-needed               # optional
    maxTokens: 4096                  # optional
    id: local                        # optional
    name: GERTY Local                # optional
```

## Documentation

See [rivetos.dev](https://rivetos.dev) for full documentation.

## License

MIT
