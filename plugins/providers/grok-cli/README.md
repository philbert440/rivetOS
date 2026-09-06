# @rivetos/provider-grok-cli

Grok Build CLI provider for RivetOS. Shells out to the local `grok` binary for
every turn — `grok -p <prompt> --output-format json` — so `provider: grok-cli`
agents run on the user's Grok Build subscription (OIDC login in `~/.grok`), not
the metered xAI API. Sanctioned CLI-harness pattern, same shape as `claude-cli`.

This is what makes a grok agent answer mesh delegations (`delegate_task` from
another node), heartbeat tasks and chat on nodes that only have Grok Build.

## Config

```yaml
providers:
  grok-cli:
    binary: /home/rivet/.grok/bin/grok   # default: ~/.grok/bin/grok, then `grok` on PATH
    # model: grok-4.5                    # optional -m; omit for the CLI's configured model
    permission_mode: dontAsk             # tools denied unless `allow` rules say otherwise
    reasoning_effort: medium             # low|medium|high; per-turn `thinking` overrides
    max_turns: 1                         # 1 = answer only (no tool loop)
    no_plan: true
    system_prompt: prepend               # prepend | override | off
    session: resume                      # resume | replay
    cwd: /home/rivet/.rivetos/workspace
    # allow: [Read, Grep]                # --allow rules for tool-using turns (max_turns > 1)

agents:
  grok:
    provider: grok-cli
```

`system_prompt` decides how the RivetOS system prompt (persona + tool docs)
reaches grok: `prepend` puts it at the top of the prompt and keeps grok's own
system prompt (its tools, `~/.grok/AGENTS.md`, MCP servers such as the
rivet-memory plugin); `override` passes it as `--system-prompt-override`,
replacing grok's own; `off` drops it. The same mode applies on the first
turn and on later `--resume` turns.

`session` (default `resume`) keeps one Grok Build session per RivetOS
conversation. The first turn sends `--session-id <uuid>` (deterministic from
the conversation id) plus the full rendered transcript; later turns send
`--resume <id>` and only the newest `USER:` chunk. Ids live in
`~/.rivetos/grok-cli-sessions.json`; a successful JSON `sessionId` overwrites
the synthetic uuid when they differ. If `--resume` exits non-zero (session
gone), the provider falls back once to a fresh `--session-id` with the full
prompt. `replay` is the old behavior: full transcript every turn, no session
flags.

## What a turn looks like

The AI SDK loop hands the provider the whole conversation. In `resume` mode
that is rendered in full only on the first turn (`SYSTEM:` / `USER:` /
`ASSISTANT:` / `TOOL RESULT` sections); later turns pass the newest user
message and grok holds the history. grok runs once, and its JSON result is
replayed as stream parts: reasoning (`thought`), text, then `finish` with
token usage, `sessionId` and cost in `providerMetadata['grok-cli']`. Request
logs redact the `-p` prompt and `--system-prompt-override` text.

## Limits (v1)

- No incremental streaming — `--output-format json` arrives when grok finishes.
- No RivetOS tool bridge: grok cannot call `delegate_task`, `memory_*` etc. as
  RivetOS tools. It does have its own MCP servers from `~/.grok/config.toml`.
- Session capture of these runs is done by the rivet-memory Grok hooks
  (`~/.grok/hooks/rivet-memory.json`), not by this provider.
