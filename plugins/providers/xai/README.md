# @rivetos/provider-xai

xAI Grok provider — Responses API, stateful conversations, streaming, tool calling

Part of [RivetOS](https://rivetos.dev) — the open-source agent runtime.

## What it does

Connects a RivetOS agent to xAI's Grok models using the Responses API (`/v1/responses`). Supports stateful server-side conversation storage via `previous_response_id`, which means only new messages are sent per turn — massive token savings on long conversations.

## Features

- **Responses API** — uses `/v1/responses` for stateful conversations
- **Continuation logic fix (PR #72)** — only the newest user/assistant/tool turn is sent after `previous_response_id`; full history is never re-sent
- **Server-side history** — `store: true` (default) keeps conversation on xAI's servers, only new messages sent per turn
- **conversationId promotion** — `XAIExtendedChatOptions.conversationId` promoted to shared `@rivetos/types/ChatOptions`
- **Streaming** — native SSE streaming with text + tool call deltas
- **Tool calling** — full function calling support
- **Encrypted reasoning** — passthrough for Grok's encrypted reasoning tokens
- **Long timeouts** — 1-hour default timeout for reasoning models
- **Chat Completions fallback** — automatically falls back for non-reasoning models
- **Fleet updates** — use `rivetos update --mesh` or the `rivet-provider-update-workflow` skill (via `skill_manage` tool) to keep providers current

Last updated: 2026-04-15 (docs audit syncing with current runtime behavior).

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
