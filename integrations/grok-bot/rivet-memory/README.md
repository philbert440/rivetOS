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

**Setup:**

1. Set `GROKBOT_TRANSCRIPT_ROOT` to the directory containing per-model transcript folders (e.g. `/home/box/grokbot/transcripts`)
2. Set `RIVETOS_PG_URL` in `~/.rivetos/.env` or environment
3. Ensure RivetOS is built at `RIVETOS_ROOT` (default `/opt/rivetos`)

**Run:**

```bash
cd capture/
./run-once.sh
```

The runner converts each model's transcript from `$GROKBOT_TRANSCRIPT_ROOT/<id>/<id>.jsonl` to `spool/<session>.jsonl`, then ingests to Postgres when reachable. Fails closed if PG or packages are missing (conversion succeeds, ingest skipped).

**Schedule:** Typically via cron/systemd hourly. Desk hourly hop remains the backstop.

**Deferred:** Den app/event integration is out of scope. Tailscale/PG reachability from the grokbot node is an ops follow-up.

## Related

- Grok Build sibling (do not break): ../grok/rivet-memory/
- Claude Code sibling: ../claude-code/rivet-memory/
- Kimi Code sibling: ../kimi/rivet-memory/
- Sidecar: services/mcp-sidecar/
