# rivet-memory (Hermes)

RivetOS shared-memory provider plugin for [Hermes](https://github.com/...).
Captures every Hermes turn — plus memory-tool writes, delegations, and
pre-compression messages — into the cross-agent RivetOS memory database, and
exposes FTS + vector recall over the same store. Direct Postgres, no SSH
bridge, no MCP indirection.

The sibling plugin for Claude Code lives at
[`integrations/claude-code/rivet-memory/`](../../claude-code/rivet-memory/).

## What it does

| Hermes hook | What the plugin writes |
|---|---|
| `sync_turn(user, asst)` | Two `ros_messages` rows (`role=user`, `role=assistant`) on the active conversation |
| `on_memory_write(action, target, content, metadata)` | `role=system` row tagged `metadata.source='hermes-memory-tool'` |
| `on_delegation(task, result, child_session_id)` | `role=system` row tagged `metadata.kind='delegation'` |
| `on_pre_compress(messages)` | Bulk-inserts about-to-be-discarded messages so nothing is lost |
| `on_session_switch` / `on_session_end` | Closes the conversation or links it to a new session_id |
| `prefetch(query)` | FTS + vector hybrid recall, formatted as a `<rivet-memory-context>` block |
| `handle_tool_call(...)` | Dispatches `rivet_memory_search`, `rivet_memory_browse`, `rivet_memory_stats` |

## Identity

- **Agent tag:** `rivet-hermes` (sibling to `rivet-claude`, discoverable via
  `memory_search(agent='rivet-hermes')`).
- **Channel:** `hermes-<platform>` (`hermes-cli`, `hermes-telegram`, etc.) —
  taken from the `platform` kwarg of `initialize()`.
- **Conversation key:** `hermes:<session_id>`.

## Install

The plugin loads from `$HERMES_HOME/plugins/rivet_memory/`. The repo directory
uses the hyphenated brand name (`rivet-memory`); the install target uses an
underscore so Python attribute lookup for CLI handlers works.

```sh
# Install dependencies into the Hermes venv
HERMES_VENV=$HOME/.hermes/hermes-agent/venv
$HERMES_VENV/bin/pip install -r requirements.txt

# Drop the plugin into place
cp -r integrations/hermes/rivet-memory $HOME/.hermes/plugins/rivet_memory
```

Then run `hermes memory setup` to populate `RIVETOS_PG_URL` and activate:

```yaml
# ~/.hermes/config.yaml
memory:
  provider: rivet_memory
```

## Configuration

| Key | Default | Notes |
|---|---|---|
| `pg_url` | env `RIVETOS_PG_URL` | Postgres URL of the RivetOS memory DB. Required. Secret. |
| `agent` | `rivet-hermes` | Agent tag written to every row |
| `channel_prefix` | `hermes` | Suffixed with the platform kwarg at runtime |
| `recall_enabled` | `true` | Disable to skip prefetch entirely |
| `recall_limit` | `10` | Max hits returned per prefetch |
| `recall_mode` | `fts` | `fts` / `trigram` / `hybrid` |
| `mirror_memory_md` | `true` | Mirror Hermes's `MEMORY.md`/`USER.md` writes into RivetOS |
| `preserve_compressed` | `true` | Capture pre-compression messages before Hermes drops them |

Secrets live in `~/.hermes/.env`; non-secrets under `memory.rivet_memory.*`
in `~/.hermes/config.yaml`.

## Capture is best-effort

Every write goes through a background queue. If the DB is down, writes are
dropped (logged) rather than blocking the Hermes turn. Hermes never stalls on
RivetOS being unavailable.

## Status

Pre-1.0. Hooks are implemented incrementally — see the matrix above for
current coverage. Open issues live under `philbert440/rivetOS`.
