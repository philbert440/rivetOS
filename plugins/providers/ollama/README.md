# @rivetos/provider-ollama

Ollama provider — native API, streaming, tool calling, model management

Part of [RivetOS](https://rivetos.dev) — the open-source agent runtime.

## What it does

Connects a RivetOS agent to an Ollama instance using its native `/api/chat` endpoint. Handles streaming chat, tool calling, model management (list, pull, switch, unload), and Qwen-style thinking control.

## Features

- **Native Ollama API** — uses `/api/chat` directly, not OpenAI-compatible mode
- **Streaming** — real-time token streaming with tool call support
- **Tool calling** — function calling for models that support it
- **Thinking control** — `/think` and `/no_think` prefix support for Qwen models
- **Model management** — list, show, pull, unload, and switch models at runtime
- **Keep-alive control** — configurable model keep-alive duration
- **Context window** — configurable `num_ctx` for context size

## Installation

```bash
npm install @rivetos/provider-ollama
```

## Configuration

```yaml
providers:
  ollama:
    baseUrl: http://localhost:11434  # optional
    model: llama3.1                  # optional
    numCtx: 32768                    # optional
    keepAlive: 30m                   # optional
```

## Documentation

See [rivetos.dev](https://rivetos.dev) for full documentation.

## License

MIT
