# rivet-memory (DeepSeek Harness / dsh)

RivetOS shared memory + recall discipline for **DeepSeek Harness** (`dsh`),
targeting `deepseek-v4-pro` on the `rivet-deepseek` node (ct117).

**Memory capture is the priority-one feature.** dsh does **not** expose
Claude/kimi-style lifecycle hooks (`UserPromptSubmit` / `Stop` / `hooks.toml`).
Do not copy `integrations/kimi/rivet-memory/hooks`.

## Capture mechanism (report to Claude)

| Surface | Present in dsh 0.1.1-rc.2? | Used? |
|---|---|---|
| Claude-style hooks | **No** (optional `@deepseek-ai/dsh-hook-protocol` exists upstream but is not the native / default surface, and kimi already proved Stop omits assistant text) | No |
| Cordis `session/event` | **Yes** — official post-commit append firehose | **Live capture** |
| `$DSH_HOME/sessions/**/session.jsonl.zstd` | **Yes** — durable SessionEvent log | **Backfill** |

Live path: Cordis plugin `plugin/index.js` (`export const inject = ['sessions']`,
`ctx.on('session/event', …)`). Install with
`dsh plugin --profile headless add <this>/plugin` **and** the web profile.
It spools `user/message` (source.kind === `user` only), `assistant/message`,
`tool/call`, `tool/result`, `turn/end`, `compaction/start`, `session/title`
and detaches `capture/deepseek-memory-capture.mjs`.

Identity:

- `agent = "rivet-deepseek"`
- `channel = "dsh"`
- `session_key = "dsh:<sessionId>"`
- `event_id = dsh:<sessionId>:<event-uuid>` (message id / tool callId). Fallback
  is `dsh:<sessionId>:seq:<n>`. Content-hash is **not** the dedup key — two
  legitimate "ok" turns must both land (#525).
- Truncation (16K) only when the row carries `session_jsonl_path` (absolute
  `session.jsonl.zstd`) + `session_jsonl_line` so `memory_get_full` can
  re-read. No pointer → no silent cap.

Plugin-injected `user/message` snapshots (`source.kind === 'plugin'`, e.g.
`@deepseek-ai/dsh-system-prompt`) are dropped so recall is not flooded with
sandbox banners.

## What it ships

| Component | Location | Purpose |
|---|---|---|
| Cordis plugin | `plugin/` | Live `session/event` capture |
| Capture worker | `capture/deepseek-memory-capture.mjs` | Spool + PG ingest + zstd backfill |
| MCP launcher | `bin/rivet-memory-mcp.sh` | RivetOS memory tools over stdio |
| Setup | `bin/setup-deepseek-rivet-memory.sh` | `--apply` wires home patch + deps |
| Reflex | `DEEPSEEK.md` | Always-on recall rules |
| Skills / commands | `skills/`, `commands/` | memory-recall / today / yesterday / stats |
| Subagent | `agents/memory-researcher.md` | Delegated recall |

## Installation

```bash
# on ct117
export PATH=$HOME/.local/bin:$PATH
export RIVETOS_ROOT=/rivet-shared/RivetOS/RivetOS   # until /opt/rivetos exists
$RIVETOS_ROOT/integrations/deepseek/rivet-memory/bin/setup-deepseek-rivet-memory.sh --apply
```

Headless / print mode (kimi `-p` analogue): `dsh --profile headless "task"`.
Config home: `~/.dsh` (`$DSH_HOME`).

## Verify

```bash
# parser only
node capture/deepseek-memory-capture.mjs --backfill --dump ~/.dsh/sessions/.../session.jsonl.zstd

# datahub: first run inserts, second run skips
node capture/deepseek-memory-capture.mjs --backfill ~/.dsh/sessions
node capture/deepseek-memory-capture.mjs --backfill ~/.dsh/sessions
```

Rows land in `phil_memory.ros_messages` with `agent = 'rivet-deepseek'`.

## Related

- Kimi sibling: `../kimi/rivet-memory/` (hook-payload + wire.jsonl backfill)
- Grok sibling: `../grok/rivet-memory/`
- Core memory design: `/docs/MEMORY-DESIGN.md`
