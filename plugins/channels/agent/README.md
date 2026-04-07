# @rivetos/channel-agent

Agent-to-agent channel — HTTP endpoint for cross-instance messaging and mesh coordination

Part of [RivetOS](https://rivetos.dev) — the open-source agent runtime.

## What it does

Exposes an HTTP server so agents on different RivetOS instances can talk to each other. Inbound messages go through the full agent pipeline (memory, hooks, tools) — the remote agent is a first-class participant, not a side channel.

Also provides mesh endpoints for multi-node discovery and registration.

## Features

- **Synchronous messaging** — send a message, wait for the agent's response
- **Fire-and-forget** — async dispatch for notifications and one-way messages
- **Bearer token auth** — shared secret authentication between peers
- **Mesh discovery** — `GET /api/mesh` returns known nodes, `POST /api/mesh/join` registers new ones
- **Health check** — `GET /health` for liveness probes
- **Peer messaging tool** — `agent_message` tool lets agents message each other from within conversations

## Installation

```bash
npm install @rivetos/channel-agent
```

## API

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Liveness check |
| `POST` | `/api/message` | Send a message to this agent |
| `GET` | `/api/mesh` | List known mesh nodes |
| `POST` | `/api/mesh/join` | Register a new mesh node |
| `GET` | `/api/mesh/ping` | Lightweight peer liveness check |

### Message Protocol

```
POST /api/message
Authorization: Bearer <shared-secret>
Content-Type: application/json

{
  "fromAgent": "grok",
  "message": "What's the status of the deploy?",
  "waitForResponse": true,
  "timeoutMs": 120000
}
```

## Documentation

See [rivetos.dev](https://rivetos.dev) for full documentation.

## License

MIT
