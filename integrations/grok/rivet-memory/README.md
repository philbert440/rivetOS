# rivet-memory (Grok Build)

RivetOS shared memory + high-quality recall discipline for **Grok Build** (the xAI Grok CLI TUI).

This integration gives Grok Build sessions first-class access to the same persistent, cross-agent memory store used by `rivet-claude` and `rivet-hermes`, along with the battle-tested recall rules that prevent agents from repeatedly failing at "remembering" things they should know.

## Goals

- Make `grok` a true peer to the other Rivet agents in the shared memory system.
- Deliver the strongest possible memory discipline so Grok reaches for the right tool on the first try.
- Provide automatic capture of turns, tool calls, and pre-compaction context (when hooks are enabled).
- Keep the integration lightweight and idiomatic to Grok's MCP + skills model.

## Current Status

| Component              | Status     | Notes |
|------------------------|------------|-------|
| Memory discipline skill| ✅ Excellent | Strongest version across all three integrations |
| Helper skills          | ✅ Good    | memory-today, memory-yesterday, memory-stats |
| Subagent               | ✅ Good    | memory-researcher |
| MCP tools              | ✅ Good    | Via existing RivetOS MCP server |
| Capture                | ✅ Solid   | Full background worker implementation + launcher |
| Packaging & Install    | 🚧 Good    | Manual setup works well; one-command plugin install in progress |
| Reflex / Always-on rules | ✅ Good  | `GROK.md` + command definitions |

## What It Ships

| Component                    | Location                                              | Purpose |
|-----------------------------|-------------------------------------------------------|---------|
| Core discipline skill       | `skills/memory-recall/SKILL.md`                       | The heart of the integration. Encodes optimal `memory_browse` first + multi-angle search + trigram fallback. |
| Quick commands              | `skills/memory-today/`, `memory-yesterday/`, `memory-stats/` + `commands/` | High-frequency shortcuts. |
| Memory researcher subagent  | `agents/memory-researcher.md`                         | Delegate heavy or multi-step recall work. |
| Capture system              | `capture/grok-memory-capture.ts` + `bin/grok-memory-hook.sh` | Non-blocking capture of turns, tool calls, and pre-compaction messages. |
| MCP launcher                | `bin/rivet-memory-mcp.sh`                             | Clean, consistent way to expose RivetOS memory tools to Grok. |
| Project reflex              | `GROK.md`                                             | Always-on memory discipline rules (install into your rules). |
| Hook examples               | `hooks/hooks.json`                                    | How to wire automatic capture into Grok's hook system. |
| Plugin metadata             | `plugin.json`, `.grok/marketplace.json`               | For future `grok plugin install` support. |

## Installation

### 1. Build RivetOS (required for MCP server)

```bash
cd /path/to/rivetos
npm run build
```

### 2. Configure the RivetOS MCP Server (Recommended)

Use the dedicated launcher for consistency with the Claude integration:

```toml
# ~/.grok/config.toml or project .mcp.json
[mcp_servers.rivetos]
command = "/path/to/rivetos/integrations/grok/rivet-memory/bin/rivet-memory-mcp.sh"
```

Alternative (direct):
```toml
[mcp_servers.rivetos]
command = "/path/to/rivetos/plugins/transports/mcp-server/dist/cli.js"
args = ["--stdio"]
```

Restart Grok or run `/mcps reload` and verify the `memory_*` tools appear.

### 3. Install the Skills

**Recommended (project scope):**
```bash
cp -r integrations/grok/rivet-memory/skills/* .grok/skills/
```

**Global (user scope):**
```bash
cp -r integrations/grok/rivet-memory/skills/* ~/.grok/skills/
```

### 4. (Strongly Recommended) Install the Reflex

Copy `GROK.md` into your project rules or global configuration so the memory discipline is active in every session.

### 5. (Optional) Enable Automatic Capture

See the **Capture** section below.

## Capture (Automatic History Writing)

The capture system writes user prompts, assistant responses, tool calls, and pre-compaction messages into the shared memory store under `agent = "rivet-grok"`.

It is designed to be:
- Extremely fast on the hot path (spool + detached worker)
- Best-effort (never blocks your Grok session)
- Rich (especially pre-compaction)

### Enabling Capture

1. Use the provided launcher in your Grok hooks configuration (example in `hooks/hooks.json`):
   ```json
   {
     "PostToolUse": [{ "hooks": [{ "type": "command", "command": ".../bin/grok-memory-hook.sh PostToolUse" }] }],
     "TurnAfter": [...],
     "CompactBefore": [...],
     "SessionEnd": [...]
   }
   ```

2. The launcher handles environment loading and hands off to the capture worker.

Pre-compaction capture (`CompactBefore`) is particularly valuable for long Grok sessions.

## Architecture

This integration follows a **Grok-native hybrid** approach, deliberately chosen after comparing the Claude and Hermes implementations:

- **Tools** — Exposed via MCP (idiomatic to Grok's `search_tool` / `use_tool` model)
- **Capture** — Uses Grok's hook system + background spooling/worker (combines the best non-blocking patterns from both other implementations). Uses per-session advisory locks for safety against concurrent hook deliveries; simple INSERTs mean occasional duplicate rows are possible on retries (rare in practice).
- **Discipline** — The strongest version of the memory-recall rules, with explicit `window=` awareness and pre-compaction sensitivity

This makes Grok sessions first-class citizens in the shared RivetOS memory store.

## Comparison with Siblings

| Feature                    | Claude Code Plugin      | Hermes Plugin           | Grok Build Plugin          |
|---------------------------|-------------------------|-------------------------|----------------------------|
| Tool exposure             | MCP                     | Native in-process       | MCP (Grok-native)          |
| Capture richness          | Very good               | Excellent (pre-compaction + more) | Good + improving        |
| Discipline                | Strong                  | Strongest               | Strongest (shared)         |
| Always-on reflex          | `CLAUDE.md`             | System prompt injection | `GROK.md`                  |
| Quick commands            | `commands/`             | Tools                   | Skills + `commands/`       |
| Packaging                 | `.claude-plugin/`       | Python package          | Grok plugin + marketplace  |

## Installation on Remote Hosts (e.g. 10.4.20.112)

When setting this up on a specific RivetOS node:

1. Ensure the RivetOS repo is checked out and built on that host.
2. Run the helper script:
   ```bash
   /opt/rivetos/integrations/grok/rivet-memory/bin/setup-grok-rivet-memory.sh
   ```
3. Follow the printed instructions for MCP, skills, `GROK.md`, and capture hooks.
4. If you want the bin scripts in PATH:
   ```bash
   /opt/rivetos/integrations/grok/rivet-memory/bin/setup-grok-rivet-memory.sh --link
   ```

This makes the full rivet-memory experience (including capture) available for any Grok sessions that touch that host.

## Future Work

- Full one-command `grok plugin install` experience (skills + MCP + hooks)
- Deeper integration with Grok's exact hook surface as it matures
- Shared capture library between Claude and Grok implementations
- More specialized skills (host inventory, decision audit, etc.)
- Tests for the capture module

## Related

- Claude Code sibling: `../claude-code/rivet-memory/`
- Hermes sibling: `../hermes/rivet-memory/`
- Core memory design: `/docs/MEMORY-DESIGN.md`
- The 2026-05-23 WAP-DHCP incident is the canonical case study for why this discipline exists.

---

Pull requests that improve capture robustness, add high-value skills, or help with Grok hook integration are very welcome.
