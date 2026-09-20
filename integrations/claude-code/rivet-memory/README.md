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

Then ask the agent to run the **`rivetos-onboard`** skill. One fork:

- **Cloud** — paste credentials from the Rivet Cloud dashboard (v1 is memory
  only; no browser OAuth yet).
- **Local** — Tailscale + one DataHub URL (`postgres://` maps to the memory
  store; `https://` is stored as-is).

Prove with **`rivetos-status`**, then `memory_stats`. Secrets are never echoed.

The no-checkout MCP path is `npx -y @rivetos/mcp-sidecar@0.5.0 --stdio`. That
package is not on npm yet; the path works once 0.5.0 is published. Until then,
a built RivetOS tree (`RIVETOS_ROOT` or `/opt/rivetos`) still launches as
before.

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
| Onboard / status | `skills/rivetos-onboard`, `skills/rivetos-status` | Agent-driven fork (cloud vs local), persist, prove. Status prints mode and `scheme host:port` only. |
| Recall skill | `skills/memory-recall/SKILL.md` | Auto-loads on time-bounded recall prompts ("what did we do this morning", "check memory from yesterday"). Encodes the browse-with-date-range-FIRST discipline so memory is the first reflex, not the recovery move. |
| Slash commands | `commands/memory-*.md` | `/memory-recall <query>`, `/memory-today [topic]`, `/memory-yesterday [topic]`, `/memory-stats` — user-invoked shortcuts to the same discipline. |
| Subagent | `agents/memory-researcher.md` | Read-only memory specialist the main agent can delegate to via the Agent tool. Runs the full multi-angle / browse-first discipline and returns synthesized findings under 200 words, without burning main-context tokens on a search loop. |

The `PostToolUse` row — tool name + full args + full result, one row per call —
is the "which command fixed it 2.5 days ago" record.

## Safe defaults

This kit ships with **shell, file, and search write tools off**. Memory write
tools (`memory_append`, `memory_ingest_session`) stay **off** until the user
opts in during `rivetos-onboard`. Recall tools are available as soon as a
DataHub / PG URL is configured.

## What's new in 0.3

`0.2` added the discipline layer. `0.3` makes the kit installable by a
stranger with no RivetOS checkout:

- MCP launcher: built checkout if present, otherwise `npx @rivetos/mcp-sidecar`.
- Capture hook: uses the checkout handler when available; otherwise logs
  one secret-free line to stderr, skips capture, and exits 0.
- `userConfig` for mode, DataHub, embed, cloud URL, cloud token.
- `rivetos-onboard` / `rivetos-status` skills.

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
`@rivetos/mcp-sidecar@0.5.0` release once published. The onboard/status
helpers use Python 3 for endpoint checks. Plugin settings or
`~/.rivetos/.env` supply the DataHub. Capture logs and skips; it requires
a built checkout handler.

## Configuration

Read order: plugin `userConfig` first → `~/.rivetos/.env` fallback. Empty or
unsubstituted `${…}` / `${user_config.…}` placeholders do not shadow the env
file. Persist never clobbers `RIVETOS_MODE=workspace|production`.

| Var | Default | Purpose |
|---|---|---|
| `RIVETOS_MODE` | unset | `cloud` or `local` |
| `RIVETOS_DATAHUB_URL` | unset | Local DataHub. `postgres://` / `postgresql://` maps to `RIVETOS_PG_URL`; HTTPS is stored, not converted |
| `RIVETOS_EMBED_URL` | unset | Optional embedding endpoint |
| `RIVETOS_CLOUD_URL` | `https://rivetos.cloud` when mode is cloud | Cloud API base |
| `RIVETOS_CLOUD_TOKEN` | unset | Secret (set/unset in status; never printed) |
| `RIVETOS_ROOT` | `/opt/rivetos` | RivetOS install root when a checkout exists |
| `RIVETOS_ENV_FILE` | `~/.rivetos/.env` | Env file parsed (never sourced) by the MCP launcher |

Without `RIVETOS_PG_URL` the MCP server still starts, but with `echo` + web
tools only — the memory tools are disabled.

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
