# @rivetos/provider-pi-cli

Pi CLI provider for the [pi](https://github.com/earendil-works/pi) harness
(`npm i -g @earendil-works/pi-coding-agent`). Each turn runs the local
`pi --print --mode json -- <prompt>` (print/JSON mode) and replays the runtime
event stream (text/thinking deltas, usage on `message_end`) as a turn. System
messages go out as `--append-system-prompt`. Stdin is ignored. Abort/cancel is
SIGTERM then SIGKILL after 3s. Per-conversation continuity via a session map in
`~/.rivetos/pi-cli-sessions.json`. Implements `aiSdkBridge()` (LanguageModelV3).

Two id-spaces (they do not match):

- **Provider-plugin id:** `pi-cli` (this package; `providers.pi-cli` in config)
- **Harness id:** `pi` (control-plane / `SessionId` token; owned by `@rivetos/harness-pi`)

pi talks to multiple LLM backends through **pi-ai**. The fleet default is
`deepseek/deepseek-v4-flash` (pi's built-in `deepseek` provider, from
`~/.pi/agent/settings.json`). Configure backends in pi's own config, then
point RivetOS at the `pi` binary.

```yaml
agents:
  pi:
    provider: pi-cli
providers:
  pi-cli:
    binary: pi                            # default `pi` on PATH, or $PI_BINARY
    home: /home/rivet/.pi/agent           # optional --session-dir <home>/sessions
    model: deepseek/deepseek-v4-flash     # --model
    cwd: /home/rivet/.rivetos/workspace
```
