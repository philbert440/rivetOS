# rivet-memory (Hermes)

RivetOS shared-memory provider plugin for [Hermes](https://github.com/...).
Captures every Hermes turn — plus memory-tool writes, delegations, and
pre-compression messages — into the cross-agent RivetOS memory database, and
exposes FTS + vector recall over the same store. Direct Postgres, no SSH
bridge, no MCP indirection.

The sibling plugin for Claude Code lives at
[`integrations/claude-code/rivet-memory/`](../../claude-code/rivet-memory/).

## What's new in 0.3 — time-aware tooling

v0.2 shipped the discipline rules; v0.3 makes the tools easy to use correctly
on the first try, after a real grok-4.3 Hermes session surfaced three failure
modes the rules alone didn't cover.

- **`window=` enum on browse + search** — `today` / `yesterday` /
  `this_morning` / `this_week` / `last_24h`. Resolves to UTC bounds anchored
  at the server's *local* midnight, so the agent doesn't have to do
  TZ math. `window=` overrides explicit `since`/`before` only when neither is
  provided. Sidesteps the "`since=\"2026-05-23\"` is actually UTC midnight =
  8pm EDT yesterday" trap.
- **Local-TZ timestamps in browse output.** Rows render as
  `[2026-05-23 13:34:38 EDT]` instead of bare UTC numbers, so the agent
  can't mis-read a UTC-morning row as "early local morning."
- **Truncation hint when browse hits `limit`** — tells the agent to flip
  `order`, raise `limit` (max 200), or narrow the window instead of
  silently capping at 50.
- **Prefetch hint instead of silent skip on time cues.** When the user's
  message looks time-bounded ("today", "yesterday", "this morning", "last
  week", "yesterdays standup", ...), prefetch returns a one-line
  `<rivet-memory-context>` pointing at the exact
  `rivet_memory_browse(window=...)` call rather than injecting stale
  relevance-ranked hits.
- **Real OR/phrase/NOT in `rivet_memory_search`** — switched from
  `plainto_tsquery` to `websearch_to_tsquery`. `foo OR bar` is OR (not AND
  of `foo`, `or`, `bar`), `"exact phrase"` matches that phrase, `-noise`
  excludes. The agent can do a multi-angle synonym sweep in one call.
- **Sharper tool descriptions** — search is now framed as topic-required
  (date-only browsing → use browse), and the empty-result message names
  the exact alternate call to try.

## What's new in 0.2 — discipline layer

v0.1 shipped the capture and recall plumbing; v0.2 adds the **rules** that
make a fresh Hermes session reach for the right tool on the first try.

- **`integrations/hermes/memory-recall/SKILL.md`** — auto-loads on
  time-bounded recall cues. Encodes the four rules: `rivet_memory_browse`
  with `since`/`before` FIRST for time-bounded questions; multi-angle
  `rivet_memory_search` (service + host + subnet + role) for topic
  questions; `mode: "trigram"` fallback when semantic returns thin; user
  pushback as a search-quality signal. **Install separately** to
  `~/.hermes/skills/memory-recall/` — see [Install](#install).
- **Expanded `system_prompt_block()`** — the always-on reflex line now
  spells out the three tools, the time-bounded vs topic split, the trigram
  fallback, and the cross-agent caveat. Mirrors the CLAUDE.md addition the
  Claude Code plugin shipped in [#191](https://github.com/philbert440/rivetOS/pull/191).
- **Timezone hardening** — the skill is explicit that the user's "this
  morning" is local time, not UTC; recipes convert local windows to UTC for
  the query so PT/MT/ET users don't accidentally browse the previous
  evening's slice.

Hermes has no named-subagent-profile system (delegation is per-call), so the
fourth piece of the Claude Code v0.2 PR — the `memory-researcher` subagent —
isn't replicated. The discipline lives in the skill + system prompt block.

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

# Drop the discipline skill into place (v0.2)
cp -r integrations/hermes/memory-recall $HOME/.hermes/skills/memory-recall
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
