# rivet-den event protocol — v1

The den is a live pixel-art diorama of an agent session. Harness adapters
(Claude Code plugin, Grok Build hooks, rivetos-native emitters) normalize what
the agent is doing into **AgentEvents**; a pure reducer folds those into
**RoomState**, which any renderer can draw. This package is that contract —
zero dependencies, no I/O.

## Envelope

Every event carries:

| field     | type   | required | meaning                                             |
|-----------|--------|----------|-----------------------------------------------------|
| `v`       | `1`    | yes      | protocol version                                    |
| `session` | string | yes      | stable session id — one den room per session        |
| `name`    | string | no       | human-readable session display name (sticky)        |
| `harness` | string | no       | producer: `claude-code`, `grok-build`, `rivetos`, … |
| `ts`      | number | no       | ms since epoch at emit time (drives session recency)|
| `type`    | string | yes      | event type (below)                                  |

Unknown `type` values and non-`v:1` events are rejected by `parseEvent()`;
servers should drop them (and log), never crash. New event types require a
protocol version bump only if they change the meaning of existing fields —
purely additive types are allowed within v1, and consumers must ignore types
they don't know.

## Event types

| type             | payload                              | effect on RoomState                                              |
|------------------|--------------------------------------|------------------------------------------------------------------|
| `session.start`  | `title`                              | reset room (log survives), set title                             |
| `session.end`    | —                                    | activity → `sleeping`, `ended: true`; room then ignores all but a new `session.start` |
| `task.plan`      | `tasks: string[]`                    | replace task list, activity → `writing_plan`                     |
| `task.check`     | `index`                              | mark task done                                                   |
| `activity`       | `activity`                           | set coarse activity directly, clears `tool`                      |
| `tool.start`     | `tool`, `activity?`                  | set `tool` to raw name; activity = supplied or `toolActivity()`  |
| `tool.end`       | `tool?`                              | clear `tool`, activity → `thinking`                              |
| `thinking.delta` | `text`                               | append to thought bubble (220-char sliding window)               |
| `thinking.end`   | —                                    | clear thought bubble                                             |
| `speech.stt`     | `active`                             | true: activity → `listening`; false: → `thinking`                |
| `message.user`   | `text`                               | append to conversation log                                       |
| `message.agent`  | `text`                               | set lastMessage, append to log, activity → `speaking`            |
| `term.line`      | `text`                               | append to desk terminal (last 6 lines)                           |

## Activities

`idle` · `thinking` · `searching_web` · `editing_code` · `running_command` ·
`writing_plan` · `listening` · `speaking` · `sleeping`

These nine are the guaranteed pose vocabulary — every sprite pack must cover
all of them. Per-tool animation is layered on top via `RoomState.tool`: the
renderer resolves a pose as **tool override → activity → `idle`**, so packs
without per-tool art keep working forever, and new tools degrade gracefully.

`tool.start.tool` is the harness's tool name **verbatim** (`Bash`,
`WebSearch`, `mcp:rivetos:memory_search`) — distinct from the envelope's
`name`, which is the session display name. Adapters should not translate
names; pack manifests do the mapping. When an adapter knows better than the
default `toolActivity()` heuristic, it may attach an explicit `activity`.

## Multi-session

`reduceDen` maintains one `RoomState` per `session` plus a `SessionInfo`
registry (id, sticky display name, harness, last-event timestamp).
`listSessions()` returns them most-recent-first — this backs the viewer's
session picker and the den-server session list API.

## Wire transport

Transport is defined by den-server (PR 3), not this package: adapters `POST
/hook` one JSON event per request; viewers receive the same JSON over
WebSocket. This package supplies `parseEvent` for the ingest edge.

## Versioning rules

- **v stays 1** for additive changes: new event types, new optional fields.
- **v bumps** when an existing field's type/semantics change or a type is
  removed. Servers translate old versions at the edge; the reducer only ever
  sees the current version.
