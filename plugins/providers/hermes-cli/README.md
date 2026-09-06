# @rivetos/provider-hermes-cli

Hermes Agent CLI provider. Each turn runs the local `hermes chat -q <prompt> -Q --yolo --cli`
(quiet mode: stdout carries the final answer and the session id), so the agent gets Hermes's
own tools, skills, memory plugin and model config (`~/.hermes/config.yaml`, e.g. qwen-27b on the
inference box). Per-conversation continuity via `--resume` with a session map in
`~/.rivetos/hermes-cli-sessions.json`. Implements `aiSdkBridge()` (LanguageModelV3) so the
RivetOS agent loop drives it via `streamText`.

History: written 2026-08-18 and deployed untracked to ct113/ct114 (survived every
`git reset --hard` deploy); ported to TypeScript and committed 2026-09-05 (typed against @ai-sdk/provider LanguageModelV3), behavior unchanged.

```yaml
agents:
  hermes:
    provider: hermes-cli
providers:
  hermes-cli:
    name: Hermes Agent (local qwen-27b)
    binary: /home/rivet/.local/bin/hermes   # default ~/.local/bin/hermes or $HERMES_BINARY
    model: custom/qwen-27b
    cwd: /home/rivet/.rivetos/workspace
    context_window: 262144
    max_output_tokens: 81920
```
