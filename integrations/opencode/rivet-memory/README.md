# rivet-memory (OpenCode CLI)

RivetOS shared memory + high-quality recall discipline for **OpenCode CLI**,
targeting the `rivet-glm` node.

This integration gives OpenCode sessions first-class access to the same persistent,
cross-agent memory store used by `rivet-claude`, `rivet-hermes`, `rivet-grok`,
`rivet-kimi`, and `rivet-gpt`, along with the battle-tested recall rules that
prevent agents from repeatedly failing at "remembering" things they should know.

**Memory capture is the priority-one feature.** Skills/commands/reflex matter,
but capture correctness beats everything else.

Capture is triggered by a native OpenCode plugin
(`~/.config/opencode/plugins/rivet-memory.ts`) on `session.idle` (debounced
1.5s), `session.compacted`, `session.deleted`, and `session.error`. The plugin
spawns `opencode-memory-capture.sh --ingest-session <id>`, which reads
`$XDG_DATA_HOME/opencode/opencode.db` (else `~/.local/share/opencode/opencode.db`)
read-only. Message events are ignored — SQLite rows are the source of truth.

## Goals

- Make `rivet-glm` a true peer to the other Rivet agents in the shared memory system.
- Deliver the strongest possible memory discipline so OpenCode reaches for the right tool on the first try.
- Provide automatic capture of user, assistant, reasoning, and tool turns from SQLite.
- Keep the integration lightweight and idiomatic to OpenCode's plugin + MCP + skills model.

## What It Ships

| Component                  | Location                                                                                 | Purpose                                                                |
| -------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Core discipline skill      | `skills/memory-recall/SKILL.md`                                                          | Optimal `memory_browse` first + multi-angle search + trigram fallback. |
| Quick commands             | `skills/memory-today/`, `memory-yesterday/`, `memory-stats/` + `commands/`               | High-frequency shortcuts.                                              |
| Memory researcher subagent | `agents/memory-researcher.md`                                                            | Delegate heavy or multi-step recall work.                              |
| Capture plugin             | `plugin/rivet-memory.ts` (copied to `~/.config/opencode/plugins/`)                       | Native event trigger.                                                  |
| Capture ingest             | `capture/` (`@rivetos/opencode-rivet-memory-capture`) + `bin/opencode-memory-capture.sh` | `--ingest-session` / `--backfill` under `agent = "rivet-glm"`.         |
| MCP launcher               | `bin/rivet-memory-mcp.sh`                                                                | Expose RivetOS memory tools to OpenCode.                               |
| Project reflex             | `OPENCODE.md`                                                                            | Always-on memory discipline rules.                                     |
| Plugin metadata            | `plugin.json`                                                                            | For future plugin install support.                                     |

## Identity

| field       | value                                          |
| ----------- | ---------------------------------------------- |
| agent       | `rivet-glm` (override `RIVETOS_CAPTURE_AGENT`) |
| channel     | `opencode`                                     |
| session_key | `opencode:<ses_id>`                            |
| native id   | `ses_<26 alnum>`                               |
| dedup       | `part.id` (`prt_…`)                            |

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

`--apply` copies `plugin/rivet-memory.ts` to
`~/.config/opencode/plugins/rivet-memory.ts` with `PLUGIN_PATH` rewritten,
merges the MCP block into `opencode.json`, and stops/disables/removes the
old `opencode-memory-capture.service` / launchd plist if present.

`--remove` deletes the copied plugin file.

### 3. Optional one-shot backfill

After installing the plugin, new turns ingest on `session.idle`. To catch
history already in `opencode.db`:

```bash
$RIVETOS_ROOT/integrations/opencode/rivet-memory/bin/opencode-memory-capture.sh --backfill --days 14
$RIVETOS_ROOT/integrations/opencode/rivet-memory/bin/opencode-memory-capture.sh --status
```

Logs: `~/.rivetos/logs/opencode-capture.log`.
Cursor: `~/.rivetos/opencode-capture-state.json`.

## Recall of truncated rows

Capture caps stored bodies at 16K and keeps `metadata.session_sqlite_path` +
`session_sqlite_part_id` pointing at the OpenCode db. `memory_get_full`
re-reads that part.

## Agent-facing recall

Setup registers `rivetos` in OpenCode `opencode.json` (`mcp.rivetos`) and
preserves other servers and settings. Existing registration is retained unless
`--force` is supplied. Start a new session after registering. The capture
plugin alone does not provide agent tools.

Recall tools: `memory_search`, `memory_browse`, `memory_get_full`, `memory_stats`,
`wiki_search`, and `wiki_read`. See `workspace-templates/MEMORY.md` for arguments
and selection guidance. The launcher loads database/embedding settings from
`~/.rivetos/.env`; without a database URL the server starts without recall tools.
