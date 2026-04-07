# @rivetos/provider-anthropic

Anthropic Claude provider — streaming, tool calling, thinking, OAuth support

Part of [RivetOS](https://rivetos.dev) — the open-source agent runtime.

## What it does

Connects a RivetOS agent to Anthropic's Claude models. Handles streaming chat completions, tool calling, extended thinking with configurable budgets, and prompt caching. Supports both API key and OAuth authentication.

## Features

- **Streaming** — native SSE streaming with text + tool call deltas
- **Tool calling** — full function calling with JSON schema definitions
- **Extended thinking** — configurable thinking budgets (off/low/medium/high)
- **Prompt caching** — cache_control on system prompts for cost savings
- **OAuth support** — automatic token refresh for OAuth-based auth (sk-ant-oat01-)
- **Image support** — inline base64 images and URL-based images
- **Error handling** — typed ProviderError with rate limit detection

## Installation

```bash
npm install @rivetos/provider-anthropic
```

## Configuration

```yaml
providers:
  anthropic:
    apiKey: sk-ant-api03-...
    model: claude-sonnet-4-20250514  # optional
    maxTokens: 8192                    # optional
    baseUrl: https://api.anthropic.com # optional
```

## Documentation

See [rivetos.dev](https://rivetos.dev) for full documentation.

## License

MIT
