# Local mode — one laptop, one node

The supported install is the published one-liner (stable channel on the
production server):

```bash
curl -fsSL https://get.rivethub.io/local.sh | bash
```

That fetches [get.rivethub.io/local.sh](https://get.rivethub.io/local.sh) and
clones the `local_ref` pin from
[pins/stable.json](https://get.rivethub.io/pins/stable.json). First-install
desktop/Android bits are on [rivethub.io](https://rivethub.io/). Dev/nightly
app builds stay on the mesh share `/rivet-shared/builds/rivethub/` (in-app
Updates). GitHub tags are source pins, not the app update feed.

`rivetos local` (what the installer runs) stands up RivetOS on a single
machine as both datahub and agent node: embedded PGlite, a locally minted
Rivet CA, the desktop identity the RivetHub app expects, memory-capture
plugins for whatever coding harnesses are on PATH, and a user service that
survives logout.

Bare `rivetos local` is `init` then `up`. Flags: `--yes`, `--provider`,
`--api-key`, `--port` (default 5174), `--pg-port` (default 5433), `--no-lan`,
`--no-service`, `--device <name>`, `--memory lite|full`, `--out` (backup
destination). `rivetos local up` waits on the persisted `den.port` unless
`--port` is passed again.

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
`--no-lan` binds `127.0.0.1` instead (still HTTPS) and sets `advertise_mdns:
false`. The desktop app gets a pre-minted client
leaf under the RivetHub userData `mtls/` directory. `--device <name>` mints a
PKCS#12 at `~/.rivetos/devices/<name>.p12` and prints the passphrase once
(the QR flow in a later change replaces hand-minting). Off-loopback terminals
require that TLS material; validation rejects a LAN bind without it.

**Lite vs full memory.** Default `--memory lite` is capture + FTS/trigram
recall, no embed/compaction workers (`rivet.defer_embed_enqueue=on`). It
clears a persisted `RIVETOS_EMBED_URL` so an inherited embed endpoint cannot
silently enable full mode. `--memory full` requires `RIVETOS_EMBED_URL` (error
if unset) and writes `memory.postgres.embed_endpoint` so the embedding worker
can backfill.

**Requires a source checkout.** `scripts/rivet-ca.sh` is not in the published
`@rivetos/cli` tarball. `rivetos local` must run from a rivetOS git clone
(or with `RIVETOS_ROOT` pointing at one).

The mesh agent channel binds `127.0.0.1:18789` in local mode (not `:3000` on
all interfaces). The node leaf is `issued/<hostname>.crt`, matching
`mesh.node_name` and `den.tls_cert` / `den.tls_key`.

## Layout

| Path                            | Role                                                                                                  |
| ------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `~/.rivetos/config.yaml`        | Generated config (`memory.postgres.embedded`, `den`, `mesh`, harness binaries)                        |
| `~/.rivetos/.env`               | `RIVETOS_PG_URL`, `RIVETOS_SHARED_DIR`, `RIVETOS_ROOT`, API keys (mode 0600; rewritten on every init) |
| `~/.rivetos/pglite`             | PGlite data dir (WASM files)                                                                          |
| `~/.rivetos/shared`             | `RIVETOS_SHARED_DIR` — users.json, CA, filestore                                                      |
| `~/.rivetos/ca/root`            | Offline-ish root key (this laptop only)                                                               |
| `~/.rivetos/shared/rivet-ca`    | Intermediate + issued leaves (`chain.pem` for den, `ca-chain.pem` for CLI helpers)                    |
| `~/.rivetos/devices/<name>.p12` | Extra device bundles                                                                                  |

`RIVETOS_SHARED_DIR` is set to `~/.rivetos/shared` before any `sharedPath()`
call so this machine is a mesh of one, not a client of `/rivet-shared`.

## macOS

Linux installs a systemd **user** unit (`~/.config/systemd/user/rivetos.service`)
with `EnvironmentFile=~/.rivetos/.env` and tries `loginctl enable-linger`.

macOS installs `~/Library/LaunchAgents/dev.rivetos.node.plist` (`KeepAlive`,
`RunAtLoad`, mode 0600) and `launchctl enable` then `launchctl bootstrap gui/$UID`
(so a previous `reset` disable can reinstall). Logs go to `~/.rivetos/logs/`.
Both the systemd unit and the plist include `PATH` with the node directory and
`~/.local/bin`. `--no-service` prints a prepared banner (run `rivetos start`)
with desktop/LAN/device URLs and does not wait on healthz or claim the hub is
up. LAN URLs omit bridge/VPN/docker interfaces; those addresses can still
appear on the node cert.

When `tmux` is not on PATH, `.env` gets `RIVETOS_DEN_TERM_MUX=none` so den
does not wait on a multiplexer.

Node ≥ 22 is enough for local mode (`rivetos init` still wants 24).

Windows is out of scope for v1 (WSL2 later). The identity-path helper still
knows `%APPDATA%\RivetHub` so a later port does not guess.

## Day-2 commands

```
rivetos local status     # den /healthz + embedded DB row + harness plugin rows
rivetos local backup [--out path]  # PGlite dumpDataDir gzip → ~/.rivetos/backups/
                                   # stop the node first (attach mode cannot dump)
rivetos local reset      # stop AND disable the service; delete pglite, config, env, CA
                         # under ~/.rivetos (RivetHub mtls and backups are kept).
                         # Refuses if any deletion-target data dir has a live owner lock.
rivetos local reset --yes
rivetos local up [--port N]  # restart the user service and wait for /healthz (60s)
                             # port defaults to den.port in config.yaml
```

Backup cannot run against a live owner: `handle.exec` is SQL, not a filesystem
dump. Stop the node first so this process owns the engine. Tarballs are created
mode 0600 (temp file + rename), not chmod after a world-readable write.
Re-running `init` rewrites `.env` so `--pg-port` / `--api-key` cannot
split-brain against `config.yaml`. Linux `up` uses `systemctl --user restart`
so renewed certs and config apply.

Apps: [https://rivethub.io/apps](https://rivethub.io/apps). While the node is
up, `claude` / `grok` (and any other detected harness) capture into the local
memory store.
