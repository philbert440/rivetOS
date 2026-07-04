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
| `/ws?session=<id>`        | WS     | snapshot message, then live events (no param = all sessions) |
| `/packs/*`                | GET    | static SpritePacks when `RIVETOS_DEN_PACKS_DIR` set |
| `/*`                      | GET    | built viewer app when `RIVETOS_DEN_STATIC_DIR` set |
| `/healthz`                | GET    | liveness — never auth-gated                        |

## Configuration (env)

- `RIVETOS_DEN_PORT` (5174) / `RIVETOS_DEN_HOST` (0.0.0.0)
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

## Deploy

`rivet-den.service` is the systemd unit (drop env overrides in
`~/.rivetos/den.env`). Harness adapters (Claude Code plugin, Grok Build
hooks, rivetos-native emitters) live in `integrations/` and the core harness
layer — they translate harness activity into protocol events and POST here.
