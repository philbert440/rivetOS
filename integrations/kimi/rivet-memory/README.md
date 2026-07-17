# rivet-memory (Kimi Code CLI)

RivetOS shared memory + high-quality recall discipline for **Kimi Code CLI**
(MoonshotAI/kimi-code — the TypeScript successor to kimi-cli), targeting the
`kimi-k3` model on the `rivet-kimi` node.

This integration gives Kimi sessions first-class access to the same persistent,
cross-agent memory store used by `rivet-claude`, `rivet-hermes`, and `rivet-grok`,
along with the battle-tested recall rules that prevent agents from repeatedly
failing at "remembering" things they should know.

**Memory capture is the priority-one feature.** Skills/commands/reflex matter,
but capture correctness beats everything else.

## Goals

- Make `rivet-kimi` a true peer to the other Rivet agents in the shared memory system.
- Deliver the strongest possible memory discipline so Kimi reaches for the right tool on the first try.
- Provide automatic capture of turns, tool calls, and pre-compaction context (when hooks are enabled).
- Keep the integration lightweight and idiomatic to kimi-code's MCP + skills + TOML hooks model.

## Current Status

| Component                | Status     | Notes |
|--------------------------|------------|-------|
| Memory discipline skill  | ✅ Excellent | Ported from grok/hermes lineage |
| Helper skills            | ✅ Good    | memory-today, memory-yesterday, memory-stats |
| Subagent                 | ✅ Good    | memory-researcher |
| MCP tools                | ✅ Good    | Via existing RivetOS MCP server |
| Capture                  | ✅ Solid   | Hook-payload first + content-hash dedup; session-file path ready for empirical wire-up |
| Packaging & Install      | ✅ Good    | One-command setup script |
| Reflex / Always-on rules | ✅ Good    | `KIMI.md` (+ optional `AGENTS.md`) |

## What It Ships

| Component                    | Location                                              | Purpose |
|-----------------------------|-------------------------------------------------------|---------|
| Core discipline skill       | `skills/memory-recall/SKILL.md`                       | Optimal `memory_browse` first + multi-angle search + trigram fallback. |
| Quick commands              | `skills/memory-today/`, `memory-yesterday/`, `memory-stats/` + `commands/` | High-frequency shortcuts. |
| Memory researcher subagent  | `agents/memory-researcher.md`                         | Delegate heavy or multi-step recall work. |
| Capture system              | `capture/` (workspace `@rivetos/kimi-rivet-memory-capture`) + `bin/kimi-memory-hook.sh` | Non-blocking capture under `agent = "rivet-kimi"`. |
| MCP launcher                | `bin/rivet-memory-mcp.sh`                             | Expose RivetOS memory tools to kimi-code. |
| Project reflex              | `KIMI.md`                                             | Always-on memory discipline rules. |
| Hook examples               | `hooks/hooks.toml`                                    | TOML `[[hooks]]` fragment for config.toml. |
| Plugin metadata             | `plugin.json`                                         | For future plugin install support. |

## Installation

> Throughout, `$RIVETOS_ROOT` is your RivetOS checkout. Default: `/opt/rivetos`.
> All scripts in `bin/` honor `RIVETOS_ROOT` if it's set in the environment
> (or sourced from `~/.rivetos/.env`).

### 1. Build RivetOS (required for both the MCP server and the capture worker)

```bash
cd $RIVETOS_ROOT
npm install
npm run build
```

This produces:
- `$RIVETOS_ROOT/services/mcp-sidecar/dist/cli.js` (memory MCP server)
- `$RIVETOS_ROOT/integrations/kimi/rivet-memory/capture/dist/kimi-memory-capture.js` (capture worker)

> **Workspace note:** add `integrations/kimi/rivet-memory/capture` to the root
> `package.json` `workspaces` array (mirrors the grok capture entry) so
> `npm install` picks up `@rivetos/kimi-rivet-memory-capture`.

### 2. One-command setup (recommended)

```bash
$RIVETOS_ROOT/integrations/kimi/rivet-memory/bin/setup-kimi-rivet-memory.sh
```

The script prints exact config snippets for MCP, skills, hooks, and `KIMI.md`,
and can optionally write them when run with `--apply` (see script help).

### 3. Configure the RivetOS MCP Server

kimi-code loads MCP servers from `mcp.json` in its config directory
(Claude-style JSON). Use the launcher for consistency:

```json
{
  "mcpServers": {
    "rivetos": {
      "command": "/opt/rivetos/integrations/kimi/rivet-memory/bin/rivet-memory-mcp.sh"
    }
  }
}
```

Place this at `$KIMI_CODE_HOME/mcp.json` (or `~/.kimi-code/mcp.json` /
`~/.kimi/mcp.json` depending on which home the installed CLI uses).

### 4. Install the Skills

Skills live under skill dirs. kimi-code supports `extra_skill_dirs` in
`config.toml` — point one entry at this plugin's skills, or copy them:

```bash
# Via extra_skill_dirs (recommended — stays in sync with the repo)
# config.toml:
#   extra_skill_dirs = ["/opt/rivetos/integrations/kimi/rivet-memory/skills"]

# Or copy into the default skills path (verify default path on install):
cp -r integrations/kimi/rivet-memory/skills/* ~/.kimi-code/skills/
```

### 5. Install the Reflex

Copy `KIMI.md` into always-on rules. If kimi-code reads `AGENTS.md`:

```bash
cp integrations/kimi/rivet-memory/KIMI.md ~/.kimi-code/AGENTS.md
```

### 6. Enable Automatic Capture

See **Capture** below.

## Capture (Automatic History Writing)

The capture system writes the Kimi session — user prompts, assistant responses
(when available), tool name + result, and lifecycle markers — into the shared
memory store under `agent = "rivet-kimi"`.

It is designed to be:
- Extremely fast on the hot path (spool + detached worker)
- Best-effort (never blocks the CLI)
- **Idempotent** via content-hash `event_id` — firing the same payload twice yields
  `inserted=1 skipped=0` then `inserted=0 skipped=1`
- Best-effort logging to `~/.rivetos/kimi-memory-capture.log`

### Capture strategy

**Hook-payload first** (preferred): each lifecycle hook delivers JSON on stdin.
Common fields (docs claim snake_case — verify live; the worker accepts both
snake_case and camelCase):

| Field | Purpose |
|-------|---------|
| `session_id` / `sessionId` | Session correlation |
| `cwd` | Working directory |
| `hook_event_name` / `hookEventName` | Event name |
| `prompt` | UserPromptSubmit text |
| `tool_name` / `toolName` | Tool identity |
| `tool_input` / `toolInput` | Tool arguments |
| `tool_output` / `toolOutput` | Tool result |
| `reason` / `source` / `trigger` | Lifecycle context |

If live hook payloads omit assistant text (likely — Grok's did), find where
kimi-code writes session transcripts on disk and wire the optional session-file
path in `capture/src/kimi-memory-capture.ts` (`SESSIONS_ROOT` / `findSessionDir`
constants at the top of the file). Document findings here after verification.

### Enabling Capture

kimi-code hooks are configured as TOML `[[hooks]]` entries in `config.toml`:

```toml
[[hooks]]
event = "SessionStart"
command = "/opt/rivetos/integrations/kimi/rivet-memory/bin/kimi-memory-hook.sh SessionStart"
timeout = 8

[[hooks]]
event = "SessionEnd"
command = "/opt/rivetos/integrations/kimi/rivet-memory/bin/kimi-memory-hook.sh SessionEnd"
timeout = 8

[[hooks]]
event = "UserPromptSubmit"
command = "/opt/rivetos/integrations/kimi/rivet-memory/bin/kimi-memory-hook.sh UserPromptSubmit"
timeout = 8

[[hooks]]
event = "PostToolUse"
command = "/opt/rivetos/integrations/kimi/rivet-memory/bin/kimi-memory-hook.sh PostToolUse"
timeout = 8

[[hooks]]
event = "PostToolUseFailure"
command = "/opt/rivetos/integrations/kimi/rivet-memory/bin/kimi-memory-hook.sh PostToolUseFailure"
timeout = 8

[[hooks]]
event = "Stop"
command = "/opt/rivetos/integrations/kimi/rivet-memory/bin/kimi-memory-hook.sh Stop"
timeout = 8

[[hooks]]
event = "PreCompact"
command = "/opt/rivetos/integrations/kimi/rivet-memory/bin/kimi-memory-hook.sh PreCompact"
timeout = 8
```

A ready-to-append fragment lives in `hooks/hooks.toml`. Timeout is 8s; the
launcher always exits 0 and never blocks the agent.

Pre-compaction capture (`PreCompact`) is the highest-value trigger.

## Architecture

- **Tools** — Exposed via MCP (Claude-style `mcp.json`)
- **Capture** — Hooks spool full stdin payloads; the worker extracts messages and
  inserts with content-hash `event_id` dedup. Optional session-file ingest can be
  enabled once the on-disk transcript layout is verified.
- **Discipline** — Same strongest memory-recall rules as the grok integration,
  adjusted for kimi-code tool-invocation conventions

## Comparison with Siblings

| Feature                    | Claude Code Plugin      | Hermes Plugin           | Grok Build Plugin          | Kimi Code Plugin           |
|---------------------------|-------------------------|-------------------------|----------------------------|----------------------------|
| Tool exposure             | MCP                     | Native in-process       | MCP (Grok-native)          | MCP (`mcp.json`)           |
| Capture                   | Transcript-based        | Excellent               | JSONL ingest (`updates.jsonl`) | Hook-payload + content-hash |
| Discipline                | Strong                  | Strongest               | Strongest (shared)         | Strongest (shared)         |
| Always-on reflex          | `CLAUDE.md`             | System prompt injection | `GROK.md` / `AGENTS.md`    | `KIMI.md` / `AGENTS.md`    |
| Hooks                     | JSON                    | —                       | JSON in `~/.grok/hooks/`   | TOML `[[hooks]]` in config |

## Installation on a Specific Host

1. Ensure the RivetOS repo is checked out and built on that host.
2. Run:
   ```bash
   $RIVETOS_ROOT/integrations/kimi/rivet-memory/bin/setup-kimi-rivet-memory.sh
   ```
3. Follow the printed instructions for MCP, skills, `KIMI.md`, and capture hooks.
4. Optional PATH links:
   ```bash
   $RIVETOS_ROOT/integrations/kimi/rivet-memory/bin/setup-kimi-rivet-memory.sh --link
   ```

## Related

- Grok sibling: `../grok/rivet-memory/`
- Claude Code sibling: `../claude-code/rivet-memory/` (if present)
- Hermes sibling: `../hermes/rivet-memory/` (if present)
- Core memory design: `/docs/MEMORY-DESIGN.md`

---

Pull requests that improve capture robustness, document live hook payload shapes,
or wire session-file tailing after empirical discovery are very welcome.
