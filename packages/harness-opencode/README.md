# @rivetos/harness-opencode

The `opencode` half of the harness control plane's task side: a
`HarnessExecutor` that runs a RivetOS task on the local OpenCode CLI,
headlessly.

```
opencode run [--session <session_id>] [--model <provider/model>] --format json <prompt>
```

Not a provider plugin — there is no `LanguageModel` here and no
`providers.opencode` config slice (the provider-plugin id `opencode-cli` is a
separate package). It exists so `@rivetos/boot` can register a real executor
for harness id `opencode`.

## How a turn works

1. **Spawn.** One `opencode run` per turn, in a fixed `cwd`. The task scaffold
   (context, acceptance criteria, the `TASK_RESULT` fence contract) is
   prepended to the prompt: `run` has no `--append-system-prompt`.
2. **Stream.** `--format json` gives assistant text, tool-use parts and
   correlated tool completions — translated to den `message.agent` /
   `tool.start` / `tool.end`. Session id is read off the JSON events
   (`sessionID` / `part.sessionID`) and canonicalized to
   `opencode:<native-id>`.
3. **Reconcile.** After the child exits the executor reads the session's
   on-disk message records (token counts per assistant message) and reports
   the turn's tokens from there. Post-hoc, because the process has exited: no
   tailing, no attribution race. If the store is empty, JSON `step_finish`
   tokens are a fallback; if both are empty, usage degrades to zero rather
   than failing the turn.
4. **Steer.** Follow-up turns spawn `--session <native-id>`, so the whole task
   shares ONE opencode session and its context. If opencode refuses the resume
   (`Session not found`, or equivalent), the turn retries once on a fresh
   session seeded with the task's rendered history.

## Session-create quirk

`opencode run` has a known headless bug class: it can report `Session not
found` when no session exists yet. A **resume** that hits that error retries
fresh (no `--session`). A **fresh** spawn that hits it is a failed turn —
retrying fresh would loop. Creating a session non-interactively before `run`
(API `POST /session`, JSON import, or a minting flag) is still
`REVIEWER-CONFIRM` against the installed binary.

## What it does not do

- **No ACP drive.** There is an ACP nd-JSON server over stdin/stdout; this
  executor does not speak it. Headless drive is `opencode run`.
- **No structured-output schema.** No `--json-schema` on this CLI; the fenced
  `TASK_RESULT` block is the only structured channel.
- **No per-turn MCP injection.** Servers come from opencode's own config
  (`opencode.json`), shared with the interactive harness.
- **No effort flag.** `spec.effort` is ignored until a flag/env is confirmed
  on the installed binary.

## Config

```yaml
tasks:
  harnesses:
    opencode:
      binary: /usr/local/bin/opencode  # default: `opencode` on PATH
      model: zai/glm-5.3-flash         # optional, provider/model
      cwd: /srv/rivetos/work           # default: the workspace dir
      home: ~/.local/share/opencode    # optional OPENCODE_DATA_DIR override
```

Boot probes `opencode --version` and registers a rejecting executor carrying
the probe's reason when it fails, so a node without the binary says so
instead of going silent.

## Testing

`npm test` runs the shared executor-conformance suite plus opencode specifics
against a FAKE `opencode` binary writing an opencode-shaped transcript into a
throwaway data dir. The real binary is never invoked and the operator's
`~/.local/share/opencode` is never touched.
