# rivet-memory (Qwen Code)

RivetOS shared memory + high-quality recall discipline for **Qwen Code**,
targeting the `rivet-qwen` agent.

This integration gives Qwen Code sessions first-class access to the same
persistent, cross-agent memory store used by `rivet-claude`, `rivet-hermes`,
`rivet-grok`, `rivet-kimi`, `rivet-gpt`, and `rivet-deepseek`, along with the
battle-tested recall rules that prevent agents from repeatedly failing at
"remembering" things they should know.

**Memory capture is the priority-one feature.** Skills/MCP/reflex matter, but
capture correctness beats everything else.

Capture is triggered by native Qwen hooks (`UserPromptSubmit`, `Stop`,
`SessionEnd`) which ingest `~/.qwen/projects/<cwd>/chats/<uuid>.jsonl` from a
persisted cursor. The default install path is a **qwen extension** (hooks +
MCP + skills in one unit). `--mode settings` merges the same three hook groups
into `~/.qwen/settings.json` if a node refuses extensions.

## Goals

- Make `rivet-qwen` a true peer to the other Rivet agents in the shared memory system.
- Deliver the strongest possible memory discipline so Qwen Code reaches for the right tool on the first try.
- Provide automatic capture of user, assistant, and tool turns from session jsonl.
- Keep the integration lightweight and idiomatic to Qwen's extension + hooks + MCP model.

## What It Ships

| Component             | Location                                                                              | Purpose                                                                |
| --------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Core discipline skill | `extension/skills/memory-recall/SKILL.md`                                             | Optimal `memory_browse` first + multi-angle search + trigram fallback. |
| Quick skills          | `extension/skills/memory-today/`, `memory-yesterday/`, `memory-stats/`                | High-frequency shortcuts (slash commands).                             |
| Capture system        | `capture/` (`@rivetos/qwen-code-rivet-memory-capture`) + `bin/qwen-memory-capture.sh` | Hook ingest under `agent = "rivet-qwen"`.                              |
| Extension manifest    | `extension/qwen-extension.json` + `extension/hooks/hooks.json`                        | MCP + UserPromptSubmit / Stop / SessionEnd → `--hook`.                 |
| MCP launcher          | `bin/rivet-memory-mcp.sh`                                                             | Expose RivetOS memory tools to Qwen Code.                              |
| Project reflex        | `QWEN.md`                                                                             | Always-on memory discipline rules.                                     |
| Plugin metadata       | `plugin.json`                                                                         | Harness `qwen-code`, minVersion `0.23.4`.                              |

## Identity

| field       | value                                      |
| ----------- | ------------------------------------------ |
| agent       | `rivet-qwen` (env `RIVETOS_CAPTURE_AGENT`) |
| channel     | `qwen-code`                                |
| session_key | `qwen-code:<uuid>`                         |
| native id   | transcript filename UUID                   |

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
- `$RIVETOS_ROOT/integrations/qwen-code/rivet-memory/capture/dist/qwen-memory-capture.js`

### 2. One-command setup (recommended)

```bash
$RIVETOS_ROOT/integrations/qwen-code/rivet-memory/bin/setup-qwen-rivet-memory.sh --apply
```

`--apply` (default `--mode extension`):

1. Stages a copy of `extension/` with every `<PLUGIN_PATH>` rewritten to the
   absolute plugin dir (`$RIVETOS_ROOT/integrations/qwen-code/rivet-memory`).
2. `qwen extensions uninstall rivet-memory` (ignore failure).
3. `qwen extensions install <staging> --consent` (non-interactive).
4. Verifies `~/.qwen/extensions/rivet-memory/hooks/hooks.json` contains
   `qwen-memory-capture.sh`. Exit non-zero only on verification failure.

Override the binary / data home with `QWEN_BINARY` and `QWEN_HOME`
(default `~/.qwen`).

Fallback if the node refuses extensions:

```bash
setup-qwen-rivet-memory.sh --apply --mode settings
```

That merges the same three hook groups into `~/.qwen/settings.json` `"hooks"`
idempotently (marker = the capture command string). Other settings keys are
untouched.

### 3. Opt-in: disable managed auto-memory

Qwen makes one extra model call after each headless `-p` run to extract
memories. To skip that:

```bash
setup-qwen-rivet-memory.sh --disable-auto-memory
```

Sets `memory.enableManagedAutoMemory: false` in user settings.

### 4. Verify / uninstall / backfill

```bash
setup-qwen-rivet-memory.sh --status
setup-qwen-rivet-memory.sh --remove
$RIVETOS_ROOT/integrations/qwen-code/rivet-memory/bin/qwen-memory-capture.sh --backfill [--days N]
$RIVETOS_ROOT/integrations/qwen-code/rivet-memory/bin/qwen-memory-capture.sh --status
```

Doctor marker: `~/.qwen/extensions/rivet-memory/hooks/hooks.json` exists and
references `qwen-memory-capture.sh`.

There was never a watcher unit for qwen — `--apply` migrates nothing.

## Uninstall

```bash
setup-qwen-rivet-memory.sh --remove
```

Uninstalls the extension (and deletes our copy under `~/.qwen/extensions/`)
and strips marker groups from `~/.qwen/settings.json`.
