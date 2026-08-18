# rivet-memory (Grok Bot)

RivetOS shared memory for Cursor Grok Bot agents, not the Grok Build CLI.
Sibling of integrations/grok/rivet-memory. That plugin stays as-is.
Query and write the same Postgres store. Ingest sessions tagged source=grokbot plus agent and persona.
Full mesh mTLS join is out of scope.

## Query

Point Cursor MCP at the sidecar with env RIVETOS_MEMORY_SOURCE=grokbot and RIVETOS_MEMORY_CHANNEL=grokbot.
See .mcp.json in this directory. Tools: memory_search, memory_browse, memory_stats, memory_get_full.

## Write

memory_append and memory_ingest_session. Pass agent and persona on each call. Leave source unset so it stays grokbot.
Offline ingest: node bin/ingest-session.mjs --session-id ID --agent NAME file.jsonl

## Related

- Grok Build sibling (do not break): ../grok/rivet-memory/
- Claude Code sibling: ../claude-code/rivet-memory/
- Sidecar: services/mcp-sidecar/
