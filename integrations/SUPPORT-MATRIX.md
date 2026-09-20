# RivetOS plugin support matrix

Honest status of each agent harness. Vendor compatibility claims from the
2026-09-19 marketplace survey are **untested by us** until a row says
otherwise. Nothing here is a publish or listing promise.

| Harness | Status | Date | Notes |
|---|---|---|---|
| Claude Code | tested | 2026-09-20 | Standalone `rivet-memory` kit: `userConfig`, checkout-or-npx MCP, capture fail-loud, `rivetos-onboard` / `rivetos-status`. Kit unit tests; not a fresh-container stranger proof. |
| GitHub Copilot CLI | vendor-claimed, untested | — | Reads `.claude-plugin/marketplace.json`. |
| VS Code agent plugins | vendor-claimed, untested | — | Reads Claude-format plugins. |
| OpenAI Codex CLI | vendor-claimed, untested | — | Agent Plugins 1.0 + legacy Claude marketplace. |
| xAI Grok Build | vendor-claimed, untested | — | Reads Claude marketplaces. |
| Cursor | vendor-claimed, untested | — | Separate grok-bot kit; not this Claude plugin. |
| Qwen Code | vendor-claimed, untested | — | Installs Claude marketplaces. |
| Gemini CLI | vendor-claimed, untested | — | Own extension manifest; not this kit. |
| Kimi Code CLI | vendor-claimed, untested | — | Own plugin filename. |
| OpenCode | vendor-claimed, untested | — | npm plugin, not Claude marketplace. |
| pi (pi-coding-agent) | vendor-claimed, untested | — | No MCP. |
| Hermes Agent | vendor-claimed, untested | — | Native provider plugin. |
| Junie CLI | vendor-claimed, untested | — | Reads `.claude-plugin/marketplace.json`. |
| Factory Droid / Auggie CLI | vendor-claimed, untested | — | Reads `.claude-plugin`. |
| MCP Registry | vendor-claimed, untested | — | Needs `server.json` + `mcpName`. |
| Claude community directory | vendor-claimed, untested | — | Submission gated on owner yes. |
