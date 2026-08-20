---
title: Channels
description: Channel plugins — social bots removed; agent mesh remains
---

# Channels

## Phase 5: social channels removed

RivetOS **removed** the first-party social channel plugins:

| Plugin | Status |
|--------|--------|
| `@rivetos/channel-telegram` | **Removed** |
| `@rivetos/channel-discord` | **Removed** |
| `@rivetos/channel-voice-discord` | **Removed** |

**Product path for human interaction:** [RivetHub](/guides/hub-setup/) via the node gateway (web, desktop, Android).

### Stale fleet config

If a node still has `channels.telegram:`, `channels.discord:`, or `channels.voice` / `channels.voice-discord:` in `config.yaml`:

1. Config validation emits an **unknown channel type warning** (not an error).
2. Plugin discovery no longer finds those packages, so nothing is registered.
3. The node **does not crash-loop**: boot continues with Hub/gateway and other plugins.

Remove the stale keys when convenient. `rivetos doctor` no longer probes Discord/Telegram bot tokens.

## Remaining first-party channel: agent (mesh)

`@rivetos/channel-agent` (`plugins/channels/agent/`) is the agent-to-agent mesh channel. It is **not** social UX — it is for cross-node messaging over mTLS.

```yaml
channels:
  agent:
    port: 3100
    agent_id: opus
    # peers configured via mesh discovery in modern setups
```

See [Mesh](/guides/mesh/) and [Architecture](/reference/architecture/) for the control-plane picture.

## Custom channels

The Channel plugin interface still exists. You can publish third-party channel plugins; they appear under `config.channels.<name>` when installed. First-party social bots will not return.
