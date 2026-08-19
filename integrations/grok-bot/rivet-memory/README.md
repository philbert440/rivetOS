# rivet-memory (Grok Bot)

RivetOS shared memory for Cursor Grok Bot agents, not the Grok Build CLI.
Sibling of integrations/grok/rivet-memory. That plugin stays as-is.

Query and write the same Postgres store. Ingest sessions tagged source=grokbot plus agent and persona.
Full mesh mTLS join is out of scope.

## Query

Point Cursor at bin/rivet-memory-mcp.sh (loads ~/.rivetos/.env, then starts the sidecar).
See .mcp.json for examples. Tools: memory_search, memory_browse, memory_stats, memory_get_full.

When installed as a Grok Bot plugin, use `${CURSOR_PLUGIN_ROOT}/bin/rivet-memory-mcp.sh`.
When pointing directly at the script, use the absolute path: `/opt/rivetos/integrations/grok-bot/rivet-memory/bin/rivet-memory-mcp.sh`.

## Write

The launcher sets RIVETOS_MCP_ENABLE_MEMORY_WRITE=1 and grokbot tag env vars.
Use memory_append or memory_ingest_session. Pass agent and persona on each call.
Ingest skips ordinals already stored for that session.

Offline: node bin/ingest-session.mjs --session-id ID --agent NAME [--persona P] file.jsonl
That calls the same ingestSession() as the sidecar (requires a built checkout).

## Related

- Grok Build sibling (do not break): ../grok/rivet-memory/
- Claude Code sibling: ../claude-code/rivet-memory/
- Sidecar: services/mcp-sidecar/
