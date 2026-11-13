# rivet-memory

A Claude Code plugin that gives interactive `claude` sessions the full RivetOS
memory loop: **recall** (an MCP server) and **capture** (lifecycle hooks).

Interactive sessions a human runs by hand never had it. This plugin closes that
gap with one install — and, because headless `claude -p` sessions load enabled
user plugins too, it doubles as the **single capture source for every session
type**, headless RivetOS agents included.

The sibling plugin for Hermes lives at
[`integrations/hermes/rivet-memory/`](../../hermes/rivet-memory/) — same shared
RivetOS memory backend, different agent host (Python provider hooks into
Hermes; this one is markdown + MCP for Claude Code). Together they give every
Rivet agent (`rivet-claude`, `rivet-hermes`, future siblings) one cross-agent
memory store.

## Install (strangers — no RivetOS checkout)

```sh
claude plugin marketplace add philbert440/rivetOS
claude plugin install rivet-memory@rivetos
```

Set mode, DataHub URL, embed URL and model, or cloud credentials in the
plugin settings (`userConfig`) or in `~/.rivetos/.env`. Whenever an embed URL
is given, set the embedding model (`RIVETOS_EMBED_MODEL`) too. Check the
connection with `rh doctor` or `rh harness connect`, or with the
`memory-doctor` skill from Rivethub/rstack.

## Skills moved to Rivethub/rstack

The recall skills (`memory-recall`, `memory-today`, `memory-yesterday`,
`memory-stats`), the `memory-researcher` agent, and the onboard and status
skills (replaced by `memory-doctor`) moved to
[Rivethub/rstack](https://github.com/Rivethub/rstack). Install them with
`/plugin marketplace add Rivethub/rstack`. This kit keeps the MCP server and
the capture hooks.

The no-checkout MCP path is `npx -y @rivetos/mcp-sidecar@0.5.0 --stdio`. That
package is not on npm yet; the path works once 0.5.0 is published. Until then,
a built RivetOS tree (`RIVETOS_ROOT` or `/opt/rivetos`) still launches as
before. Until the pinned release is on npm, the no-checkout path reports npm’s not-found error.

Local marketplace from a checkout you already have:

```sh
claude plugin marketplace add /opt/rivetos
claude plugin install rivet-memory@rivetos
```

## What it ships

| Component | File | Effect |
|---|---|---|
| MCP server | `.mcp.json` → `bin/rivet-memory-mcp.sh` | Adds `memory_search`, `memory_browse`, `memory_stats`, `skill_*`, `internet_search`, `web_fetch`. Recall past decisions and commands without asking. |
| Capture hooks | `hooks/hooks.json` → `bin/rivet-memory-hook.sh` | `UserPromptSubmit` + `PostToolUse` capture every prompt and tool call (name, args, result) straight from the hook payload. `Stop`/`SubagentStop`/`SessionEnd` capture assistant text from the transcript. |

The `PostToolUse` row — tool name + full args + full result, one row per call —
is the "which command fixed it 2.5 days ago" record.

## Safe defaults

This kit ships with **shell, file, and search write tools off**. Memory write
tools (`memory_append`, `memory_ingest_session`) stay **off** until the user
opts in with `RIVETOS_MCP_ENABLE_MEMORY_WRITE`. Recall tools are available as soon as a
DataHub / PG URL is configured.

## What's new in 0.3

`0.2` added the discipline layer. `0.3` makes the kit installable by a
stranger with no RivetOS checkout:

- MCP launcher: built checkout if present, otherwise `npx -y @rivetos/mcp-sidecar@0.5.0 --stdio`.
- Capture hook: uses the checkout handler when available; otherwise logs
  one secret-free line to stderr, skips capture, and exits 0.
- `userConfig` for mode, DataHub, embed, cloud URL, cloud token.

Upgrade in place:

```sh
claude plugin update rivet-memory@rivetos
```

## Requirements

**With a RivetOS checkout** (house nodes, unchanged):

- `services/mcp-sidecar/dist/cli.js` — the MCP server
- `plugins/providers/claude-cli/dist/hooks.js` — the capture handler

Run `npm run build` in the RivetOS repo if either is missing.

**Without a checkout:** Node.js and `npx`, plus the pinned
`@rivetos/mcp-sidecar@0.5.0` release once published. Plugin settings or
`~/.rivetos/.env` supply the DataHub. Capture logs and skips; it requires
a built checkout handler.

## Configuration precedence

Plugin settings → `~/.rivetos/.env` → inherited environment, per key.
The file wins over inherited `RIVETOS_*` values; when the file or key is
absent, the inherited value survives. Empty or unsubstituted plugin values
(`${…}` / `${user_config.…}`) fall through to the file and then the environment.
`.mcp.json` passes settings as `RIVETOS_PLUGIN_OPT_<full userConfig key>`
(for example, `RIVETOS_PLUGIN_OPT_RIVETOS_MODE`). The launcher also accepts
`CLAUDE_PLUGIN_OPTION_<full userConfig key>`, which wins if both channels
supply a value. Only effective plugin settings enter `RIVETOS_PLUGIN_KEYS`.
A plugin-supplied Postgres DataHub also overrides the fallback PG URL.

| Var | Default | Purpose |
|---|---|---|
| `RIVETOS_MODE` | unset | `cloud` or `local` |
| `RIVETOS_DATAHUB_URL` | unset | Local DataHub. `postgres://` / `postgresql://` maps to `RIVETOS_PG_URL`; HTTPS is stored, not converted |
| `RIVETOS_EMBED_URL` | unset | Optional embedding endpoint |
| `RIVETOS_EMBED_MODEL` | unset | Required with an embed URL; for example `text-embedding-3-small` |
| `RIVETOS_CLOUD_URL` | `https://rivetos.cloud` when mode is cloud | Cloud API base |
| `RIVETOS_CLOUD_TOKEN` | unset | Secret (set/unset in status; never printed) |
| `RIVETOS_ROOT` | `/opt/rivetos` | RivetOS install root when a checkout exists |
| `RIVETOS_ENV_FILE` | `~/.rivetos/.env` | Env file parsed (never sourced) by the MCP launcher |

Without `RIVETOS_PG_URL` the MCP server still starts, but with `echo` + web
tools only — the memory tools are disabled.

Server exits at start: with an embed URL and Postgres/DataHub URL set, check
`RIVETOS_EMBED_MODEL`. Set the missing model in plugin settings or `~/.rivetos/.env`, then run `rh doctor`.

## Transport

Capture posts batches to this node's den (`POST /api/capture`) by default.
`RIVETOS_CAPTURE_TRANSPORT=den|pg` forces one or the other; `pg` stays for one
release. When the den is down the batch is spooled under
`~/.rivetos/capture-spool` and replayed on the next write. A non-empty
`RIVETOS_USER_ID` stays on Postgres, because loopback den is the owner pool.
`rivet-memory-hook.sh` calls `rivetos_resolve_den` before `node` so Node trusts
the den CA.

A `PostToolUse` payload that carries `tool_use_id` is stored as
`claude-code:<session>:tool:<tool_use_id>` with no transcript read and no
poll. That native id is what makes live capture exact. Without it, the hook
polls `transcript_path` for up to 2s, every 100ms, and binds to the last
`tool_use` with the same name and args anywhere in the file — the match does
not have to be the tail. The id is `claude-code:<session>:tool:<id>` when
that entry has one, otherwise `claude-code:<session>:occ:<hash>:<n>` (`n` is
that entry's occurrence index). If no matching entry appears, the id is the
occurrence id of the hook tuple (`n` is 0). Two identical calls without
`tool_use_id` stay ambiguous: both hooks bind to the last match.

A `UserPromptSubmit` hook polls the same way for the last user entry whose
content equals the prompt, anywhere in the file. The id is
`claude-code:<session>:<uuid>` when that entry has a uuid, otherwise the
occurrence id. If the prompt never appears, the id is
`claude-code:<session>:hook:<spool stem>` and `metadata.source` is
`hook-only`: a later Stop may insert a second row for that turn under the
occurrence id (rare). The worker writes the resolved id back onto the spool
payload as `rivetos_event_id` before ingest, and a retry reuses it instead
of binding again.

## Capture is best-effort

`rivet-memory-hook.sh` always exits 0. A capture failure — DB down, dist
missing — can never disrupt the Claude Code session.
When ingest cannot run, the hook logs a loud error to stderr (it does not
silently succeed). The checkout handler only spools the payload and detaches
a worker, so the hook returns in milliseconds. Checkout capture activity is logged
to `~/.rivetos/claude-capture.log`; skipped capture is reported on stderr.

## Single capture source — no double-capture

Headless `claude -p` sessions load enabled user plugins (verified: a headless
run fires this plugin's hooks). So a session with **both** this plugin and the
legacy `~/.claude/settings.json` hooks (`hooks.js --install`) captures every
event twice.

The resolution: **this plugin is the only capture mechanism.** The legacy
`hooks.js --install` path is superseded — run `hooks.js --uninstall` to clear
it. The plugin then captures exactly once for both interactive and headless
sessions.

## CLAUDE.md

`CLAUDE.md` in this directory is the RivetOS identity + operating rules
distilled from the workspace templates (`CORE.md`, `WORKSPACE.md`) for
interactive sessions. Install it so every session inherits it:

```sh
cp "$(dirname "$0")/CLAUDE.md" ~/.claude/CLAUDE.md
```

Headless RivetOS agent sessions get this content via `--append-system-prompt`
and do not need the file.
