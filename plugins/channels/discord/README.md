# @rivetos/channel-discord

Discord channel — discord.js v14, channel bindings, threads, embeds, streaming edits

Part of [RivetOS](https://rivetos.dev) — the open-source agent runtime.

## What it does

Connects a RivetOS agent to Discord. Handles inbound messages, access control, and outbound replies with full Discord feature support. Channel bindings let you route specific Discord channels to specific agents (e.g., `#deep-thinking` → opus, `#brainstorm` → grok).

## Features

- **Channel bindings** — map Discord channels to specific agents
- **Thread support** — create and reply in threads
- **Embeds** — rich embedded content with fields, colors, footers
- **Action rows** — interactive buttons with callback routing
- **Emoji reactions** — react to messages programmatically
- **Message editing** — in-place edits for streaming responses
- **Message splitting** — auto-splits at Discord's 2000 char limit
- **Mention activation** — optionally only respond when @mentioned in servers
- **Slash commands** — intercepts `/command` messages
- **Typing indicator** — shows typing while processing
- **Attachment handling** — photos, documents via Discord CDN URLs
- **Access control** — allowlists for guilds, channels, and users

## Installation

```bash
npm install @rivetos/channel-discord
```

## Peer dependencies

- `discord.js` ^14.x

## Documentation

See [rivetos.dev](https://rivetos.dev) for full documentation.

## License

MIT
