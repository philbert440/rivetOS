# rivet-memory (Grok Bot)

RivetOS shared memory for Cursor Grok Bot agents, not the Grok Build CLI.
Sibling of integrations/grok/rivet-memory. That plugin stays as-is.

Query and write the same Postgres store. Ingest sessions tagged source=grokbot, agent=rivet-grokbot, and optional persona.
Convention: agent stays rivet-grokbot (ros_messages.agent / ros_conversations.agent key); persona varies per Grok Bot personality and lives in metadata only.
Full mesh mTLS join is out of scope.

## Install

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

## Related

- Grok Build sibling (do not break): ../grok/rivet-memory/
- Claude Code sibling: ../claude-code/rivet-memory/
- Kimi Code sibling: ../kimi/rivet-memory/ (same agent-stays-fixed convention)
- Sidecar: services/mcp-sidecar/
