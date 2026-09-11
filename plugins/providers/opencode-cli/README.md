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
xhigh/max→`max`. Usage is accumulated from `step_finish` `part.tokens`
(`input` + cache read/write in the input total). `isAvailable` probes
`opencode --version` (cached). Default `context_window` is 128000 (override
with `context_window`); this is the advertised provider window, not a z.ai
`[1m]` model id.

```yaml
agents:
  opencode:
    provider: opencode-cli
providers:
  opencode-cli:
    binary: opencode   # path or name on PATH; override with $OPENCODE_BINARY
    # home: /home/rivet/.local/share/opencode   # optional; only then overrides XDG_DATA_HOME
    model: zai/glm-5.3-flash
    cwd: /home/rivet/.rivetos/workspace
```
