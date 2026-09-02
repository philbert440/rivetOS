# rivet-den — Kimi Code CLI integration

Streams your Kimi Code CLI session into the den-protocol event stream: lifecycle
hooks translate prompts, tool calls, todo updates, compaction and turn
boundaries into rivet-den protocol events and POST them to den-server
(`/event` / `/events`). Drivers use that stream for session linkage and kimi tagging.

The translator is payload-first, like the sibling `rivet-memory` capture
worker: kimi hook payloads carry the prompt, tool name, tool input and tool
output directly, so nothing here tails a transcript.

## Install

Append `hooks/hooks.toml` to `~/.kimi-code/config.toml` (rewrite the
`/opt/rivetos` paths if RivetOS lives elsewhere), then `kimi doctor` to
validate. The hooks are self-contained — plain Node, no dependencies, no
rivetos runtime required.

Both this and `integrations/kimi/rivet-memory` can be wired on the same
events: kimi dedupes hooks per event by exact command string, and these
commands differ.

## Configuration (env, or `~/.rivetos/.env`)

- `RIVET_DEN_URL` — den-server base URL (default `http://127.0.0.1:5174`);
  comma-separated for fan-out to a local den _and_ the mesh hub
- `RIVET_DEN_TOKEN` — bearer token when the server has auth enabled
- `RIVET_DEN_NAME` — session display name shown in the viewer's picker
  (default: hostname)
- `RIVET_DEN_TERM=off` — don't send terminal lines at all (see below)
- `RIVETOS_DEN_HOOK_DISABLED=1` — stay silent entirely, for executor-owned
  sessions that already emit their own den events

Hooks are best-effort and always exit 0: a den outage can never disrupt the
session. Translator state (started flag, todo diff, turn stamp) lives under
`~/.cache/rivet-den/` and is cleaned up on SessionEnd. Events ship as one
ordered batch (`POST /events`); pre-batch servers get sequential `/event`
fallback.

## Session identity

Rooms key on the canonical `kimi-code:<native-session-id>`
(`docs/ARCHITECTURE.md § Session identity) — the same key the
rivet-memory capture worker writes, so the den room and the memory
conversation join on one identity instead of two.

kimi's native ids are `session_<uuidv4>`, i.e. UUID-class entropy, so plain
namespacing satisfies the contract's collision-resistance rule; no extra
salting is needed. The one exception is a payload with no `session_id` at all
(possible on the older in-process hook engine, which injects an empty string):
that path mints `unknown-<16 hex>` once and caches it under a key derived from
the session's `cwd`, so the id is high-entropy and stable across the session's
hook fires. Not keyed on pid: kimi spawns hooks with `shell: true, detached:
true` and the shell does not exec, so every fire gets a fresh shell and a fresh
node — no pid survives from one fire to the next. The trade is that two
concurrent id-less sessions in one directory would share a room, which is
acceptable for a path that only triggers when the harness fails to identify
itself at all. The cache file is removed on SessionEnd.

`RIVET_DEN_SESSION`, injected by the den-server PTY spawner, is already
canonical and is used verbatim.

Every event ALSO carries kimi's own session id in `harnessSession`, alongside
the room key in `session`. The two are the same string only when this hook
picked the room itself; under `RIVET_DEN_SESSION` the room is a key den chose,
and kimi has no flag to be told what to call its session (`-S/--session`
resumes an existing one; there is no `--session-id`), so both ids have to
travel. The `kimi-code` HarnessDriver keys sessions on `harnessSession` — the
same optional envelope field the hermes hook uses, for the same reason — so a
den-spawned kimi is a room the control plane can name a session for. A payload
with no `session_id` reports no `harnessSession` at all: the fallback room key
is a translator invention, and echoing it as a store id would send the driver
looking for a session kimi never created.

## Event mapping

kimi 0.34 defines **20** hook events (`HOOK_EVENT_TYPES` in the shipped CLI).
Twelve are wired; the other eight are deliberately unmapped and unwired, so
their hooks never even start.

| kimi event                               | payload it carries                                                                                                                           | den emission                                                                                                                                                                                 |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SessionStart`                           | `source`, `session_title`, `model`, `profile`                                                                                                | none — stashes the title; the room opens on the first human prompt (anti-ghost-room gate)                                                                                                    |
| `UserPromptSubmit`                       | `prompt`, `is_steer`, `session_title`                                                                                                        | `session.start` on the first fire, then `message.user` + the `speech.stt` pair; stamps the turn                                                                                              |
| `TurnStarted`                            | `turn_id`, `origin_kind`, `origin_name`, `prompt`                                                                                            | `activity{thinking}` only — the prompt is NOT re-emitted (it would double every user bubble); this is the turn stamp for non-user origins                                                    |
| `PreToolUse`                             | `tool_name`, `tool_input`, `tool_call_id`                                                                                                    | `tool.start` (+ summarized, redacted args); `Bash` also mirrors the command to the desk terminal. `TodoList` poses `writing_plan` instead                                                    |
| `PostToolUse`                            | + `tool_output` (pre-rendered text, capped at 2k)                                                                                            | `tool.end`; shell output tail and `✎ <file>` on the terminal. `TodoList` drives `task.plan`/`task.check` and emits no `tool.end`                                                             |
| `PostToolUseFailure`                     | + `error{code,message,retryable}` (plus `name`/`details` when the throw was an `Error`; a non-`Error` throw has no `name`), no `tool_output` | same, plus `✗ <tool>: <message>`                                                                                                                                                             |
| `Stop`                                   | `stop_hook_active`                                                                                                                           | `thinking.end` + `turn.end`                                                                                                                                                                  |
| `StopFailure`                            | `error_type`, `error_message`                                                                                                                | `✗ turn failed: …` + `thinking.end` + `turn.end`                                                                                                                                             |
| `Interrupt`                              | `turn_id`, `reason`                                                                                                                          | `thinking.end` + `turn.end` — `Stop` does not fire on a cancelled turn, so this _is_ the boundary                                                                                            |
| `PreCompact`                             | `trigger`, `token_count`                                                                                                                     | `thinking.end` + `activity{sleeping}`                                                                                                                                                        |
| `PostCompact`                            | `trigger`, `estimated_token_count`                                                                                                           | `activity{thinking}`                                                                                                                                                                         |
| `SessionEnd`                             | `reason`, `session_title`                                                                                                                    | `session.end`, state file removed                                                                                                                                                            |
| `UserPromptQueued`                       | `prompt_id`, `prompt`, `queue_length`                                                                                                        | **not mapped** — a queued prompt fires `UserPromptSubmit` when it is actually submitted; emitting here would double the bubble                                                               |
| `SubagentStart` / `SubagentStop`         | `agent_name`, `prompt` / `response`                                                                                                          | **not mapped** — subagents are spawned by the `Agent` tool, which already produces the `PreToolUse`/`PostToolUse` pair. Mapping these too would leave the room holding two overlapping tools |
| `PermissionRequest` / `PermissionResult` | tool + decision                                                                                                                              | **not mapped** — protocol v1 has no approval surface, and the following `PostToolUse`/`PostToolUseFailure` already carries the outcome                                                       |
| `TaskStarted`                            | `task_id`, `kind`, `description`, …                                                                                                          | **not mapped** — background-task lifecycle has no v1 den surface                                                                                                                             |
| `SessionHeartbeat`                       | `uptime_ms`                                                                                                                                  | **not mapped** — pure recency churn every 60s; leaving it unwired also means kimi never starts the heartbeat timer                                                                           |
| `Notification`                           | `notification_type`, `title`, `body`, …                                                                                                      | **not mapped** — the CLI's own UI surfaces these                                                                                                                                             |

Payload casing: kimi snake_cases every **top-level** hook field on the way out
(`toHookInputData` runs camelToSnake over the whole record), so the snake
spellings above are the real ones. `tool_input` is passed through verbatim, so
its _inner_ keys are whatever the tool's schema uses — `command` for `Bash`,
`path` for `Read`/`Edit`/`Write`/`Grep`/`Glob`. The accessors accept camelCase
anyway, and the tests cover both.

A few tool spellings the translator also answers to — `Shell` (`cmd`),
`MultiEdit`/`NotebookEdit`, `file_path`/`filePath`, `TodoWrite` — are
**defensive aliases, not kimi 0.34 tools**: its set is `Bash`, `Read`, `Edit`,
`Write`, `Grep`, `Glob`, `TodoList`, `Agent`, `Skill`, `Task*` and
`mcp__<server>__<tool>`. They cost nothing, they cover older releases and
MCP-provided lookalikes (one `Shell` call does appear in captured history), and
the tests pin them so they cannot rot into dead code.

## What the den does not show

**No assistant replies.** kimi's `Stop` payload is `{ stop_hook_active }` and
nothing else — no reply text, no usage, no model. There is no `message.agent`
to emit, and the hook does not invent one: a den room shows the user's prompts,
the tools, the plan and the terminal, and the chat side of the room stays
one-sided.

Two other consequences of the same gap: there is no thinking text (kimi does
not expose it to hooks either), and no token accounting on turns.

The `kimi-code` HarnessDriver, which landed after this integration, does not
paper over any of it — it emits no `assistant-delta` and no `reasoning-delta`,
because there is no event to fold. What it adds is the other route to the same
text: `GET .../transcript` reads kimi's own `wire.jsonl`, whose `content.part`
records carry the reply (`text`) and the thinking (`think`) verbatim, plus
per-turn usage and a real `isError` per tool. A hard-resync therefore shows the
full conversation that the live room cannot. Streaming those deltas from a
transcript watch is the documented follow-up (see
`docs/ARCHITECTURE.md § Four harness drivers).

## What the den does show — read this before pointing it anywhere shared

**The den displays your session's actual content**: prompt text and — on the
desk terminal — real command lines and the tail of their output. Anyone who
can reach the den-server sees it. The translator redacts obvious secret shapes
(`KEY=…`/`token: …` values, `Bearer` headers, AWS/GitHub/Slack/`sk-` style
tokens) from terminal lines and tool args, but that is best-effort pattern
matching, **not** a security boundary — a secret echoed in an unrecognized
shape goes through verbatim.

Policy: treat den access = session-transcript access. Keep den-servers
loopback or LAN + token-gated; set `RIVET_DEN_TERM=off` if command output on
your machine may carry credentials you don't control.

## Tests

`npm test` (from this directory) spawns the real hook against a stand-in
den-server with a temp `HOME`, using recorded-shape fixtures in both casings —
gating, prompt extraction, tool pairing, whiteboard diffs, turn boundaries,
session identity and the kill switch.

## Open items for whoever deploys this

The event map above was derived from kimi 0.34.0's own hook dispatcher plus
captured payloads; two things are worth re-confirming on the box before
trusting them on a future release:

- **Payload fields per event.** Add one throwaway `[[hooks]]` entry per event
  with `command = "sh -c 'tee -a /tmp/kimi-hooks.jsonl >/dev/null'"`, run a
  session that exercises tools, compaction and an interrupt, then:
  `jq -s 'group_by(.hook_event_name)|map({event:.[0].hook_event_name, fields:(map(keys)|add|unique)})' /tmp/kimi-hooks.jsonl`
- **Whether `Stop` ever gains a reply field.** Today it does not:
  `grep -c 'no messages extracted from Stop' ~/.rivetos/kimi-memory-capture.log`
  counts the capture worker hitting the same wall. If a future release adds
  one, `message.agent` becomes a two-line change here.
