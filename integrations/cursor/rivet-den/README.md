# rivet-den — Cursor adapter

Streams a Cursor IDE/CLI session into the den-protocol event stream. The hook
shim calls the shared Claude Code translator
(`integrations/claude-code/rivet-den/hooks/den-hook.mjs`) with `--harness cursor`
and maps Cursor events to the Claude Code spellings that switch understands.

## Install

The Cursor CLI does not scan `~/.cursor/plugins/local/`. Wire the hooks
globally by adding one entry per event in `hooks/hooks.json` to
`~/.cursor/hooks.json`, with the absolute script path:

```json
{ "command": "/path/to/rivetos/integrations/cursor/rivet-den/bin/cursor-den-hook.sh sessionStart", "timeout": 5 }
```

Or load the kit as a plugin for a session (its manifest wires
`hooks/hooks.json`; commands are relative to the plugin root):

```bash
agent --plugin-dir integrations/cursor/rivet-den
```

Use one form, not both. When the workspace is `$HOME`, the CLI loads
`~/.cursor/hooks.json` twice; the hook drops the second delivery of an
identical event + payload (markers under `~/.rivetos/cursor-hook-seen/den`).

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
