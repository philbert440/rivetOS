# @rivetos/harness-opencode

The `opencode` half of the harness control plane's task side: a
`HarnessExecutor` that runs a RivetOS task on the local OpenCode CLI,
headlessly.

```
opencode run --format json [-m provider/model] [--variant v] [-s session_id] <prompt>
```

Not a provider plugin — there is no `LanguageModel` here and no
`providers.opencode` config slice (the provider-plugin id `opencode-cli` is a
separate package). It exists so `@rivetos/boot` can register a real executor
for harness id `opencode`.

## How a turn works

1. **Spawn.** One `opencode run` per turn, in a fixed `cwd`. The task scaffold
   (context, acceptance criteria, the `TASK_RESULT` fence contract) is
   prepended to the prompt: `run` has no `--append-system-prompt`.
   `--variant` maps RivetOS effort (low→`minimal`, medium→omit, high→`high`,
   xhigh/max→`max`).
2. **Stream.** `--format json` writes the same objects as `message`/`part`
   rows — translated to den `message.agent` / `tool.start` / `tool.end`.
   Session id is adopted from SQLite (newest `session` row for this cwd
   created after spawn start) or from a json event if present, then
   canonicalized to `opencode:<native-id>`. There is no flag to pin a new
   session id.
3. **Reconcile.** After the child exits the executor reads the session's
   message rows in `opencode.db` (token counts per assistant message) and
   reports the turn's tokens from there. If the store is empty, JSON
   `step-finish` / assistant-envelope tokens are a fallback; if both are
   empty, usage degrades to zero rather than failing the turn.
4. **Steer.** Follow-up turns spawn `--session <native-id>`, so the whole task
   shares ONE opencode session and its context. If opencode refuses the resume
   (any non-zero exit while `-s` was passed), the turn retries once on a fresh
   session seeded with the task's rendered history.

## Session store

Sessions are **not files**. They live in SQLite:

`$XDG_DATA_HOME/opencode/opencode.db` else `~/.local/share/opencode/opencode.db`

(WAL mode). Native ids are `ses_` + 20+ alphanumerics.

## What it does not do

- **No ACP drive.** There is an ACP nd-JSON server over stdin/stdout; this
  executor does not speak it. Headless drive is `opencode run`.
- **No structured-output schema.** No `--json-schema` on this CLI; the fenced
  `TASK_RESULT` block is the only structured channel.
- **No per-turn MCP injection.** Servers come from opencode's own config
  (`opencode.json`), shared with the interactive harness.
- **No session-id pinning.** A fresh `run` mints `ses_…`; RivetOS adopts it.

## Config

```yaml
tasks:
  harnesses:
    opencode:
      binary: /usr/local/bin/opencode  # default: `opencode` on PATH
      model: zai/glm-5.3-flash         # optional, provider/model ([1m] is not valid on z.ai)
      cwd: /srv/rivetos/work           # default: the workspace dir
      home: ~/.local/share/opencode    # optional data-dir override (sets XDG_DATA_HOME)
```

Boot probes `opencode --version` and registers a rejecting executor carrying
the probe's reason when it fails, so a node without the binary says so
instead of going silent.

## Testing

`npm test` runs the shared executor-conformance suite plus opencode specifics
against a FAKE `opencode` binary writing an opencode-shaped SQLite transcript
into a throwaway data dir. The real binary is never invoked and the operator's
`~/.local/share/opencode` is never touched.
