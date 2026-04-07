# @rivetos/provider-xai

xAI Grok provider — Responses API, stateful conversations, streaming, tool calling

Part of [RivetOS](https://rivetos.dev) — the open-source agent runtime.

## What it does

Connects a RivetOS agent to xAI's Grok models using the Responses API (`/v1/responses`). Supports stateful server-side conversation storage via `previous_response_id`, which means only new messages are sent per turn — massive token savings on long conversations.

## Features

- **Responses API** — uses `/v1/responses` for stateful conversations
- **Server-side history** — `store: true` keeps conversation on xAI's servers, only new messages sent per turn
- **Streaming** — native SSE streaming with text + tool call deltas
- **Tool calling** — full function calling support
- **Encrypted reasoning** — passthrough for Grok's encrypted reasoning tokens
- **Long timeouts** — 1-hour default timeout for reasoning models
- **Chat Completions fallback** — automatically falls back for non-reasoning models

## Installation

```bash
npm install @rivetos/provider-xai
```

## Configuration

```yaml
providers:
  xai:
    apiKey: xai-...
    model: grok-4.20-reasoning  # optional
    store: true                  # optional, default: true
    timeoutMs: 3600000           # optional, default: 1 hour
```

## Documentation

See [rivetos.dev](https://rivetos.dev) for full documentation.

## License

MIT
