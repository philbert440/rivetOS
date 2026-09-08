# Local mode — one laptop, one node

`rivetos local` stands up RivetOS on a single machine as both datahub and
agent node: embedded PGlite, a locally minted Rivet CA, the desktop identity
the RivetHub app expects, memory-capture plugins for whatever coding harnesses
are on PATH, and a user service that survives logout.

Bare `rivetos local` is `init` then `up`. Flags: `--yes`, `--provider`,
`--api-key`, `--port` (default 5174), `--pg-port` (default 5433), `--no-lan`,
`--no-service`, `--device <name>`, `--memory lite|full`.

## Contract

**The Postgres socket exists only while the node runs.** PGlite lives inside
the `rivetos start` process and listens on `127.0.0.1:5433` (or `--pg-port`).
`RIVETOS_PG_URL` in `~/.rivetos/.env` points at that socket. Stop the node and
the socket is gone — there is no separate database daemon.

**Capture is best-effort while the node is down.** Harness hooks that cannot
reach the socket fail open: they must not block the coding agent. Start the
node again and new turns capture as usual; nothing is backfilled automatically
in lite mode.

**Single owner.** `users.json` is a fail-closed file registry (`unmappedIsOwner:
false`) with one owner. Loopback traffic is the owner. Enrolled device certs
must appear in the owner's `devices` array or den refuses them.

**LAN TLS + enrollment.** Default bind is `0.0.0.0:5174` with a node leaf whose
SANs cover loopback, `localhost`, the current LAN IPv4s, and `<hostname>.local`.
The node cert is re-issued on every `init` because DHCP addresses move.
`--no-lan` binds `127.0.0.1` instead. The desktop app gets a pre-minted client
leaf under the RivetHub userData `mtls/` directory. `--device <name>` mints a
PKCS#12 at `~/.rivetos/devices/<name>.p12` and prints the passphrase once
(the QR flow in a later change replaces hand-minting). Off-loopback terminals
require that TLS material; validation rejects a LAN bind without it.

**Lite vs full memory.** Default `--memory lite` is capture + FTS/trigram
recall, no embed/compaction workers (`rivet.defer_embed_enqueue=on`).
`--memory full` leaves that GUC off and honors `RIVETOS_EMBED_URL` /
`memory.postgres.embed_endpoint` so the existing embedding worker can
backfill.

## Layout

| Path | Role |
|---|---|
| `~/.rivetos/config.yaml` | Generated config (`memory.postgres.embedded`, `den`, `mesh`, harness binaries) |
| `~/.rivetos/.env` | `RIVETOS_PG_URL`, `RIVETOS_SHARED_DIR`, `RIVETOS_ROOT`, API keys |
| `~/.rivetos/pglite` | PGlite data dir (WASM files) |
| `~/.rivetos/shared` | `RIVETOS_SHARED_DIR` — users.json, CA, filestore |
| `~/.rivetos/ca/root` | Offline-ish root key (this laptop only) |
| `~/.rivetos/shared/rivet-ca` | Intermediate + issued leaves (`chain.pem` for den, `ca-chain.pem` for CLI helpers) |
| `~/.rivetos/devices/<name>.p12` | Extra device bundles |

`RIVETOS_SHARED_DIR` is set to `~/.rivetos/shared` before any `sharedPath()`
call so this machine is a mesh of one, not a client of `/rivet-shared`.

## macOS

Linux installs a systemd **user** unit (`~/.config/systemd/user/rivetos.service`)
with `EnvironmentFile=~/.rivetos/.env` and tries `loginctl enable-linger`.

macOS installs `~/Library/LaunchAgents/dev.rivetos.node.plist` (`KeepAlive`,
`RunAtLoad`) and `launchctl bootstrap gui/$UID`. `--no-service` prints
`rivetos start` on any OS.

When `tmux` is not on PATH, `.env` gets `RIVETOS_DEN_TERM_MUX=none` so den
does not wait on a multiplexer.

Node ≥ 22 is enough for local mode (`rivetos init` still wants 24).

Windows is out of scope for v1 (WSL2 later). The identity-path helper still
knows `%APPDATA%\RivetHub` so a later port does not guess.

## Day-2 commands

```
rivetos local status     # den /healthz + embedded DB row + harness plugin rows
rivetos local backup     # PGlite dumpDataDir gzip → ~/.rivetos/backups/
                         # stop the node first (attach mode cannot dump)
rivetos local reset      # stop the service; delete pglite, config, env, CA, identities
rivetos local reset --yes
rivetos local up         # start the user service and wait for /healthz (60s)
```

Backup cannot run against a live owner: `handle.exec` is SQL, not a filesystem
dump. Stop the node (or run backup from it) so this process owns the engine.

Apps: [https://rivethub.io/apps](https://rivethub.io/apps). While the node is
up, `claude` / `grok` (and any other detected harness) capture into the local
memory store.
