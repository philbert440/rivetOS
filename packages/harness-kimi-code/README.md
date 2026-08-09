# @rivetos/harness-kimi-code

The `kimi-code` half of the harness control plane's task side: a
`HarnessExecutor` that runs a RivetOS task on the local Kimi Code CLI,
headlessly.

```
kimi [-S <session_id>] [-m <model>] --output-format stream-json -p <prompt>
```

Not a provider plugin — there is no `LanguageModel` here and no
`providers.kimi-code` config slice. It exists so `@rivetos/boot` can register a
real executor for harness id `kimi-code`, where before it could only register
an honest rejection.

## How a turn works

1. **Spawn.** One `kimi -p` per turn, in a fixed `cwd`. The task scaffold
   (context, acceptance criteria, the `TASK_RESULT` fence contract) is
   prepended to the prompt: kimi has no `--append-system-prompt`.
2. **Stream.** `stream-json` gives assistant text, `tool_calls[]` and
   correlated `role:"tool"` results — translated to den `message.agent` /
   `tool.start` / `tool.end`. The final line, `session.resume_hint`, carries the
   native session id, canonicalized to `kimi-code:session_<uuid>`.
3. **Reconcile.** stream-json carries no usage and no result event, so after
   the child exits the executor reads the session's own `wire.jsonl`
   (`usage.record` per LLM request, `turn.ended` with a reason) and reports the
   turn's tokens from there. Post-hoc, because the process has exited: no
   tailing, no attribution race, no torn-read handling beyond skipping the one
   line a SIGKILL can damage.
4. **Steer.** Follow-up turns spawn `-S <native-id>`, so the whole task shares
   ONE kimi session and its context. If kimi refuses the resume (pruned
   session, or a different directory), the turn retries once on a fresh session
   seeded with the task's rendered history.

## What it does not do

- **No cost.** kimi records tokens, never money — no `cost` events, no
  `usage.costUsd`.
- **No structured-output schema.** No `--json-schema` on this CLI; the fenced
  `TASK_RESULT` block is the only structured channel.
- **No per-turn MCP injection.** No `--mcp-config`; servers come from
  `mcp.json` in `KIMI_CODE_HOME`, shared with the interactive harness.
- **No goal mode.** A prompt starting with `/goal` would put kimi into a
  different lifecycle; the scaffold always precedes the task's own text, so it
  cannot happen by accident.

## Config

```yaml
tasks:
  harnesses:
    kimi-code:
      binary: /usr/local/bin/kimi  # default: `kimi` on PATH
      model: moonshotai/kimi-k3    # optional
      effort: medium               # optional (KIMI_MODEL_THINKING_EFFORT)
      cwd: /srv/rivetos/work       # default: the workspace dir
      home: ~/.kimi-code           # optional KIMI_CODE_HOME override
```

Boot probes `kimi --version` and registers a rejecting executor carrying the
probe's reason when it fails, so a node without the binary says so instead of
going silent.

## Testing

`npm test` runs the shared executor-conformance suite plus kimi specifics
against a FAKE `kimi` binary writing a kimi-shaped transcript into a throwaway
`KIMI_CODE_HOME`. No Moonshot tokens are spent and the operator's
`~/.kimi-code` is never touched.
