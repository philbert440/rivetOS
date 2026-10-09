# rivet-den — OpenCode adapter

Streams an OpenCode session into the den-protocol event stream, so a
conversation started from RivetHub (or the den drawer) shows its prompts,
replies, reasoning and tool calls in chat, and its turn boundaries release
RivetHub's send queue.

OpenCode has no shell hooks; this is an in-process plugin
(`plugin/rivet-den.ts`) that listens on OpenCode's event bus and POSTs den
events. It is dependency-free and runs under OpenCode's bundled Bun.

## Install

Copy the plugin into OpenCode's global plugin directory:

```bash
cp integrations/opencode/rivet-den/plugin/rivet-den.ts ~/.config/opencode/plugins/rivet-den.ts
```

OpenCode loads it on its next start. Running sessions keep their old plugin set
until they restart.

## Identity

Every event carries two ids, as with the Hermes and Kimi hooks:

- `session` — the den **room**: `RIVET_DEN_SESSION`, injected by the den PTY
  spawner. An OpenCode launched outside den reports under its canonical
  `opencode:<ses_…>` id instead.
- `harnessSession` — OpenCode's own `ses_…` id. The `opencode` HarnessDriver
  binds the room to it (OpenCode cannot be told what to call a new session), and
  reads a change of id in the same room (`/new`) as a rotation.

## Configuration (env)

- `RIVET_DEN_URL` — den-server base(s), comma-separated (default loopback http+https)
- `RIVET_DEN_TOKEN` — bearer token when the server has auth enabled
- `RIVET_DEN_NAME` — session display name (default: hostname)
- `RIVET_DEN_CA` — CA chain for https dens
- `RIVETOS_DEN_HOOK_DISABLED=1` — turn the plugin off

The den PTY spawner sets all of these for the OpenCode it launches. The plugin
is best-effort: it never throws into OpenCode, and a den outage never blocks it.

## Events

| OpenCode | den |
| --- | --- |
| first user text part | `session.start`, then `message.user` |
| user text part | `message.user`, `activity: thinking` |
| reasoning part | `thinking.delta` (deltas), `thinking.end` before the reply |
| assistant text part | `message.agent` (deltas) |
| tool part running / completed | `tool.start` / `tool.end` |
| `session.idle` / `session.error` | `message.agent` with turn stats, `turn.end` |

Nothing is sent until a human prompt arrives, so a pane left at its empty
prompt makes no ghost room. Sub-agent sessions (a `parentID`) and synthetic or
harness-injected parts are skipped. Token-by-token updates are coalesced over
an 80 ms window before posting.

## Tests

```bash
npm test -w @rivetos/opencode-rivet-den
```

## Privacy

Same policy as the Claude Code plugin: den access = session-transcript access.
Keep den-servers loopback or LAN + token-gated.
