---
title: Channel Setup
sidebar:
  order: 5
description: How to connect RivetOS to Discord, Telegram, voice, and agent-to-agent messaging
---

Channels connect your agents to messaging platforms. Each channel plugin handles the platform's API, message formatting, rate limits, and streaming behavior so your agent just sends and receives text.

RivetOS ships with four channel plugins:

| Channel | Platform | Use Case |
|---------|----------|----------|
| **Discord** | Discord servers & DMs | Primary chat interface, streaming responses, reactions |
| **Telegram** | Telegram bots | Mobile-friendly, simple setup |
| **Voice** | Discord voice channels | Real-time voice conversations via xAI Realtime or Gemini Live API |
| **Agent** | HTTP (internal) | Agent-to-agent messaging, mesh networking |

---

## Discord

The Discord channel connects your agent to Discord servers and DMs using [discord.js](https://discord.js.org/). It supports streaming message edits, emoji reactions, thread creation, embeds, buttons, and file attachments.

### 1. Create a Discord Bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application** → give it a name → **Create**
3. Go to **Bot** in the sidebar
4. Click **Reset Token** → copy the token (you'll only see it once)
5. Under **Privileged Gateway Intents**, enable:
   - ✅ **Message Content Intent**
   - ✅ **Server Members Intent** (optional, for member info)

### 2. Invite the Bot to Your Server

1. Go to **OAuth2** → **URL Generator** in the sidebar
2. Under **Scopes**, check: `bot`, `applications.commands`
3. Under **Bot Permissions**, check:
   - Send Messages
   - Read Message History
   - Add Reactions
   - Manage Messages (for editing streamed responses)
   - Create Public Threads (optional)
   - Attach Files (optional)
   - Use Slash Commands
4. Copy the generated URL → open it in your browser → select your server → **Authorize**

### 3. Get Your Channel IDs

1. In Discord, go to **User Settings** → **Advanced** → enable **Developer Mode**
2. Right-click any channel → **Copy Channel ID**
3. Right-click your user → **Copy User ID** (for `owner_id`)

### 4. Configure

Add the bot token to `.env`:

```bash
DISCORD_BOT_TOKEN=MTIz...your-token-here
```

Add the channel config to `config.yaml`:

```yaml
channels:
  discord:
    owner_id: "YOUR_USER_ID"
    channel_bindings:
      "123456789012345678": opus     # #deep-thinking → opus agent
      "987654321098765432": grok     # #brainstorm → grok agent
```

### Config Options

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `channel_bindings` | object | **required** | Maps Discord channel IDs → agent names |
| `owner_id` | string | — | Your Discord user ID. Enables owner-only features |
| `bot_token` | string | `${DISCORD_BOT_TOKEN}` | Bot token. Always use env var |
| `mention_only` | boolean | `false` | Only respond when @mentioned in servers |
| `allowed_guilds` | string[] | — | Restrict to specific server IDs |
| `allowed_channels` | string[] | — | Restrict to specific channel IDs |
| `allowed_users` | string[] | — | Restrict to specific user IDs |

### Notes

- **Message limit:** 2000 characters. The plugin automatically splits longer responses into multiple messages.
- **Streaming:** Responses stream in real-time by editing the message as tokens arrive. Discord rate limits apply — the plugin throttles edits automatically.
- **Reactions:** The agent can react to messages with emoji. Useful for acknowledgements without cluttering the chat.
- **Threads:** The agent can create and reply in threads for long conversations.

---

## Telegram

The Telegram channel connects your agent to a Telegram bot using [grammY](https://grammy.dev/). It supports text, photos, voice messages, documents, inline buttons, and HTML-formatted responses.

### 1. Create a Telegram Bot

1. Open Telegram and message [@BotFather](https://t.me/BotFather)
2. Send `/newbot`
3. Follow the prompts — choose a name and username
4. BotFather gives you an API token like `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`
5. Copy the token

### 2. Get Your User ID

Your Telegram user ID is a number (not your @username). To find it:

1. Message [@userinfobot](https://t.me/userinfobot) on Telegram
2. It replies with your numeric user ID

The `owner_id` restricts the bot to only respond to you. Without it, anyone who finds your bot can talk to it.

### 3. Configure

Add the bot token to `.env`:

```bash
TELEGRAM_BOT_TOKEN=123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11
```

Add the channel config to `config.yaml`:

```yaml
channels:
  telegram:
    owner_id: "YOUR_NUMERIC_USER_ID"
```

### Config Options

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `owner_id` | string | **required** | Your Telegram user ID. Only this user can talk to the bot |
| `bot_token` | string | `${TELEGRAM_BOT_TOKEN}` | Bot API token from BotFather |
| `allowed_users` | string[] | — | Additional user IDs allowed to use the bot |
| `agent` | string | — | Default agent to route messages to |

### Notes

- **Message limit:** 4096 characters. Longer responses are split automatically.
- **Formatting:** Markdown is converted to Telegram HTML format automatically. Code blocks, bold, italic, and links all work.
- **Streaming:** Responses stream by editing the message in-place, similar to Discord.
- **409 Conflict:** If you run multiple instances with the same bot token, Telegram returns 409 errors. The plugin handles this with backoff and retry, but you should only run one instance per token.

---

## Discord Voice

The voice channel plugin connects your agent to Discord voice channels for real-time spoken conversations. It supports multiple voice providers — choose the one that fits your setup.

### Voice Providers

| Provider | Backend | Best For |
|----------|---------|----------|
| **xai** | [xAI Realtime API](https://docs.x.ai/docs/guides/realtime-conversations) | Native xAI users, low-latency |
| **gemini** | [Gemini Live API](https://ai.google.dev/gemini-api/docs/live) | Google ecosystem, Google Search grounding |

### Prerequisites

- A Discord bot token (same one used for the text Discord channel is fine, or a separate one)
- An API key for your chosen voice provider (xAI or Google)
- The bot must have **Connect** and **Speak** permissions in the voice channel

### 1. Configure

Add keys to `.env`:

```bash
DISCORD_VOICE_TOKEN=MTIz...your-token-here

# For xAI provider:
XAI_API_KEY=xai-...your-key-here

# For Gemini provider:
GOOGLE_API_KEY=AIza...your-key-here
```

Add to `config.yaml`:

```yaml
# Example: Gemini Live provider
channels:
  voice-discord:
    provider: gemini
    discord_token: ${DISCORD_VOICE_TOKEN}
    google_api_key: ${GOOGLE_API_KEY}
    guild_id: "YOUR_SERVER_ID"
    voice_channel_id: "YOUR_VOICE_CHANNEL_ID"
    allowed_users:
      - "YOUR_USER_ID"
    voice: "Kore"
    instructions: "You are a helpful assistant. Be concise in voice responses."
```

```yaml
# Example: xAI Realtime provider
channels:
  voice-discord:
    provider: xai
    discord_token: ${DISCORD_VOICE_TOKEN}
    xai_api_key: ${XAI_API_KEY}
    guild_id: "YOUR_SERVER_ID"
    voice_channel_id: "YOUR_VOICE_CHANNEL_ID"
    allowed_users:
      - "YOUR_USER_ID"
    voice: "Ara"
    instructions: "You are a helpful assistant. Be concise in voice responses."
```

### Config Options

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `provider` | string | `xai` | Voice provider: `xai` or `gemini` |
| `discord_token` | string | **required** | Discord bot token |
| `guild_id` | string | **required** | Discord server ID |
| `voice_channel_id` | string | — | Bind to a specific voice channel (recommended for multi-agent) |
| `allowed_users` | string[] | **required** | User IDs allowed to activate the bot |
| `voice` | string | `Ara` (xAI) / `Kore` (Gemini) | Voice to use for text-to-speech |
| `instructions` | string | — | System instructions for the voice agent |
| `silence_duration_ms` | number | `1500` | How long to wait after silence before responding |
| `sample_rate` | number | `24000` | Audio sample rate (Hz) |
| `transcript_dir` | string | `transcripts` | Directory for voice transcript logs |
| `leave_grace_period_ms` | number | `10000` | How long to wait before leaving after everyone else leaves |
| `xai_api_key` | string | — | xAI API key (required for `xai` provider) |
| `google_api_key` | string | — | Google API key (required for `gemini` provider) |
| `gemini_model` | string | `gemini-2.0-flash-live-001` | Gemini model for live voice (only for `gemini` provider) |
| `xai_collection_id` | string | — | xAI knowledge collection for context (only for `xai` provider) |

### How It Works

1. **Auto-join:** When an allowed user joins a voice channel, the bot automatically joins too
2. **Voice activity detection (VAD):** The provider detects when you're speaking (server-side VAD)
3. **Audio pipeline:** Discord Opus → PCM → Voice Provider → PCM → 48kHz stereo → Discord
4. **Auto-leave:** When all users leave, the bot leaves after the grace period
5. **Transcripts:** All voice conversations are logged to markdown files
6. **Memory tools:** The voice agent can search your conversation memory via function calling

### Multi-Agent Voice

Each agent can bind to its own voice channel with its own provider:

```yaml
# Grok uses xAI Realtime in one VC
channels:
  voice-discord:
    provider: xai
    voice_channel_id: "111222333"
    # ...

# Opus uses Gemini Live in another VC
channels:
  voice-discord:
    provider: gemini
    voice_channel_id: "444555666"
    # ...
```

### Slash Commands

Once the bot is in your server, these slash commands are available:

| Command | Description |
|---------|-------------|
| `/voice join` | Force the bot to join your voice channel |
| `/voice leave` | Force the bot to leave |
| `/voice status` | Show current voice session info |
| `/voice voice [name]` | Switch the TTS voice |

---

## Agent (HTTP)

The agent channel enables agent-to-agent communication over HTTP. This is how multi-instance mesh networking works — agents on different machines can send messages to each other.

### When to Use

- **Multi-agent setups:** Opus delegates tasks to Grok on another machine
- **Mesh networking:** Multiple RivetOS instances share work
- **API access:** External systems can send messages to your agent

### Configure

Add a shared secret to `.env`:

```bash
RIVETOS_AGENT_SECRET=your-shared-secret-here
```

Add to `config.yaml`:

```yaml
channels:
  agent:
    port: 3100
    secret: ${RIVETOS_AGENT_SECRET}
```

For mesh networking, also configure the mesh section:

```yaml
mesh:
  nodes:
    - name: rivet-opus
      host: 192.0.2.10
      port: 3100
      agents: [opus]
    - name: rivet-grok
      host: 192.0.2.11
      port: 3100
      agents: [grok]
```

### Config Options

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `port` | number | `3100` | HTTP port for the agent API |
| `host` | string | `0.0.0.0` | Bind address |
| `secret` | string | **required** | Shared secret for authentication |
| `peers` | object | — | Named peer agents with their URLs |

### API Endpoints

The agent channel exposes these HTTP endpoints:

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/message` | Send a message to the agent |
| `GET` | `/api/health` | Health check |
| `GET` | `/api/mesh` | List mesh nodes |
| `POST` | `/api/mesh/join` | Register a new mesh node |

### Sending a Message

```bash
curl -X POST http://localhost:3100/api/message \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-shared-secret" \
  -d '{
    "fromAgent": "external",
    "message": "Hello, what is the status of the project?",
    "waitForResponse": true
  }'
```

---

## Multiple Channels

You can run multiple channels simultaneously. A common setup:

```yaml
channels:
  discord:
    owner_id: "111222333"
    channel_bindings:
      "444555666": opus
      "777888999": grok

  telegram:
    owner_id: "123456789"

  agent:
    port: 3100
    secret: ${RIVETOS_AGENT_SECRET}
```

Each channel routes messages to agents independently. The same agent can receive messages from multiple channels.

---

## Next Steps

- **[Provider Setup](/guides/providers/)** — Configure the LLMs your agents talk to
- **[Configuration Reference](/reference/config/)** — Full option tables for all config sections
- **[Plugin Development](/guides/plugins/)** — Build your own channel plugin
