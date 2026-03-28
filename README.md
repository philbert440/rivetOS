# RivetOS

Lightweight, stable agent runtime. MIT licensed.

> Zero bloat. Zero lock-in. Just the loop.

RivetOS is a personal AI agent runtime built for reliability. A tiny, stable core routes messages between channels and LLM providers. Everything else is a plugin.

## Philosophy

- **Tiny core** — The runtime is ~500 lines. It routes messages, executes tools, and manages lifecycle. That's it.
- **Plugin everything** — Channels, providers, memory, tools — all swappable via clean interfaces.
- **Stability over features** — LTS releases. A version that works today works in 12 months.
- **MIT licensed** — Do whatever you want. No CLA, no dual-licensing, no surprises.
- **Your stack** — TypeScript, Node.js, Nx monorepo. Battle-tested, boring technology.

## Architecture

```
Message in (Telegram, Discord, CLI)
  → Route to provider (Anthropic, xAI, Ollama, OpenAI-compat)
  → Inject workspace context (SOUL.md, AGENTS.md, memory)
  → Agent loop (LLM call → tool execution → repeat)
  → Send response to channel
  → Append to transcript store
```

## Project Structure

```
rivetOS/
  packages/
    core/                      ← Agent loop, router, lifecycle (~500 lines)
    types/                     ← Shared interfaces (Provider, Channel, Tool)
  plugins/
    channel-telegram/          ← Telegram Bot API via grammY
    channel-discord/           ← Discord via discord.js v14
    voice-discord/             ← Discord voice via xAI Realtime API
    provider-anthropic/        ← Claude (native Messages API)
    provider-xai/              ← Grok (OpenAI-compatible + caching)
    provider-ollama/           ← Ollama (native API)
    provider-openai-compat/    ← Any OpenAI-compatible endpoint
    memory-postgres/           ← Full transcript archive + hybrid search
    tool-coding-pipeline/      ← Build → review → validate → commit
    runtime-commands/          ← /stop, /new, /steer, reasoning streaming
```

## Quick Start

```bash
git clone https://github.com/philbert440/rivetOS.git
cd rivetOS
npm install
npx nx build core
npx nx serve core
```

## Workspace Files

RivetOS injects workspace files into the agent's system prompt:

| File | Purpose |
|------|---------|
| `SOUL.md` | Agent personality and behavior |
| `IDENTITY.md` | Who the agent is |
| `USER.md` | Who the owner is |
| `AGENTS.md` | Operating instructions |
| `TOOLS.md` | Tool usage notes |
| `MEMORY.md` | Long-term curated memory |
| `memory/YYYY-MM-DD.md` | Daily notes |

## LTS Releases

RivetOS follows a stability-first release model:

- **LTS versions** receive security and bug fixes only. No new features, no breaking changes.
- **Current versions** get new features and plugins.
- Pin to an LTS version and forget about it. It won't break.

## License

MIT — do whatever you want.
