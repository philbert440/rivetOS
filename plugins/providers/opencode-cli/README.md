# @rivetos/provider-opencode-cli

OpenCode CLI provider. Each turn runs the local
`opencode run --format json [-m model] [--variant v] [-s id] <prompt>`
and replays JSON text parts as a turn; per-conversation continuity via a
session map in `~/.rivetos/opencode-cli-sessions.json`. Implements
`aiSdkBridge()` (LanguageModelV3).

Provider id is `opencode-cli`; harness id is `opencode` (they do not match — same split
as `claude-cli` / `claude-code`).

Default backend on our fleet: opencode is configured for z.ai GLM. The `model`
field below is optional if the CLI's own config already pins GLM. The `[1m]`
suffix is not valid on z.ai.

`--variant` maps RivetOS effort: low→`minimal`, medium→omit, high→`high`,
xhigh/max→`max`. Usage is taken from the assistant message envelope
`tokens{input,output,reasoning,cache{read,write}}`. `isAvailable` probes
`opencode --version` (cached).

```yaml
agents:
  opencode:
    provider: opencode-cli
providers:
  opencode-cli:
    binary: /home/rivet/.local/bin/opencode   # default ~/.local/bin/opencode or $OPENCODE_BINARY
    home: /home/rivet/.local/share/opencode   # data dir; sets XDG_DATA_HOME
    model: zai/glm-5.3-flash
    cwd: /home/rivet/.rivetos/workspace
```
