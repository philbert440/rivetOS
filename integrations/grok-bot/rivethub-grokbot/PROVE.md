# Prove note — rivethub-grokbot 0.1.0

Date: 2026-09-05 (America/New_York)
Source: `/opt/rivetos/integrations/grok-bot/rivethub-grokbot`
Local install: `~/.cursor/plugins/local/rivethub-grokbot` (real directory)
Sibling MCP launcher also copied to `~/.cursor/plugins/local/rivet-memory` so `bin/rivetos-memory-mcp.sh` resolves.

## PASS

- Cursor manifest `.cursor-plugin/plugin.json`: kebab-case `name`, version, description, skills/rules/mcpServers paths
- Root `plugin.json` name matches (Cursor companion; no Agent Plugins `$schema` by design)
- Skills `memory-recall`, `mesh-delegate` present with frontmatter
- Rule `rules/rivethub-member.md` present
- Launchers `bash -n` clean; sibling `rivet-memory` launcher present in tree
- MCP stdio smoke from source and from local install: `initialize` → serverInfo `rivetos-mcp-server` 2.0.0
- Real-directory install under `~/.cursor/plugins/local/rivethub-grokbot` (not an outside symlink)

## SKIP / cannot prove here

- Agent Plugins 1.0.0 schema for root `plugin.json` / `mcp.json` — Cursor Plugin shape (expected FAIL against agent-plugins schemas)
- `@anysphere/cursor-plugins` `loadUserLocalPlugins` — package not installed in this environment
- Cursor IDE Reload / Customize UI — not this environment
- Grok Bot does not load `~/.cursor/plugins/local`; marketplace/dashboard only. Local prove still matters for Cursor IDE.

## Not done

- No Marketplace / cursor.directory publish
