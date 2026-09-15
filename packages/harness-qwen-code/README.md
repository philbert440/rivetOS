# @rivetos/harness-qwen-code

The `qwen-code` half of the harness control plane's task side: a
`HarnessExecutor` that runs a RivetOS task on the local Qwen Code CLI
(`@qwen-code/qwen-code`, bin `qwen`), headlessly.

```
qwen -p <prompt> --output-format stream-json --include-partial-messages
     --approval-mode yolo [--session-id id | --resume id] [-m model]
     [--append-system-prompt text] [--max-session-turns N]
```

Not a provider plugin — there is no `LanguageModel` here and no
`providers.qwen-code` config slice in this package. It exists so `@rivetos/boot`
can register a real executor for harness id `qwen-code`. The provider-plugin id
(owned elsewhere) is also `qwen-code`.

## How a turn works

1. **Spawn.** One `qwen -p --output-format stream-json` per turn, in a **fixed
   `cwd`** (sessions are project-scoped; a resume from another directory is
   rejected). Default cwd is `~/.rivetos/workspace` when neither the task spec
   nor executor config sets one. The task scaffold (context, acceptance
   criteria, the `TASK_RESULT` fence contract, and the cwd) is passed as
   `--append-system-prompt`. The turn prompt is the `-p` argv value. Spawn
   stdin is ignored — qwen appends stdin to the prompt and waits otherwise.
   `QWEN_CODE_SUPPRESS_YOLO_WARNING=1` is set on the child.
2. **Stream.** stdout is Claude-shaped stream-json: `system/init` (native UUID),
   `stream_event` `content_block_delta` (`thinking_delta` / `text_delta` /
   `input_json_delta`), `assistant` (one line per content block), `user`
   (`tool_result`), `result` (run totals). Native id is canonicalized to
   `qwen-code:<uuid>`. Turn 1 pins `--session-id`; turn N uses `--resume`.
3. **Reconcile.** Per-turn usage is the last `assistant` line with non-zero
   `usage` (`input_tokens` / `output_tokens` /
   `cache_read_input_tokens`→cacheRead). `result.usage` is the whole-run total
   and is only the fallback. If stdout carried no usage, after the child exits
   the executor reads
   `~/.qwen/projects/<cwd-with-/-to-->/chats/<uuid>.jsonl` (gemini-style
   `parts`) and reports tokens from `usageMetadata`. A reconcile that finds
   nothing degrades to zero usage and a warning; it can never fail a turn.
4. **Steer.** Follow-up turns spawn `--resume <native-id>` in the **same cwd**.
   If qwen refuses the resume (`No saved session found with ID …` on stdout,
   exit 0, no `system/init` line), the turn retries once on a fresh
   `--session-id` seeded with the task's rendered history.

## What it does not do

- **No cost.** Tokens only — no `cost` events, no `usage.costUsd`.
- **No structured-output schema.** The fenced `TASK_RESULT` block is the only
  structured channel.
- **No per-turn MCP injection.** Servers come from qwen's own persistent
  config (`~/.qwen/settings.json`), shared with the interactive harness.
- **No effort flag.** Qwen has no `--effort`/`--thinking` CLI flag; effort is
  per-model in settings.json.
- **No `$QWEN_HOME`.** Data dir is `~/.qwen`. A configured `home` redirects
  the on-disk reader (tests).

## Config

```yaml
tasks:
  harnesses:
    qwen-code:
      binary: /usr/local/bin/qwen # default: `qwen` on PATH
      model: qwen-27b # optional; -m
      cwd: /srv/rivetos/work # default: ~/.rivetos/workspace
      home: ~/.qwen # optional on-disk reader redirect
```

Boot probes `qwen --version` and registers a rejecting executor carrying the
probe's reason when it fails, so a node without the binary says so instead of
going silent. (Boot wiring is owned by another package.)

## Testing

`npm test` runs the shared executor-conformance suite plus qwen-code specifics
against a FAKE `qwen` binary writing a qwen-shaped session jsonl into a
throwaway data dir. No provider tokens are spent and the operator's `~/.qwen`
is never touched.
