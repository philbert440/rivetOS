# @rivetos/provider-kimi-code

Kimi Code CLI provider. Each turn runs the local `kimi -p <prompt> --output-format stream-json`
and replays the stream as a turn; per-conversation continuity via a session map in
`~/.rivetos/kimi-code-sessions.json`. Implements `aiSdkBridge()` (LanguageModelV3).

History: written 2026-08-18 and deployed untracked to ct116 WITHOUT a package.json, so boot never
discovered it (`Unknown provider type "kimi-code"`); committed to the repo 2026-09-05 with a
manifest. Plain CommonJS, no dependencies; `build` copies `src/index.cjs` to `dist/`.

```yaml
agents:
  kimi:
    provider: kimi-code
providers:
  kimi-code:
    binary: /home/rivet/.local/bin/kimi     # default ~/.local/bin/kimi or $KIMI_BINARY
    home: /home/rivet/.kimi                 # optional KIMI_HOME
    model: kimi-k2
    cwd: /home/rivet/.rivetos/workspace
```
