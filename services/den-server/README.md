# den-server

Per-node service for **rivet-den**: adapters push protocol events in, viewers
get a state snapshot plus the live stream out. State is held in the pure
`@rivetos/den-protocol` reducer, so late-joining viewers are caught up with a
single snapshot instead of replayed events.

## API

| endpoint                  | method | purpose                                            |
|---------------------------|--------|----------------------------------------------------|
| `/event`                  | POST   | one `AgentEvent` (JSON) per request, 422 on invalid |
| `/sessions`               | GET    | recency-ordered session list                       |
| `/state?session=<id>`     | GET    | RoomState snapshot                                 |
| `/layout?viewer=<key>`    | GET/POST | per-viewer layout store; GET falls back to `default` |
| `/mesh.json`              | GET    | den-enabled mesh nodes + probed den health (see docs/DEN.md “Mesh view”) |
| `/term/config`            | GET    | terminal roster — keys + labels only, never argv/cwd/env |
| `/term`                   | POST   | spawn a roster command in a PTY (opt-in; `{command?, cols?, rows?}`) |
| `/term/list`              | GET    | live + recently-exited PTYs                        |
| `/term?id=<id>`           | DELETE | kill a PTY (SIGHUP, SIGKILL after 3 s)             |
| `/ws?session=<id>`        | WS     | snapshot message, then live events (no param = all sessions) |
| `/packs/*`                | GET    | static SpritePacks when `RIVETOS_DEN_PACKS_DIR` set |
| `/*`                      | GET    | built viewer app when `RIVETOS_DEN_STATIC_DIR` set |
| `/healthz`                | GET    | liveness — never auth-gated                        |

## Configuration (env)

On RivetOS-managed nodes these come from `~/.rivetos/den.env`, which
`rivetos update` GENERATES from the `den:` section of `~/.rivetos/config.yaml`
— edit the config, not the env file (see Deploy below).

- `RIVETOS_DEN_PORT` (5174) / `RIVETOS_DEN_HOST` (127.0.0.1 — loopback
  fail-safe; set `0.0.0.0` to serve the LAN, ideally with a token)
- `RIVETOS_DEN_TOKEN` — when set, every endpoint except `/healthz` requires
  `Authorization: Bearer <token>` (or `?token=` for browser WebSockets).
  Optional on trusted mesh nodes; required for anything internet-facing.
- `RIVETOS_DEN_STATE_DIR` (`~/.rivetos/den`) — layout persistence
- `RIVETOS_DEN_STATIC_DIR` / `RIVETOS_DEN_PACKS_DIR` — optional static roots
- `RIVETOS_DEN_MESH_FILE` — mesh roster for `/mesh.json`; empty tries
  `/rivet-shared/mesh.json` then `~/.rivetos/mesh.json`
- `RIVETOS_DEN_MESH_CACHE_MS` (10000) — `/mesh.json` result cache TTL
- `RIVETOS_DEN_NODE_ID` (hostname) — this node's id in the roster, used to
  attach `latest` to the local entry

## Terminals (opt-in)

`RIVETOS_DEN_TERM=1` lets the den spawn local PTYs running harness CLIs
(claude / grok / hermes / shell by default) so the viewer can open terminals.
This puts a shell running as the service user behind the HTTP API, so the
posture is deliberately strict:

- **Off by default.** Terminals only exist when `RIVETOS_DEN_TERM=1`/`on`.
- **Token-gated off loopback.** If the host is not `127.0.0.1`/`::1`/
  `localhost` and `RIVETOS_DEN_TOKEN` is empty, terminals are forced off at
  startup (loud log, term endpoints answer 503; the event relay keeps
  running).
- **Roster keys only over the wire.** The API accepts only command keys from
  the operator-owned roster (`RIVETOS_DEN_TERM_CONFIG`, default
  `~/.rivetos/den-term.json`, re-read lazily — no restart needed). Each entry
  is an argv array spawned directly, never through a shell. `/term/config`
  never exposes argv/cwd/env.
- **Audited.** Every spawn/kill/exit appends a JSON line to
  `$RIVETOS_DEN_STATE_DIR/term-audit.log`.

Roster file shape:

```json
{
  "default": "claude",
  "cwd": "/home/rivet",
  "env": { "FOO": "bar" },
  "commands": {
    "claude": { "label": "Claude Code", "cmd": ["claude"], "room": true },
    "shell":  { "label": "Shell", "cmd": ["bash", "-l"], "room": false }
  }
}
```

`room: true` marks a den-aware harness: if its process exits without having
sent `session.end`, the server ingests a synthetic one so the room closes.
`room: false` entries never produce synthetic events. Spawned PTYs get
`RIVET_DEN_SESSION` / `RIVET_DEN_URL` / `RIVET_DEN_TOKEN` / `RIVET_DEN_NAME`
in their env so harness hook adapters report into the right room.

Knobs: `RIVETOS_DEN_TERM_MAX` (4 concurrent PTYs),
`RIVETOS_DEN_TERM_SCROLLBACK` (262144 bytes per PTY),
`RIVETOS_DEN_TERM_DETACHED_TTL_MS` (1800000 — unattached PTYs are reaped),
`RIVETOS_DEN_TERM_EXIT_LINGER_MS` (60000 — exited records linger for
inspection). `node-pty` is an optional dependency; when it failed to
install, term endpoints answer 503 and everything else works.

## Deploy

On RivetOS nodes the den is config-driven: set `den.enabled: true` (plus
host/port/token/terminal) in `~/.rivetos/config.yaml` and run
`rivetos update`. The update builds this package, installs/refreshes
`rivet-den.service`, generates `~/.rivetos/den.env` from the config, rebuilds
`node-pty` when terminals are enabled, restarts the unit, and probes
`/healthz`. Full flow, node-pty ABI runbook, and the terminal security model:
[docs/DEN.md](../../docs/DEN.md), "Deploying with RivetOS".

On non-RivetOS hosts, `rivet-den.service` is the systemd unit (there,
`~/.rivetos/den.env` is yours to hand-edit). Harness adapters (Claude Code
plugin, Grok Build hooks, rivetos-native emitters) live in `integrations/`
and the core harness layer — they translate harness activity into protocol
events and POST here.
