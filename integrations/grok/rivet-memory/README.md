# rivet-memory (Grok Build)

RivetOS shared memory + high-quality recall discipline for **Grok Build** (the xAI Grok CLI TUI).

This gives Grok Build sessions first-class access to the same persistent memory store used by `rivet-claude` and `rivet-hermes`, plus the battle-tested recall rules that make agents actually use memory correctly.

## Current Status (v0.2)

- ✅ Excellent discipline skill (`memory-recall` + helpers)
- ✅ Easy MCP server registration
- ✅ Subagent definition (`memory-researcher`)
- ✅ Capture layer — full implementation with background worker, pre-compaction support, and hook launcher (ready to wire into Grok's hooks)
- 🚧 One-command `grok plugin install` packaging (manual skill + MCP setup works today)

## What it ships

| Component                  | Path                                              | Purpose |
|----------------------------|---------------------------------------------------|---------|
| Core discipline skill      | `skills/memory-recall/SKILL.md`                   | The most important piece. Teaches optimal browse-first + multi-angle + trigram behavior. |
| Quick command skills       | `skills/memory-today/`, `memory-yesterday/`       | High-frequency shortcuts. |
| Memory researcher subagent | `agents/memory-researcher.md`                     | Delegate heavy recall work to a focused read-only specialist. |
| MCP registration           | `.mcp.json` + README instructions                 | Brings in the full RivetOS memory + web tools. |
| Capture skeleton           | `capture/grok-memory-capture.ts` + `hooks/hooks.json` | Foundation for automatic capture using Grok's hook system. |

## Install (Current Recommended Path)

### 1. Build RivetOS (if not already)

```bash
cd /path/to/rivetos
npm run build
```

### 2. Configure the RivetOS MCP server

Add to `~/.grok/config.toml` (or use the included `.mcp.json` as a starting point):

```toml
[mcp_servers.rivetos]
command = "/path/to/rivetos/plugins/transports/mcp-server/dist/cli.js"
args = ["--stdio"]
# env can pull RIVETOS_PG_URL etc. from ~/.rivetos/.env or be set directly
```

Restart Grok or run `/mcps reload`.

### 3. Install the skills

**Project scope** (recommended):
```bash
cp -r integrations/grok/rivet-memory/skills/* .grok/skills/
```

**User scope**:
```bash
cp -r integrations/grok/rivet-memory/skills/* ~/.grok/skills/
```

The `memory-recall` skill should now activate automatically on relevant prompts.

### 4. (Optional) Copy the researcher agent definition

Place `agents/memory-researcher.md` where your Grok setup can reference it as a subagent persona.

## Capture (Automatic History Writing)

We now have a working capture implementation modeled on the proven patterns from both the Claude Code and Hermes versions:

- Extremely fast on the hot path (spool + detached worker)
- Supports turns, tool calls, pre-compaction bulk capture, and session end
- Writes under agent `rivet-grok` into the shared memory store

### Setup

1. Make sure the capture script and launcher are accessible (usually by checking out RivetOS at a known path).

2. Configure Grok hooks (example in `hooks/hooks.json`):

   ```json
   {
     "PostToolUse": [
       { "hooks": [{ "type": "command", "command": "/path/to/rivetos/integrations/grok/rivet-memory/bin/grok-memory-hook.sh PostToolUse", "timeout": 8 }] }
     ],
     "TurnAfter": [ ... ],
     "CompactBefore": [ ... ],
     "SessionEnd": [ ... ]
   }
   ```

3. Point the launcher at your RivetOS checkout using the `RIVETOS_ROOT` environment variable if needed.

The launcher (`bin/grok-memory-hook.sh`) reads the hook payload from stdin and hands it off to the capture worker. All writes are best-effort and will never block your Grok session.

Pre-compaction messages are captured when `CompactBefore` fires — this is one of the highest-value events for long sessions.

## Architecture Notes

**Grok-native hybrid** (chosen as the best path after comparing the Claude and Hermes implementations):

- **Tools** → MCP (consistent with Grok's native `search_tool` / `use_tool` model)
- **Capture** → Grok hooks + background spooling + worker (combines the best non-blocking patterns from Hermes queue + Claude detached-worker approach)
- **Discipline** → The strongest version of the memory-recall rules, with `window=` support and pre-compaction awareness

This design makes sessions from `grok` first-class citizens alongside `rivet-claude` and `rivet-hermes` in the shared memory store.

## Related

- Claude Code sibling: `../claude-code/rivet-memory/`
- Hermes sibling: `../hermes/rivet-memory/`
- Main memory design: `/docs/MEMORY-DESIGN.md` (in RivetOS root)
- The 2026-05-23 WAP-DHCP incident is the canonical case study for why the discipline rules matter.

---

**Future work tracked in this directory's README and the root RivetOS issues.**

Pull requests that improve capture integration or add more high-frequency skills are encouraged.
