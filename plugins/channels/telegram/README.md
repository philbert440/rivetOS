# @rivetos/channel-telegram

Telegram channel — grammY, Bot API, streaming message edits

Part of [RivetOS](https://rivetos.dev) — the open-source agent runtime.

## What it does

Connects a RivetOS agent to Telegram via long polling. Handles text, photos, voice messages, documents, inline buttons, and streaming edits. Converts markdown to Telegram-compatible HTML with automatic fallback to plain text.

## Features

- **grammY framework** — modern Telegram Bot API client
- **Rich input** — text, photos, voice, documents with automatic attachment resolution
- **Inline keyboards** — buttons with callback data routing
- **Message editing** — in-place edits for streaming responses with overflow handling
- **Emoji reactions** — react to messages via Telegram's reaction API
- **Markdown → HTML** — converts agent markdown to Telegram HTML, falls back to plain text on parse errors
- **Message splitting** — auto-splits at Telegram's 4096 char limit
- **Typing indicator** — sends "typing" action while processing
- **Slash commands** — `/start`, `/new`, `/stop`, `/model`, `/think`, and more
- **409 conflict handling** — detects competing bot instances, retries with backoff
- **Access control** — user allowlist with owner override

## Installation

```bash
npm install @rivetos/channel-telegram
```

## Peer dependencies

- `grammy` ^1.x

## Documentation

See [rivetos.dev](https://rivetos.dev) for full documentation.

## License

MIT
