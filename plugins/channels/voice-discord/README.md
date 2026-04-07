# @rivetos/channel-voice-discord

Discord voice channel — xAI Realtime API, auto-join, DAVE E2EE

Part of [RivetOS](https://rivetos.dev) — the open-source agent runtime.

## What it does

Puts a RivetOS agent in a Discord voice channel with real-time bidirectional audio. Uses xAI's Realtime API over WebSocket for speech-to-speech conversation. The bot auto-joins when an allowed user enters voice and auto-leaves with a grace period when they disconnect.

## Features

- **xAI Realtime API** — bidirectional speech-to-speech via WebSocket
- **Auto-join** — automatically joins when an allowed user enters a voice channel
- **Auto-leave** — disconnects after a configurable grace period when all users leave
- **Startup scan** — joins immediately if a user is already in voice on boot
- **DAVE E2EE** — supports Discord's end-to-end encryption (required as of 2026-03)
- **Audio pipeline** — Opus decode → PCM 24kHz → xAI → PCM → 48kHz stereo → Discord
- **Server VAD** — voice activity detection handled server-side by xAI
- **Voice switching** — change AI voice via `/voice voice` slash command
- **Transcript logging** — saves conversation transcripts to markdown files
- **Slash commands** — `/voice join`, `/voice leave`, `/voice status`, `/voice voice`

## Installation

```bash
npm install @rivetos/channel-voice-discord
```

## Peer dependencies

- `discord.js` ^14.x
- `@discordjs/voice` ^0.19.x
- `sodium-native` ^5.x
- `mediaplex` ^1.x

## Documentation

See [rivetos.dev](https://rivetos.dev) for full documentation.

## License

MIT
