# @rivetos/provider-pi-cli

Pi CLI provider for the [pi](https://github.com/earendil-works/pi) harness
(`npm i -g @earendil-works/pi-coding-agent`). Each turn runs the local
`pi -p <prompt> --mode json` (print/JSON mode) and replays the stream as a
turn; per-conversation continuity via a session map in
`~/.rivetos/pi-cli-sessions.json`. Implements `aiSdkBridge()` (LanguageModelV3).

Two id-spaces (they do not match):

- **Provider-plugin id:** `pi-cli` (this package; `providers.pi-cli` in config)
- **Harness id:** `pi` (control-plane / `SessionId` token; owned by `@rivetos/harness-pi`)

pi talks to multiple LLM backends through **pi-ai**. The fleet default is
**z.ai GLM** (reuse the existing coding-plan key / Anthropic-compat endpoint
already on this box). Configure that in pi's own config, then point RivetOS
at the `pi` binary.

```yaml
agents:
  pi:
    provider: pi-cli
providers:
  pi-cli:
    binary: /home/rivet/.local/bin/pi     # default ~/.local/bin/pi or $PI_BINARY
    home: /home/rivet/.pi                 # optional PI_HOME
    model: glm-5.3-flash                  # --model; fleet default z.ai GLM
    cwd: /home/rivet/.rivetos/workspace
```
