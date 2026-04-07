# @rivetos/provider-google

Google Gemini provider — native Generative Language API, streaming, tool calling, grounding

Part of [RivetOS](https://rivetos.dev) — the open-source agent runtime.

## What it does

Connects a RivetOS agent to Google's Gemini models using the native Generative Language API (not OpenAI-compatible). Handles streaming, tool calling, thinking/thought summaries, and grounding.

## Features

- **Native Gemini API** — uses `streamGenerateContent` directly, not an OpenAI shim
- **Streaming** — SSE streaming with text + tool call deltas
- **Tool calling** — function declarations with JSON schema
- **Thinking** — configurable thinking budgets (off/low/medium/high)
- **Grounding** — Google Search grounding support
- **Image support** — inline base64 images
- **Error handling** — typed ProviderError with rate limit detection

## Installation

```bash
npm install @rivetos/provider-google
```

## Configuration

```yaml
providers:
  google:
    apiKey: AIza...
    model: gemini-2.5-pro       # optional
    maxTokens: 8192              # optional
```

## Documentation

See [rivetos.dev](https://rivetos.dev) for full documentation.

## License

MIT
