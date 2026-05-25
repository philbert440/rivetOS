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
| Capture system              | `capture/` (workspace `@rivetos/grok-rivet-memory-capture`) + `bin/grok-memory-hook.sh` | Non-blocking capture of turns, tool calls, and pre-compaction messages. Built via root `npm run build`. |
| MCP launcher                | `bin/rivet-memory-mcp.sh`                             | Clean, consistent way to expose RivetOS memory tools to Grok. |
| Project reflex              | `GROK.md`                                             | Always-on memory discipline rules (install into your rules). |
| Hook examples               | `hooks/hooks.json`                                    | How to wire automatic capture into Grok's hook system. |
| Plugin metadata             | `plugin.json`, `.grok/marketplace.json`               | For future `grok plugin install` support. |

## Installation

> Throughout, `$RIVETOS_ROOT` is your RivetOS checkout. Default: `/opt/rivetos`.
> All scripts in `bin/` honor `RIVETOS_ROOT` if it's set in the environment
> (or sourced from `~/.rivetos/.env`), so non-default install layouts are
> fully supported — you do not need to edit any tracked file.

### 1. Build RivetOS (required for both the MCP server and the capture worker)

```bash
cd $RIVETOS_ROOT
npm install        # picks up the capture workspace, installs pg + tsx
npm run build      # produces dist/ for the MCP server and the capture worker
```

This produces:
- `$RIVETOS_ROOT/plugins/transports/mcp-server/dist/cli.js` (memory MCP server)
- `$RIVETOS_ROOT/integrations/grok/rivet-memory/capture/dist/grok-memory-capture.js` (capture worker)

### 2. Configure the RivetOS MCP Server (Recommended)

Use the dedicated launcher for consistency with the Claude integration. It
reads `$RIVETOS_ROOT` at run time:

```toml
# ~/.grok/config.toml or project .mcp.json
[mcp_servers.rivetos]
command = "/opt/rivetos/integrations/grok/rivet-memory/bin/rivet-memory-mcp.sh"
# If your install lives elsewhere, set RIVETOS_ROOT in ~/.rivetos/.env and
# point `command` at that path instead.
```

Alternative (direct):
```toml
[mcp_servers.rivetos]
command = "/opt/rivetos/plugins/transports/mcp-server/dist/cli.js"
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

The capture system writes the full Grok session — user prompts, assistant
responses, agent thoughts, tool calls *and their actual outputs*, and
memory-flush markers — into the shared memory store under `agent = "rivet-grok"`.

It is designed to be:
- Extremely fast on the hot path (spool + detached worker)
- Best-effort (never blocks your Grok session)
- **Complete** — reads Grok's own session transcript at `~/.grok/sessions/.../updates.jsonl`
  rather than trying to reconstruct content from hook payloads (which carry
  only signals; the response text, agent thoughts, and tool outputs are *not*
  in any hook payload — they only exist in `updates.jsonl`).

### Enabling Capture

Grok loads hooks from JSON files in `~/.grok/hooks/` (global) or
`<project>/.grok/hooks/` (project, requires trust). They are **not** loaded
from `~/.grok/config.toml` — that's MCP servers only.

1. Drop the shipped example into your hooks dir:
   ```bash
   mkdir -p ~/.grok/hooks
   cp /opt/rivetos/integrations/grok/rivet-memory/hooks/hooks.json ~/.grok/hooks/rivet-memory.json
   ```

2. The file wires 7 Grok lifecycle events:
   ```
   SessionStart, SessionEnd, UserPromptSubmit,
   PostToolUse, PostToolUseFailure, Stop, PreCompact
   ```
   Each fires the launcher, which spools an *ingest* job and detaches a
   worker — single-digit ms on the hot path. The worker then reads the
   session's `updates.jsonl` from disk and inserts only the messages it
   hasn't already stored (slice-by-count idempotency). Edit the JSON to
   remove any event you don't want — the worker is fully re-entrant, so
   fewer triggers just means less-frequent refresh.

3. The launcher handles environment loading and hands off to the capture worker.

Pre-compaction capture (`PreCompact`) is the highest-value trigger — it
guarantees we ingest before Grok rewrites the session log.

## Architecture

This integration adopts the proven **JSONL-ingest** pattern from
`plugins/providers/claude-cli/src/transcript-capture.ts`:

- **Tools** — Exposed via MCP (idiomatic to Grok's `search_tool` / `use_tool` model)
- **Capture** — Hooks are pure **triggers**; the worker reads Grok's authoritative
  session log (`updates.jsonl`) directly. This is the same file the Grok TUI
  uses for `/load` and session restore, so it carries everything Grok itself
  knows about the session: user prompts, assistant responses, agent thoughts,
  full structured tool I/O. Idempotency comes from slice-by-count over a
  deterministic parser of an append-only file. See
  [`capture/README.md`](./capture/README.md#architecture-jsonl-ingestion).
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

## Installation on a Specific Host

When setting this up on a specific RivetOS node:

1. Ensure the RivetOS repo is checked out and built on that host.
2. Run the helper script (honors `RIVETOS_ROOT`, defaults to `/opt/rivetos`):
   ```bash
   $RIVETOS_ROOT/integrations/grok/rivet-memory/bin/setup-grok-rivet-memory.sh
   ```
3. Follow the printed instructions for MCP, skills, `GROK.md`, and capture hooks.
4. If you want the bin scripts in PATH:
   ```bash
   $RIVETOS_ROOT/integrations/grok/rivet-memory/bin/setup-grok-rivet-memory.sh --link
   ```

This makes the full rivet-memory experience (including capture) available for any Grok sessions that touch that host.

## Future Work

- Full one-command `grok plugin install` experience (skills + MCP + hooks)
- Deeper integration with Grok's exact hook surface as it matures
- Shared capture library between Claude and Grok implementations
- More specialized skills (host inventory, decision audit, etc.)
- Partial unique index on `(conversation_id, (metadata->>'event_id'))` to convert
  capture dedup from SELECT-then-INSERT to `ON CONFLICT DO NOTHING`

## Related

- Claude Code sibling: `../claude-code/rivet-memory/`
- Hermes sibling: `../hermes/rivet-memory/`
- Core memory design: `/docs/MEMORY-DESIGN.md`
- The 2026-05-23 WAP-DHCP incident is the canonical case study for why this discipline exists.

---

Pull requests that improve capture robustness, add high-value skills, or help with Grok hook integration are very welcome.
