# rivet-memory (Cursor)

RivetOS persistent memory peer for **Cursor IDE / CLI**: shared MCP recall (+ gated writes), lifecycle capture hooks, discipline skills, and always-on `AGENT.md` / `MEMORY.md`.

Sibling of Claude Code, Grok Build, Codex, and Grok Bot kits. Same Postgres store; source/channel tags default to `cursor`.

## What's in the box

| Layer | Path | Role |
| --- | --- | --- |
| MCP | `bin/rivet-memory-mcp.sh` + `.mcp.json` | stdio RivetOS sidecar (`memory_search` / `browse` / `stats` / `get_full`, wiki, gated writes) |
| Hooks | `hooks/hooks.json` + `bin/rivet-memory-hook.sh` | Cursor lifecycle events -> spool under `~/.rivetos/cursor-capture/spool/` (no ingest worker yet) |
| Skills | `skills/{memory-recall,memory-today,memory-yesterday,memory-stats}/` | Recall discipline |
| Agent | `agents/memory-researcher.md` | Read-only multi-step recall subagent |
| Reflex | `AGENT.md`, `MEMORY.md`, `rules/memory-reflex.md` | Memory-first gate + shelf map |

## Install

From a RivetOS checkout:

```bash
integrations/cursor/rivet-memory/bin/setup-cursor-rivet-memory.sh --apply
```

With `--apply` the script:

1. Symlinks the kit to `~/.cursor/plugins/local/rivet-memory-cursor`. The plugin manifest wires the MCP server (`${CURSOR_PLUGIN_ROOT}/bin/rivet-memory-mcp.sh`), hooks, skills, rules, and agent.
2. Copies `AGENT.md` -> `~/.cursor/AGENT.md` and `MEMORY.md` -> `~/.cursor/MEMORY.md`.
3. Removes legacy global wiring that points into this kit: `rivet-memory-hook.sh` entries in `~/.cursor/hooks.json`, the `rivetos` server in `~/.cursor/mcp.json`, and skill symlinks in `~/.cursor/skills/`. Earlier versions of this script wrote those, and together with the plugin they made every hook fire twice.

Without `--apply` it prints what it would do.

Requires a built RivetOS checkout (`services/mcp-sidecar`) and `~/.rivetos/.env` with `RIVETOS_PG_URL`.

## Capture status

`bin/rivet-memory-hook.sh` spools each hook payload to `~/.rivetos/cursor-capture/spool/` and logs to `~/.rivetos/cursor-capture.log`. Nothing ingests the spool into memory yet. When `capture/dist/cursor-memory-capture.js` (or `capture/src/cursor-memory-capture.ts`) exists, the hook pipes each payload to it.

## Related

- Grok Build: `integrations/grok/rivet-memory/`
- Claude Code: `integrations/claude-code/rivet-memory/`
- Grok Bot: `integrations/grok-bot/rivet-memory/`
- RivetHub member kit: `integrations/grok-bot/rivethub-grokbot/`
