# rivet-memory (pi CLI)

RivetOS shared memory + high-quality recall discipline for the **pi CLI**
(`@earendil-works/pi-coding-agent`), targeting the `rivet-deepseek` node.

This integration gives pi sessions first-class access to the same persistent,
cross-agent memory store used by `rivet-claude`, `rivet-hermes`, `rivet-grok`,
`rivet-kimi`, and `rivet-gpt`, along with the battle-tested recall rules that
prevent agents from repeatedly failing at "remembering" things they should know.

**Memory capture is the priority-one feature.** Skills/commands/reflex matter,
but capture correctness beats everything else.

Pi has **no Claude/kimi-style hooks**. Capture is a file watcher over
`~/.pi/agent/sessions/<encoded-cwd>/<ISO-ts>_<uuid-v7>.jsonl` (encoded cwd:
`/home/rivet` → `--home-rivet--`). A custom `--session-dir` is flat.

On-disk lines are v3 session jsonl (`session`, `model_change`,
`thinking_level_change`, `message`). Print-mode stdout is a *runtime event*
stream (`message_start` / `message_update` / …) and is **not** the capture
source.

## Goals

- Make `rivet-deepseek` a true peer to the other Rivet agents in the shared memory system.
- Deliver the strongest possible memory discipline so pi reaches for the right tool on the first try.
- Provide automatic capture of user, assistant, thinking, and tool turns from v3 session jsonl.
- Keep the integration lightweight and idiomatic to pi's file-tree sessions.

## What It Ships

| Component                    | Location                                              | Purpose |
|-----------------------------|-------------------------------------------------------|---------|
| Core discipline skill       | `skills/memory-recall/SKILL.md`                       | Optimal `memory_browse` first + multi-angle search + trigram fallback. |
| Quick commands              | `skills/memory-today/`, `memory-yesterday/`, `memory-stats/` + `commands/` | High-frequency shortcuts. |
| Memory researcher subagent  | `agents/memory-researcher.md`                         | Delegate heavy or multi-step recall work. |
| Capture system              | `capture/` (`@rivetos/pi-rivet-memory-capture`) + `bin/pi-memory-capture.sh` | Watcher ingest under `agent = "rivet-deepseek"`. |
| MCP launcher                | `bin/rivet-memory-mcp.sh`                             | Expose RivetOS memory tools to pi. |
| Project reflex              | `PI.md`                                               | Always-on memory discipline rules. |
| Plugin metadata             | `plugin.json`                                         | For future plugin install support. |
| systemd template            | `systemd/pi-memory-capture.service`                   | Sketch; `rivetos plugins install` writes the live user unit. |

## Identity

| field | value |
|-------|--------|
| agent | `rivet-deepseek` (override `RIVETOS_CAPTURE_AGENT`) |
| channel | `pi` |
| session_key | `pi:<uuid>` |
| native id | UUID from the `session` line / filename (pi mints v7) |
| title | session `-n` name if present, else first user text |

## Installation

> Throughout, `$RIVETOS_ROOT` is your RivetOS checkout. Default: `/opt/rivetos`.

### 1. Build RivetOS

```bash
cd $RIVETOS_ROOT
npm install
npm run build
```

This produces:
- `$RIVETOS_ROOT/services/mcp-sidecar/dist/cli.js`
- `$RIVETOS_ROOT/integrations/pi/rivet-memory/capture/dist/pi-memory-capture.js`

Root `package.json` `workspaces` must include
`integrations/pi/rivet-memory/capture`. After adding it, the integrator runs
`npm install --package-lock-only`.

### 2. One-command setup (recommended)

```bash
$RIVETOS_ROOT/integrations/pi/rivet-memory/bin/setup-pi-rivet-memory.sh --apply
# or: rivetos plugins install --harness pi
```

`plugins install` also writes and enables the systemd user unit
`pi-memory-capture.service` (Linux) or launchd label `dev.rivetos.pi-capture`
(macOS).

### 3. Start capture on the pi node

```bash
$RIVETOS_ROOT/integrations/pi/rivet-memory/bin/pi-memory-capture.sh --watch
```

Logs: `~/.rivetos/pi-memory-capture.log`.
Doctor marker: `~/.rivetos/pi-capture-state.json`.

## Recall of truncated rows

Capture caps stored bodies at 16K and keeps `metadata.session_jsonl_path` +
`session_jsonl_line` pointing at the session file. `memory_get_full` re-reads
that line (pi v3 `message` shape). Thinking is stored in `metadata.reasoning`.

## Agent-facing recall

Setup writes `rivetos` into `~/.pi/agent/mcp.json`. Start a new session after
registering. The capture watcher alone does not provide agent tools.

Recall tools: `memory_search`, `memory_browse`, `memory_get_full`, `memory_stats`,
`wiki_search`, and `wiki_read`. See `workspace-templates/MEMORY.md` for arguments
and selection guidance. The launcher loads database/embedding settings from
`~/.rivetos/.env`; without a database URL the server starts without recall tools.
