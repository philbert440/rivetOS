# @rivetos/provider-opencode-cli

OpenCode CLI provider. Each turn runs the local `opencode run <prompt> --format json`
and replays JSON text parts as a turn; per-conversation continuity via a session map in
`~/.rivetos/opencode-cli-sessions.json`. Implements `aiSdkBridge()` (LanguageModelV3).

Provider id is `opencode-cli`; harness id is `opencode` (they do not match — same split
as `claude-cli` / `claude-code`).

Default backend on our fleet: opencode is configured for z.ai GLM (Anthropic-compatible
endpoint, existing coding-plan key). The `model` field below is optional if the CLI's
own config already pins GLM.

```yaml
agents:
  opencode:
    provider: opencode-cli
providers:
  opencode-cli:
    binary: /home/rivet/.local/bin/opencode   # default ~/.local/bin/opencode or $OPENCODE_BINARY
    home: /home/rivet/.local/share/opencode   # optional OPENCODE_CONFIG_DIR
    model: zai/glm-5.3-flash                  # REVIEWER-CONFIRM: exact model id string
    cwd: /home/rivet/.rivetos/workspace
```
