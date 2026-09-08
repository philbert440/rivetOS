# rivet-memory (Codex CLI)

RivetOS shared memory + high-quality recall discipline for **Codex CLI**,
targeting the `rivet-gpt` node.

This integration gives Codex sessions first-class access to the same persistent,
cross-agent memory store used by `rivet-claude`, `rivet-hermes`, `rivet-grok`,
and `rivet-kimi`, along with the battle-tested recall rules that prevent agents
from repeatedly failing at "remembering" things they should know.

**Memory capture is the priority-one feature.** Skills/commands/reflex matter,
but capture correctness beats everything else.

Codex has **no Claude/kimi-style hooks**. Capture is a file watcher over
`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl`.

## Goals

- Make `rivet-gpt` a true peer to the other Rivet agents in the shared memory system.
- Deliver the strongest possible memory discipline so Codex reaches for the right tool on the first try.
- Provide automatic capture of user, assistant, and tool turns from rollout jsonl.
- Keep the integration lightweight and idiomatic to Codex's MCP + skills model.

## What It Ships

| Component                    | Location                                              | Purpose |
|-----------------------------|-------------------------------------------------------|---------|
| Core discipline skill       | `skills/memory-recall/SKILL.md`                       | Optimal `memory_browse` first + multi-angle search + trigram fallback. |
| Quick commands              | `skills/memory-today/`, `memory-yesterday/`, `memory-stats/` + `commands/` | High-frequency shortcuts. |
| Memory researcher subagent  | `agents/memory-researcher.md`                         | Delegate heavy or multi-step recall work. |
| Capture system              | `capture/` (`@rivetos/codex-rivet-memory-capture`) + `bin/codex-memory-capture.sh` | Watcher ingest under `agent = "rivet-gpt"`. |
| Backfill                    | `backfill/` (`@rivetos/codex-rivet-memory-backfill`)  | One-shot replay of existing rollouts. |
| MCP launcher                | `bin/rivet-memory-mcp.sh`                             | Expose RivetOS memory tools to Codex. |
| Project reflex              | `CODEX.md`                                            | Always-on memory discipline rules. |
| Plugin metadata             | `plugin.json`                                         | For future plugin install support. |

## Identity

| field | value |
|-------|--------|
| agent | `rivet-gpt` |
| channel | `codex` |
| session_key | `codex:<uuid>` |
| native id | bare rollout UUID (no `session_` prefix) |

## Installation

> Throughout, `$RIVETOS_ROOT` is your RivetOS checkout. Default: `/opt/rivetos`.

### 1. Build RivetOS

```bash
cd $RIVETOS_ROOT
npm install
npm run build
```

This produces:
- `$RIVETOS_ROOT/services/mcp-sidecar/dist/cli.js`
- `$RIVETOS_ROOT/integrations/codex/rivet-memory/capture/dist/codex-memory-capture.js`

Root `package.json` `workspaces` must include
`integrations/codex/rivet-memory/capture` and
`integrations/codex/rivet-memory/backfill`.

### 2. One-command setup (recommended)

```bash
$RIVETOS_ROOT/integrations/codex/rivet-memory/bin/setup-codex-rivet-memory.sh --apply
```

### 3. Start capture on the Codex node

```bash
$RIVETOS_ROOT/integrations/codex/rivet-memory/bin/codex-memory-capture.sh --watch
```

Logs: `~/.rivetos/codex-memory-capture.log`.

## Recall of truncated rows

Capture caps stored bodies at 16K and keeps `metadata.session_jsonl_path` +
`session_jsonl_line` pointing at the rollout file. `memory_get_full` re-reads
that line (Codex `response_item` shape).

## Agent-facing recall

Setup registers `rivetos` in Codex `config.toml` using `codex mcp add` and preserves
other servers and settings. Existing registration is retained unless `--force`
is supplied. Start a new session after registering; `codex mcp list` should show
`rivetos` enabled. The capture watcher alone does not provide agent tools.

Recall tools: `memory_search`, `memory_browse`, `memory_get_full`, `memory_stats`,
`wiki_search`, and `wiki_read`. See `workspace-templates/MEMORY.md` for arguments
and selection guidance. The launcher loads database/embedding settings from
`~/.rivetos/.env`; without a database URL the server starts without recall tools.
