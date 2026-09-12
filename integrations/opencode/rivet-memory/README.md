# rivet-memory (OpenCode CLI)

RivetOS shared memory + high-quality recall discipline for **OpenCode CLI**,
targeting the `rivet-glm` node.

This integration gives OpenCode sessions first-class access to the same persistent,
cross-agent memory store used by `rivet-claude`, `rivet-hermes`, `rivet-grok`,
`rivet-kimi`, and `rivet-gpt`, along with the battle-tested recall rules that
prevent agents from repeatedly failing at "remembering" things they should know.

**Memory capture is the priority-one feature.** Skills/commands/reflex matter,
but capture correctness beats everything else.

OpenCode has **no Claude/kimi-style hooks** and no jsonl transcript. Capture is
a read-only watcher over `$XDG_DATA_HOME/opencode/opencode.db` (else
`~/.local/share/opencode/opencode.db`), WAL mode.

## Goals

- Make `rivet-glm` a true peer to the other Rivet agents in the shared memory system.
- Deliver the strongest possible memory discipline so OpenCode reaches for the right tool on the first try.
- Provide automatic capture of user, assistant, reasoning, and tool turns from SQLite.
- Keep the integration lightweight and idiomatic to OpenCode's MCP + skills model.

## What It Ships

| Component                    | Location                                              | Purpose |
|-----------------------------|-------------------------------------------------------|---------|
| Core discipline skill       | `skills/memory-recall/SKILL.md`                       | Optimal `memory_browse` first + multi-angle search + trigram fallback. |
| Quick commands              | `skills/memory-today/`, `memory-yesterday/`, `memory-stats/` + `commands/` | High-frequency shortcuts. |
| Memory researcher subagent  | `agents/memory-researcher.md`                         | Delegate heavy or multi-step recall work. |
| Capture system              | `capture/` (`@rivetos/opencode-rivet-memory-capture`) + `bin/opencode-memory-capture.sh` | Watcher ingest under `agent = "rivet-glm"`. |
| MCP launcher                | `bin/rivet-memory-mcp.sh`                             | Expose RivetOS memory tools to OpenCode. |
| Project reflex              | `OPENCODE.md`                                         | Always-on memory discipline rules. |
| Plugin metadata             | `plugin.json`                                         | For future plugin install support. |
| Unit templates              | `systemd/`                                            | systemd user unit + launchd plist sketches. |

## Identity

| field | value |
|-------|--------|
| agent | `rivet-glm` (override `RIVETOS_CAPTURE_AGENT`) |
| channel | `opencode` |
| session_key | `opencode:<ses_id>` |
| native id | `ses_<26 alnum>` |
| dedup | `part.id` (`prt_…`) |

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
- `$RIVETOS_ROOT/integrations/opencode/rivet-memory/capture/dist/opencode-memory-capture.js`

Root `package.json` `workspaces` must include
`integrations/opencode/rivet-memory/capture`. After adding it, run
`npm install --package-lock-only` so the lockfile links the new member.

### 2. One-command setup (recommended)

```bash
$RIVETOS_ROOT/integrations/opencode/rivet-memory/bin/setup-opencode-rivet-memory.sh --apply
```

Or `rivetos plugins install --harness opencode`.

### 3. Start capture on the OpenCode node

```bash
$RIVETOS_ROOT/integrations/opencode/rivet-memory/bin/opencode-memory-capture.sh --watch --backfill 14
```

Logs: `~/.rivetos/opencode-memory-capture.log`.
Cursor: `~/.rivetos/opencode-capture-state.json`.

## Recall of truncated rows

Capture caps stored bodies at 16K and keeps `metadata.session_sqlite_path` +
`session_sqlite_part_id` pointing at the OpenCode db. `memory_get_full`
re-reads that part.

## Agent-facing recall

Setup registers `rivetos` in OpenCode `opencode.json` (`mcp.rivetos`) and
preserves other servers and settings. Existing registration is retained unless
`--force` is supplied. Start a new session after registering. The capture
watcher alone does not provide agent tools.

Recall tools: `memory_search`, `memory_browse`, `memory_get_full`, `memory_stats`,
`wiki_search`, and `wiki_read`. See `workspace-templates/MEMORY.md` for arguments
and selection guidance. The launcher loads database/embedding settings from
`~/.rivetos/.env`; without a database URL the server starts without recall tools.
