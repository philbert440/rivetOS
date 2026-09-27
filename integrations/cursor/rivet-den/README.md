# rivet-den — Cursor adapter

Streams a Cursor IDE/CLI session into the den-protocol event stream. The hook
shim calls the shared Claude Code translator
(`integrations/claude-code/rivet-den/hooks/den-hook.mjs`) with `--harness cursor`
and maps Cursor events to the Claude Code spellings that switch understands.

## Install

Link the kit as a local plugin; its manifest wires `hooks/hooks.json`
(commands are relative to the plugin root):

```bash
ln -sfn "$PWD/integrations/cursor/rivet-den" ~/.cursor/plugins/local/rivet-den-cursor
```

If you wired den hooks into `~/.cursor/hooks.json` by hand, remove those
entries so events are not sent twice.

Requires a RivetOS checkout that includes the Claude Code den translator.
`RIVETOS_ROOT` overrides the checkout; otherwise the hook resolves it from its
own path and falls back to `/opt/rivetos`.

## Configuration (env, or `~/.rivetos/.env`)

- `RIVET_DEN_URL` — den-server base URL (default loopback http+https)
- `RIVET_DEN_TOKEN` — bearer token when the server has auth enabled
- `RIVET_DEN_NAME` — session display name (default: hostname)
- `RIVET_DEN_TERM=off` — don't send terminal lines at all

Hooks are best-effort and **always exit 0**: a den outage never disrupts Cursor.

## Events wired

| Cursor hook | Translator event |
| --- | --- |
| `sessionStart` | `SessionStart` |
| `sessionEnd` | `SessionEnd` |
| `beforeSubmitPrompt` | `UserPromptSubmit` |
| `postToolUse` | `PostToolUse` |
| `afterAgentResponse` | `AfterAgentResponse` (agent text; `stop` still owns `turn.end`) |
| `stop` | `Stop` |

## Privacy

Same policy as the Claude Code plugin: den access = session-transcript access.
Keep den-servers loopback or LAN + token-gated; set `RIVET_DEN_TERM=off` if
command output may carry credentials you do not control.
