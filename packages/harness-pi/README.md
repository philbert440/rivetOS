# @rivetos/harness-pi

The `pi` half of the harness control plane's task side: a
`HarnessExecutor` that runs a RivetOS task on the local pi coding-agent CLI
(`@earendil-works/pi-coding-agent`, bin `pi`), headlessly.

```
pi --print --mode json [--model m] [--session-id id | --session id]
   [--session-dir d] [--thinking low|medium|high|max] <prompt>
```

Not a provider plugin — there is no `LanguageModel` here and no
`providers.pi-cli` config slice in this package. It exists so `@rivetos/boot`
can register a real executor for harness id `pi`. The provider-plugin id
(owned elsewhere) is `pi-cli`.

## How a turn works

1. **Spawn.** One `pi --print --mode json` per turn, in a fixed `cwd`. The task
   scaffold (context, acceptance criteria, the `TASK_RESULT` fence contract) is
   prepended to the prompt: this package does not assume `--append-system`.
2. **Stream.** Print/JSON is the session JSONL (version 3) on stdout — a
   `session` line first (native UUID), then `message` lines whose assistant
   content is text / thinking / toolCall / toolResult — translated to den
   `message.agent` / `tool.start` / `tool.end`. The native id is canonicalized
   to `pi:<uuid>`.
3. **Reconcile.** If the stream carried no usage, after the child exits the
   executor reads the session jsonl under `~/.pi/agent/sessions/<cwd-bucket>/`
   and reports the turn's tokens from assistant `message.usage`. Post-hoc,
   because the process has exited: no tailing, no attribution race, no
   torn-read handling beyond skipping the one line a SIGKILL can damage.
4. **Steer.** Follow-up turns spawn `--session <native-id>`, so the whole task
   shares ONE pi session and its context. If pi refuses the resume, the turn
   retries once on a fresh session seeded with the task's rendered history.

## What it does not do

- **No cost.** Tokens only — no `cost` events, no `usage.costUsd`.
- **No structured-output schema.** No `--json-schema` is passed; the fenced
  `TASK_RESULT` block is the only structured channel.
- **No per-turn MCP injection.** Servers come from pi's own persistent config,
  shared with the interactive harness (no `--mcp-config` on the confirmed flag
  set).
- **No RPC / SDK drive.** pi also ships RPC (process integration) and SDK
  modes; this executor uses print/JSON one-shot only.
- **No `$PI_HOME`.** Data dir is `~/.pi/agent`. A configured `home` is passed
  as `--session-dir <home>/sessions` so tests can redirect the store.

## Config

```yaml
tasks:
  harnesses:
    pi:
      binary: /usr/local/bin/pi  # default: `pi` on PATH
      model: deepseek/deepseek-v4-flash  # optional; --model
      effort: high               # optional; --thinking
      cwd: /srv/rivetos/work     # default: the workspace dir
      home: ~/.pi/agent          # optional --session-dir redirect
```

Boot probes `pi --version` and registers a rejecting executor carrying the
probe's reason when it fails, so a node without the binary says so instead of
going silent. (Boot wiring is owned by another package.)

Fleet default backend: `deepseek/deepseek-v4-flash` (pi's built-in `deepseek`
provider, from `~/.pi/agent/settings.json`).

## Testing

`npm test` runs the shared executor-conformance suite plus pi specifics
against a FAKE `pi` binary writing a pi-shaped session jsonl into a throwaway
data dir. No provider tokens are spent and the operator's `~/.pi` is never
touched.
