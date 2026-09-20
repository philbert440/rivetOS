# Prove note — rivethub-grokbot 0.2.0

Checklist for a local or CI prove of this kit. Run from a RivetOS checkout
(or a tree that contains this kit plus `integrations/shared` and
`integrations/grok-bot/rivet-memory`).

## PASS

- Cursor manifest `.cursor-plugin/plugin.json`: kebab-case `name`, version, description, skills/rules/mcpServers paths
- Root `plugin.json` name matches (Cursor companion; no Agent Plugins `$schema` by design)
- Skills `memory-recall`, `rivetos-onboard`, `rivetos-status`, `mesh-delegate` present with frontmatter
- Rule `rules/rivethub-member.md` present
- Launchers `bash -n` clean; sibling `rivet-memory` launcher present in tree
- `integrations/shared/rivet-paths.test.sh` and `test/onboard-status.test.sh` pass
- MCP stdio smoke from source: `initialize` → serverInfo `rivetos-mcp-server`

## SKIP / cannot prove here

- Agent Plugins 1.0.0 schema for root `plugin.json` / `mcp.json` — Cursor Plugin shape (expected FAIL against agent-plugins schemas)
- `@anysphere/cursor-plugins` `loadUserLocalPlugins` — package not installed in this environment
- Cursor IDE Reload / Customize UI — not this environment
- Grok Bot marketplace/dashboard load — not this environment

## Not done

- No Marketplace / cursor.directory publish
- Kit is not self-contained; marketplace-only install still needs `RIVETOS_ROOT` or a checkout
