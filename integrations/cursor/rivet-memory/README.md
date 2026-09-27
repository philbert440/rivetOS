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
3. Removes legacy global wiring that points into this kit: `rivet-memory-hook.sh` entries in `~/.cursor/hooks.json`, the `rivetos` server in `~/.cursor/mcp.json`, and skill symlinks in `~/.cursor/skills/`. Earlier versions of this script wrote those.

The CLI does not read `~/.cursor/plugins/local/` (see Verified behaviour), so this step removes the only hooks and kit MCP server a CLI session has.

Without `--apply` it prints what it would do.

Uses a built RivetOS checkout (`services/mcp-sidecar`) or the shared pinned npm fallback. An explicitly selected unbuilt checkout fails instead of falling back. Configure den or DataHub/Postgres access in `~/.rivetos/.env`.

## Capture status

`bin/rivet-memory-hook.sh` spools each hook payload to `~/.rivetos/cursor-capture/spool/` and logs to `~/.rivetos/cursor-capture.log`. Nothing ingests the spool into memory yet. The spool directory is 0700 and new payload files are 0600; writes prune oldest payloads to retain at most 500 files and 50 MiB (an oversized payload may itself be removed). Writes take a 3 s lock deadline; if retention cannot be enforced (no `python3`), the new payload is discarded rather than growing the spool, and the failure is logged. `setup-cursor-rivet-memory.sh --apply` backs up `hooks.json` / `mcp.json` as `<name>.bak-<ts>` before rewriting them and only removes entries whose absolute command resolves to this kit's launchers; relative or bare commands are left alone. Diagnostics rotate at 1 MiB with one previous log retained. When a built `capture/dist/cursor-memory-capture.js` exists, the hook pipes each payload to it (never `npx` from a hook). Until that worker lands, Cursor's own turns are not searchable; memory written by the other harnesses is.

## Related

- Grok Build: `integrations/grok/rivet-memory/`
- Claude Code: `integrations/claude-code/rivet-memory/`
- Grok Bot: `integrations/grok-bot/rivet-memory/`
- RivetHub member kit: `integrations/grok-bot/rivethub-grokbot/`

## Verified behaviour

Checked 2026-09-27 against Cursor Agent CLI `2026.09.26-dd393fe` in headless sessions (`agent -p --plugin-dir <kit>`). The desktop app was not tested.

- **Plugin discovery.** The CLI loads a local plugin only through `--plugin-dir`. It does not scan `~/.cursor/plugins/local/`.
- **MCP.** `${CURSOR_PLUGIN_ROOT}` is substituted in `command` and `args`. The server process runs in the workspace directory and does not receive `CURSOR_PLUGIN_ROOT` in its environment, so a relative MCP command would not resolve. The server registers as `plugin-RivetOS Memory (Cursor)-rivetos` (from `displayName`); `echo` round-trips.
- **Hooks.** Plugin hooks run with the plugin root as the working directory and `CURSOR_PLUGIN_ROOT` exported, so `./bin/...` resolves. Each event fired once per occurrence. Headless runs fired only `sessionEnd` and `postToolUse`.
- **Duplicate hooks.** When the workspace is `$HOME`, the CLI loads `~/.cursor/hooks.json` as both user and project hooks, so every entry fires twice.
- **Agent.** `memory-researcher` registers only when the manifest omits `agents` and relies on default discovery; `"agents": ["./agents/"]` is ignored. The subagent receives the plugin's MCP tools. Its Claude-style `tools:` ids are not what Cursor registers and are not enforced.
- **Rules.** `rules/memory-reflex.md` did not reach the model's context under any manifest form tried (no key, string, array, `.mdc` with `alwaysApply: true`).
