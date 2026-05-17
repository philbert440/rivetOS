# rivet-memory

A Claude Code plugin that gives interactive `claude` sessions the full RivetOS
memory loop: **recall** (an MCP server) and **capture** (lifecycle hooks).

Interactive sessions a human runs by hand never had it. This plugin closes that
gap with one install — and, because headless `claude -p` sessions load enabled
user plugins too, it doubles as the **single capture source for every session
type**, headless RivetOS agents included.

## What it ships

| Component | File | Effect |
|---|---|---|
| MCP server | `.mcp.json` → `bin/rivet-memory-mcp.sh` | Adds `memory_search`, `memory_browse`, `memory_stats`, `skill_*`, `internet_search`, `web_fetch`. Recall past decisions and commands without asking. |
| Capture hooks | `hooks/hooks.json` → `bin/rivet-memory-hook.sh` | `UserPromptSubmit` + `PostToolUse` capture every prompt and tool call (name, args, result) straight from the hook payload. `Stop`/`SubagentStop`/`SessionEnd` capture assistant text from the transcript. |

The `PostToolUse` row — tool name + full args + full result, one row per call —
is the "which command fixed it 2.5 days ago" record.

## Install

```sh
claude plugin marketplace add /opt/rivetos
claude plugin install rivet-memory@rivetos
```

Or from the GitHub repo once pushed:

```sh
claude plugin marketplace add philbert440/rivetOS
claude plugin install rivet-memory@rivetos
```

## Requirements

The plugin runs the **built** RivetOS artifacts in place — it does not bundle
them. It needs a RivetOS checkout with `dist/` built:

- `plugins/transports/mcp-server/dist/cli.js` — the MCP server
- `plugins/providers/claude-cli/dist/hooks.js` — the capture handler

Run `npm run build` in the RivetOS repo if either is missing.

## Configuration

Both launchers resolve two things, each overridable by env var:

| Var | Default | Purpose |
|---|---|---|
| `RIVETOS_ROOT` | `/opt/rivetos` | RivetOS install root (where `dist/` lives) |
| `RIVETOS_ENV_FILE` | `~/.rivetos/.env` | Env file sourced for `RIVETOS_PG_URL` / `RIVETOS_EMBED_URL` |

Without `RIVETOS_PG_URL` the MCP server still starts, but with `echo` + web
tools only — the memory tools are disabled. Capture writes are no-ops.

## Capture is best-effort

`rivet-memory-hook.sh` always exits 0. A capture failure — DB down, dist
missing — can never disrupt the Claude Code session. The handler only spools
the payload and detaches a worker, so the hook returns in milliseconds. All
capture activity is logged to `~/.rivetos/claude-capture.log`.

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
