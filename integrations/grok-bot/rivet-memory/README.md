# rivet-memory (Grok Bot)

RivetOS shared memory for Cursor Grok Bot agents, not the Grok Build CLI.
Sibling of integrations/grok/rivet-memory. That plugin stays as-is.

Query and write the same Postgres store. Ingest sessions tagged source=grokbot with per-bot agent keys.

## Node and Models

The grokbot node runs multiple Grok Bot agents, each with its own agent key and session ID:

- **Rivet** (`rivet-grokbot`): Main bot, session `grokbot-rivet-grokbot`
- **Bob** (`rivet-bob`): session `grokbot-bob`
- **Gary** (`rivet-gary`): session `grokbot-gary`
- **Maggie** (`rivet-maggie`): session `grokbot-maggie`
- **Frank** (`rivet-frank`): session `grokbot-frank`
- **dr eggbot** (`rivet-eggbot`): session `grokbot-eggbot`

Convention: each bot gets its own agent key. See `capture/models.json` for full model IDs and mappings.
Full mesh mTLS join is out of scope.

## Install

**Version:** 0.2.0 (added capture/ for grokbot node automated transcript ingestion)

Preferred: as a Grok Bot plugin. Add the marketplace `philbert440/rivetOS` in Grok Bot
(it reads `.cursor-plugin/marketplace.json`) and install `rivet-memory-grokbot`. The plugin
carries the MCP server (`.mcp.json` via `${CURSOR_PLUGIN_ROOT}`), the memory-recall skill,
and the reflex rule (`rules/memory-reflex.md`) in one shot. The host still needs a built
RivetOS checkout (default `/opt/rivetos`, override `RIVETOS_ROOT`) and `~/.rivetos/.env`
with `RIVETOS_PG_URL` for the user Grok Bot runs as.

Manual alternative: drop a `.cursor/mcp.json` in the project folder you open in Grok Bot:

```json
{ "mcpServers": { "rivetos": { "command": "/opt/rivetos/integrations/grok-bot/rivet-memory/bin/rivet-memory-mcp.sh" } } }
```

## Query

Point Cursor at bin/rivet-memory-mcp.sh (loads ~/.rivetos/.env, then starts the sidecar).
See .mcp.json for examples. Tools: memory_search, memory_browse, memory_stats, memory_get_full.

When installed as a Grok Bot plugin, use `${CURSOR_PLUGIN_ROOT}/bin/rivet-memory-mcp.sh`.
When pointing directly at the script, use the absolute path: `/opt/rivetos/integrations/grok-bot/rivet-memory/bin/rivet-memory-mcp.sh`.

## Write

The launcher sets RIVETOS_MCP_ENABLE_MEMORY_WRITE=1 and default tag env vars (agent=rivet-grokbot, source/channel=grokbot).
Use memory_append or memory_ingest_session. Pass role (user, assistant, system, or tool) on each memory_append call, and persona when relevant; agent defaults to rivet-grokbot and should not be overridden.
Ingest skips ordinals already stored for that session.

Offline: node bin/ingest-session.mjs --session-id ID --agent rivet-grokbot [--persona P] file.jsonl
That calls the same ingestSession() as the sidecar (requires a built checkout).

## Capture (Automated Ingestion)

The `capture/` directory provides automated transcript conversion and ingestion for the grokbot node.

**Door 1: Transcript watcher** — monitors per-model transcript files and ingests to phil_memory.

**Setup:**

1. Set `GROKBOT_TRANSCRIPT_ROOT` to the directory containing per-model transcript folders (e.g. `/home/box/grokbot/transcripts`)
2. Set `RIVETOS_PG_URL` in `~/.rivetos/.env` or environment
3. Ensure RivetOS is built at `RIVETOS_ROOT` (default `/opt/rivetos`)
4. Run the setup script (see Setup/Restore section below)

**Run watcher (scheduled):**

```bash
cd capture/
./run-once.sh
```

The runner converts each model's transcript from `$GROKBOT_TRANSCRIPT_ROOT/<id>/<id>.jsonl` to `spool/<session>.jsonl`, then ingests to Postgres when reachable. Fails loud when session files exist but ingest fails. State tracking in `~/.rivetos/grokbot-capture-state/` detects stuck sessions (3+ consecutive failures within 2 hours).

**Schedule:** Typically via cron/systemd hourly. Reports stuck sessions and failures via exit code.

**Monitoring:** Check exit code and logs. Non-zero exit means ingest failures occurred. Stuck sessions are reported to stderr.

## Setup / Restore

Use `bin/setup-grokbot-node.sh` for both initial setup and recovery after a wipe. The script is idempotent and safe to re-run. It:

1. Verifies share mount (fails loud if missing)
2. Restores sealed home bits if missing (env, capture scripts, hooks)
3. Ensures plugin is present from snapshot or checkout
4. Brings up the transcript watcher (door 1)
5. Proves both doors with known sessions
6. Writes a fresh share snapshot

See `bin/setup-grokbot-node.sh --help` for usage.

## Related

- Grok Build sibling (do not break): ../grok/rivet-memory/
- Claude Code sibling: ../claude-code/rivet-memory/
- Kimi Code sibling: ../kimi/rivet-memory/
- Sidecar: services/mcp-sidecar/
