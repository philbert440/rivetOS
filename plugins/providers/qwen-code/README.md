# @rivetos/provider-qwen-code

Qwen Code CLI provider for the [Qwen Code](https://github.com/QwenLM/qwen-code)
harness (`npm i -g @qwen-code/qwen-code`). Each turn runs the local
`qwen -p <prompt> --output-format stream-json --include-partial-messages
--approval-mode yolo` and replays the Claude-shaped stream-json wire (text /
thinking deltas, tool_use, usage) as a turn. System messages go out as
`--append-system-prompt`. Stdin is ignored. Abort/cancel is SIGTERM then
SIGKILL after 3s.

Per-conversation continuity via a session map in
`~/.rivetos/qwen-code-sessions.json`: the first turn pins `--session-id <uuid>`;
later turns pass `--resume <uuid>`. Sessions are cwd-scoped — the same
`providers.qwen-code.cwd` (default `~/.rivetos/workspace`) is used every turn.
If resume is rejected (`No saved session found with ID` and no `system/init`
line), the mapping is dropped and the turn retries once with a fresh
`--session-id`.

Provider-plugin id and harness id are the same: `qwen-code`. Model is optional;
when unset the CLI's configured default in `~/.qwen/settings.json` applies.

```yaml
agents:
  qwen:
    provider: qwen-code
providers:
  qwen-code:
    binary: qwen # default `qwen` on PATH, or $QWEN_BINARY
    home: /home/example/.qwen # accepted for parity; qwen data dir is ~/.qwen
    model: qwen-27b # optional -m
    cwd: /home/example/.rivetos/workspace
```
