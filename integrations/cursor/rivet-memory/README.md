# rivet-memory (Cursor)

RivetOS persistent memory peer for **Cursor IDE / CLI**: shared MCP recall (+ gated writes), lifecycle capture hooks, discipline skills, and always-on `AGENT.md` / `MEMORY.md`.

Sibling of Claude Code, Grok Build, Codex, and Grok Bot kits. Same Postgres store; source/channel tags default to `cursor`.

## What's in the box

| Layer | Path | Role |
| --- | --- | --- |
| MCP | `bin/rivet-memory-mcp.sh` + `.mcp.json` | stdio RivetOS sidecar (`memory_search` / `browse` / `stats` / `get_full`, wiki, gated writes) |
| Hooks | `hooks/hooks.json` + `bin/rivet-memory-hook.sh` | Cursor lifecycle events -> den capture (`rivet-cursor` / `cursor`), with a spool under `~/.rivetos/cursor-capture/spool/` |
| Skills | `skills/{memory-recall,memory-today,memory-yesterday,memory-stats}/` | Recall discipline |
| Agent | `agents/memory-researcher.md` | Read-only multi-step recall subagent |
| Reflex | `AGENT.md`, `MEMORY.md`, `rules/memory-reflex.md` | Memory-first gate + shelf map |

## Install

From a RivetOS checkout:

```bash
integrations/cursor/rivet-memory/bin/setup-cursor-rivet-memory.sh --apply
```

With `--apply` the script:

1. Writes one `rivet-memory-hook.sh <event>` entry per event in `hooks/hooks.json` to `~/.cursor/hooks.json`, using the kit's absolute path. Earlier kit entries are replaced; other hooks are kept.
2. Adds the `rivetos` server (absolute `bin/rivet-memory-mcp.sh`) to `~/.cursor/mcp.json`, unless a `rivetos` server that does not point into the kit already exists.
3. Symlinks each skill into `~/.cursor/skills/` and `memory-researcher.md` into `~/.cursor/agents/`. Existing links into the kit are replaced; anything else is left alone.
4. Copies `AGENT.md` -> `~/.cursor/AGENT.md` and `MEMORY.md` -> `~/.cursor/MEMORY.md`, backing up edited copies as `.bak-<timestamp>`.
5. Removes a `~/.cursor/plugins/local/` symlink into the kit. Where plugins are loaded, the plugin would register the same hooks and MCP server a second time.

An entry counts as the kit's only when its absolute command (or an absolute system shell plus the launcher as first argument) resolves to this kit's launchers or a previous checkout's; relative or bare commands, including a bare `bash`, are left alone. `hooks.json` / `mcp.json` are backed up as `<name>.bak-<ts>` before a rewrite, keep their file mode (new files are 0600), and are refused, not overwritten, when invalid. Rerunning is a no-op. Without `--apply` it prints what it would do.

The kit also works as a plugin without setup (`agent --plugin-dir integrations/cursor/rivet-memory`). Don't combine the two.

The CLI reads `~/.cursor/agents/` only when the workspace is `$HOME`; elsewhere, put `memory-researcher.md` in the project's `.cursor/agents/`.

Uses a built RivetOS checkout (`services/mcp-sidecar`) or the shared pinned npm fallback. An explicitly selected unbuilt checkout fails instead of falling back. Configure den or DataHub/Postgres access in `~/.rivetos/.env`.

## Capture status

`bin/rivet-memory-hook.sh` spools each hook payload to `~/.rivetos/cursor-capture/spool/` and logs to `~/.rivetos/cursor-capture.log`. The spool directory is 0700 and new payload files are 0600; writes prune oldest payloads to retain at most 500 files and 50 MiB (an oversized payload may itself be removed). Writes take a 3 s lock deadline; if retention cannot be enforced (no `python3`), the new payload is discarded rather than growing the spool, and the failure is logged. Diagnostics rotate at 1 MiB with one previous log retained.

When `capture/dist/cursor-memory-capture.js` is built, the hook pipes each payload to it (never `npx` from a hook). The worker posts to the local den as agent `rivet-cursor`, channel `cursor`, session key `cursor:<conversation_id>`.

When the payload names `transcript_path`, that agent jsonl is the source: one row per user text, assistant text, and tool call, stamped with `session_jsonl_path` and `session_jsonl_line` so a truncated row can be re-read. `postToolUse` supplies the tool result (the transcript has none). A Read result that is only a path and a length is replaced by the file slice that call asked for. Hook user, assistant, and tool bodies are not stored again. `stop` and `sessionEnd` flush a tool call that never received a result. Without a transcript path, the hook payload itself is stored (prompt, assistant text, tool use, subagent stop, session end). `user_email` is not stored. Content and tool results are capped at 16,000 characters. A byte offset in `~/.rivetos/cursor-transcript-state.json` keeps each hook from re-reading the file. Event ids are stable, so a replay skips rows already stored.

```bash
node integrations/cursor/rivet-memory/capture/dist/cursor-memory-capture.js --backfill
```

`--backfill` tails `~/.cursor/projects/*/agent-transcripts/*/*.jsonl` and joins spool `postToolUse` results onto those tool rows. It does not re-post hook user and assistant blobs. Retention has already dropped spool files past 500 or 50 MiB, so a result from a pruned payload cannot be joined. A missing build leaves the spool in place and logs `capture worker not built`. Cursor does not write reasoning into the transcript, so those parts are not captured.

## Related

- Grok Build: `integrations/grok/rivet-memory/`
- Claude Code: `integrations/claude-code/rivet-memory/`
- Grok Bot: `integrations/grok-bot/rivet-memory/`
- RivetHub member kit: `integrations/grok-bot/rivethub-grokbot/`

## Verified behaviour

Checked 2026-09-27 against Cursor Agent CLI `2026.09.26-dd393fe` in headless sessions, both as a plugin (`agent -p --plugin-dir <kit>`) and with the global wiring `setup-cursor-rivet-memory.sh --apply` writes. The desktop app was not tested.

- **Global wiring.** The `rivetos` server from `~/.cursor/mcp.json` loads and `echo` round-trips; the skills in `~/.cursor/skills/` are listed; hooks from `~/.cursor/hooks.json` fire once per event outside `$HOME`. `~/.cursor/agents/` is not read (symlink or plain file) unless the workspace is `$HOME`; the project's `.cursor/agents/` is.

- **Plugin discovery.** The CLI loads a local plugin only through `--plugin-dir`. It does not scan `~/.cursor/plugins/local/`.
- **MCP.** `${CURSOR_PLUGIN_ROOT}` is substituted in `command` and `args`. The server process runs in the workspace directory and does not receive `CURSOR_PLUGIN_ROOT` in its environment, so a relative MCP command would not resolve. The server registers as `plugin-RivetOS Memory (Cursor)-rivetos` (from `displayName`); `echo` round-trips.
- **Hooks.** Plugin hooks run with the plugin root as the working directory and `CURSOR_PLUGIN_ROOT` exported, so `./bin/...` resolves. Each event fired once per occurrence. Headless runs fired only `sessionEnd` and `postToolUse`.
- **Duplicate hooks.** When the workspace is `$HOME`, the CLI loads `~/.cursor/hooks.json` as both user and project hooks, so every entry fires twice. Payloads carry conversation, generation and tool-use ids, so both hook scripts drop an event whose name and payload match one seen in the last 10 minutes (markers under `~/.rivetos/cursor-hook-seen/`). Live, each event then spooled once.
- **Agent.** `memory-researcher` registers only when the manifest omits `agents` and relies on default discovery; `"agents": ["./agents/"]` is ignored. The subagent receives the plugin's MCP tools. Its Claude-style `tools:` ids are not what Cursor registers and are not enforced.
- **Rules.** `rules/memory-reflex.md` did not reach the model's context under any manifest form tried (no key, string, array, `.mdc` with `alwaysApply: true`).
