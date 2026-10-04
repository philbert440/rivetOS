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
app builds stay on the mesh update share your deployment publishes for
in-app Updates. GitHub tags are source pins, not the app update feed.

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
PKCS#12 at `~/.rivetos/devices/<name>.p12` and, once den is up, shows a
pairing QR for RivetHub Android (gateway URL on the first LAN address, a
one-time token, the SHA-256 of den's TLS leaf). The phone pins that leaf and
redeems the token at `POST /api/devices/pair` for the p12 + passphrase; den
deletes the p12 and the record (`~/.rivetos/devices/pairing/<name>.json`) on
redemption. Codes expire after 10 minutes; re-run to get a new one
(`rivetos local up --device <name>` re-shows a still-unredeemed code). The
issued leaf key is removed once it is inside the p12, so the p12 is the only
copy on the computer; the certificate stays in `issued/` so `rivet-ca.sh
revoke device:<name>` can find it (an expired, never-redeemed code takes its
certificate with it). Showing a code again always issues a new token, so an
old photo of a QR never works. With `--no-lan`, or no LAN address, there is
no QR: `local` prints the p12 path and passphrase instead for a manual import
(Enroll → import a certificate file), and drops the pairing record so den
does not delete the p12 while you copy it. Off-loopback terminals
require that TLS material; validation rejects a LAN bind without it.

**Pairing a phone on a node that is not a local install.** `rivetos local`
rewrites `config.yaml` for a single machine, so on a mesh node (for example one
whose memory lives on a datahub) use `rivetos pair <name>` instead. It mints the
p12 from the same CA, adds `<name>` to the owner's devices in `users.json`
(`--user <id>` for another user), writes the pairing record and prints the QR,
pinning the certificate `den.tls_cert` names. The QR points at `--host`, else
`den.host` when den is bound to one address, else the first LAN address. It
never writes `config.yaml`. A name that already has a certificate is refused,
so an enrolled device's key is never touched (revoke it with
`scripts/rivet-ca.sh revoke device:<name>`, then delete
`issued/device-<name>.crt` to reuse the name); re-running for a still-pending
name re-shows the code with a new token.
Den reads `users.json` at startup, so restart den after pairing a new name
(Settings → Pair a phone reloads it for you). `rivetos pair --check` reports
whether this node can pair a phone without minting anything.

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

## SQLite instead of embedded Postgres

`rivetos local init --db sqlite` sets the node up without any database
process. Memory lives in `~/.rivetos/memory.sqlite` and tasks in
`~/.rivetos/tasks.sqlite`; the config carries `memory.sqlite` and
`tasks.sqlite_path` in place of `memory.postgres.embedded`, the SQLite memory
plugin is loaded in place of the Postgres one, and no `RIVETOS_PG_URL` is
written. The default is unchanged: without `--db`, local mode uses embedded
PGlite.

What a SQLite node has: capture from the harness hooks, search (full-text,
and hybrid with `--memory full` and an embedding endpoint), summaries, wiki
and tag suggestions when a summarization endpoint is set
(`RIVETOS_COMPACTOR_URL` / `RIVETOS_COMPACTOR_MODEL`), the hub's Memory pages,
and the memory tools. See the `memory.sqlite` section of
[CONFIG-REFERENCE.md](CONFIG-REFERENCE.md).

- `rivetos local status` reports the memory file and its size.
- `rivetos local backup` writes a consistent copy of the memory file
  (`VACUUM INTO`) to `~/.rivetos/backups/memory-<stamp>.sqlite`. The node can
  keep running.
- `rivetos local reset` removes the SQLite files under `~/.rivetos`,
  including the per-user files in `users/`. A file the config keeps elsewhere
  is left alone.
- `rivetos memory export` and `rivetos memory import` move a store between a
  SQLite node and a Postgres one in either direction (same dump format).
  Each of the two works on **one file**, the node owner's unless `--sqlite
  <file>` names another: on a node with other users, export each user's file
  under `users/<userId>/` with `--sqlite <that file>`. `rivetos local backup`
  copies every store: the owner's file and each user's, as
  `memory-<stamp>.sqlite` and `memory-<stamp>.user-<userId>.sqlite`.

## Layout

| Path                            | Role                                                                                                  |
| ------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `~/.rivetos/config.yaml`        | Generated config (`memory.postgres.embedded`, `den`, `mesh`, harness binaries)                        |
| `~/.rivetos/.env`               | `RIVETOS_PG_URL`, `RIVETOS_SHARED_DIR`, `RIVETOS_ROOT`, API keys (mode 0600; rewritten on every init) |
| `~/.rivetos/pglite`             | PGlite data dir (WASM files)                                                                          |
| `~/.rivetos/memory.sqlite`      | `--db sqlite`: the memory file (with `-wal` / `-shm` beside it); other users' files under `users/`    |
| `~/.rivetos/tasks.sqlite`       | `--db sqlite`: the task engine's file                                                                 |
| `~/.rivetos/shared`             | `RIVETOS_SHARED_DIR` — users.json, CA, filestore                                                      |
| `~/.rivetos/ca/root`            | Offline-ish root key (this laptop only)                                                               |
| `~/.rivetos/shared/rivet-ca`    | Intermediate + issued leaves (`chain.pem` for den, `ca-chain.pem` for CLI helpers)                    |
| `~/.rivetos/devices/<name>.p12` | Extra device bundles                                                                                  |

`RIVETOS_SHARED_DIR` is set to `~/.rivetos/shared` before any `sharedPath()`
call so this machine is a mesh of one, not a client of another host's shared
mesh data directory.

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
