# RivetHub

Stable distribution of RivetOS — the installers and pins published at
[get.rivethub.io](https://get.rivethub.io). The site itself is
`apps/rivethub-site`. Paths below are relative to this `distro/` directory,
which is laid out exactly as the web root serves it (`install/*.sh` are
published at the root: `get.rivethub.io/datahub.sh`).

Tests: `npx bats distro/test </dev/null` from the repo root (CI runs the
same). Stdin must be closed; one fake in the datahub suite reads it.

Every node keeps a **local** `RIVETOS_SHARED_DIR` (distro default
`/var/lib/rivethub/shared`). The datahub host is the source of truth for
`mesh.json` and the CA. Enrollment and sync happen over SSH; the CA root key
never leaves the datahub.

## Layout

```
bin/rivethub-hub              datahub helper (CA init, enroll, renew, mesh-export, status)
lib/rivet-ca.sh               pinned copy of rivet-ca.sh (enroll interface / leaf layout)
install/local.sh              one-laptop curl-pipe installer (no root)
install/datahub.sh            datahub host curl-pipe installer (root)
install/node.sh               agent-node curl-pipe installer
systemd/                      rivetos-agent.service + rivet-embedder / rivet-compactor templates
pins/stable.json              stable-channel pins (see pins/README.md)
test/                         bats tests (rivethub-hub, datahub.sh, node.sh, local.sh)
```

`bin/rivethub-hub` assumes a Linux datahub: GNU coreutils `base64 -w0` and
util-linux `flock`.

## Local (one laptop)

One command stands up RivetOS as a **single-node mesh** on your laptop
(Linux or macOS): embedded PGlite, den on `https://localhost:5174`,
harness plugins, optional Linux desktop app. No root, no Postgres
daemon, no `useradd`. System Node is never replaced — if Node is missing
or older than 22, the installer puts **fnm** in `~/.local/share/fnm` and
installs Node 22 there.

```
curl -fsSL https://get.rivethub.io/local.sh | bash
```

**Channels.** Stable first-install (this one-liner, `pins/stable.json`, AppImage/exe/apk) lives on the production server (`get.rivethub.io` / `rivethub.io`). Dev and nightly app builds live on the mesh update share your deployment publishes — that is what already-installed desktop and Android check for updates. GitHub tags are source pins (`local_ref`), not the app update feed.

On a terminal, unset fields are prompted (defaults shown), then a
SUMMARY, then an explicit `yes` before any write. `--yes` skips the
confirm. On non-TTY (plain ssh with no controlling terminal —
`/dev/tty` existing is not enough if it cannot be opened), `--yes`
accepts documented defaults. Without `--yes`, every unset wizard
question is listed together in one error with the flag / env names.

```
bash install/local.sh [--yes] [--provider KEY] [--api-key K] \
  [--port 5174] [--pg-port 5433] [--no-lan] [--no-service] [--no-app] \
  [--install-root DIR] [--ref REF] [--device NAME]
```

Default checkout is `~/.rivetos/src` at `pins/stable.json`
`local_ref` (override with `--ref` / `RIVETHUB_REF`; `UNPINNED` falls
back to `main` with a warning). `rivetos_tag` stays the datahub/node
pin and is not the local-mode default. Re-run is a resume/upgrade:
fetch + checkout + rebuild + `rivetos local --yes`.
Day-2: `rivetos local status`, `rivetos local backup`,
`rivetos local reset`. Pair a phone from Settings → Devices → QR.
Docs: `https://rivethub.io/install-local.html`.

Datahub install (Debian 12 / Ubuntu LTS) — curl-pipe or from a checkout:

```
curl -fsSL https://get.rivethub.io/datahub.sh | sudo bash
sudo bash install/datahub.sh [--docker] [--memory lite|full] [--owner NAME] [--advertise-host 192.0.2.10] [--yes]
```

On a terminal, unset fields are prompted (defaults shown), then a SUMMARY,
then an explicit `yes` before any write. `--yes` skips the confirm. With
no terminal (plain ssh with no controlling terminal — `/dev/tty` existing
is not enough if it cannot be opened) nothing is prompted and there is no
confirm, with or without `--yes`: each prompt's documented default applies.
Fields with no default (`RIVETOS_EMBED_URL` / `RIVETOS_COMPACTOR_URL` /
`RIVETOS_COMPACTOR_MODEL` for `--memory full`) are listed together in one
error with their env names. Flags and `RIVETHUB_*` env vars skip their
prompt. Full non-interactive set: `RIVETHUB_OWNER` (default `owner`),
`RIVETHUB_MEMORY` (default `lite`), `RIVETHUB_INSTALL_MODE` (default
`bare-metal`), `RIVETHUB_PG_PORT` (default `5432`), `RIVETHUB_ROOT`
(default `/var/lib/rivethub`), `RIVETHUB_ADVERTISE_HOST`, plus the
memory-full URLs when needed.

Curl-pipe has no sibling `bin/` / `lib/` / `systemd/`: preflight fetches
`pins/stable.json`, `bin/rivethub-hub`, `lib/rivet-ca.sh` and the two worker
units from `https://get.rivethub.io` (`RIVETHUB_BASE_URL`) and checks each
against its sha256 pin before the installer writes anything of its own. A
missing pin or a mismatch is refused. (If `curl`, `openssl`, `flock` or
`python3` is missing, preflight apt-installs it first, before the pins can be
read.) Pins and files come from the same origin, so the check catches a
broken or half-published deploy, not a compromised server. Publishing a helper therefore means updating its `*_sha256` in
`pins/stable.json` in the same deploy. `RIVETOS_COMPACTOR_MODEL` has no
default: `--memory full` asks for it like the URLs.

Agent-node install (Debian 12 / Ubuntu LTS) — curl-pipe is supported:

```
curl -fsSL https://get.rivethub.io/node.sh | bash -s -- --hub user@192.0.2.10
sudo bash install/node.sh [--docker] [--hub user@192.0.2.10] [--name node-a] [--advertise-host 192.0.2.11]
```

`--hub` is an SSH login that can run `rivethub-hub` on the datahub. The
installer runs as root, so BatchMode ssh uses `/root/.ssh` — copy your key
there (or `ssh-copy-id` as root) before a curl-pipe or `sudo` run. `--yes`
skips the confirm (and on non-TTY accepts name/advertise-host defaults;
`--hub` has no default). Re-run without `--hub` resumes `HUB_TARGET` /
`NODE_NAME` from `$RIVETHUB_ROOT/node.env`.

The systemd unit is **`rivetos-agent.service`** (not `rivetos.service`).
Day-2 `rivetos mesh sync` / `renew` run as the `rivet` user: the installer
generates `/home/rivet/.ssh/id_ed25519` and installs that pubkey on
`--hub` via the root hop.

Bare-metal (systemd, Node 22+, git clone at the `pins/stable.json`
`rivetos_tag`) is the default; `--docker` runs the pinned GHCR image with
host networking on mesh port 3000. Curl-pipe has no sibling `pins/`:
`node.sh` fetches `https://get.rivethub.io/pins/stable.json` and falls back
to an embedded copy whose values are `UNPINNED`, so the clone and image
float if that fetch fails.
`rivetos mesh enroll` is not merged yet — `install/node.sh` implements the
same tarball contract over SSH (`enroll_via_ssh`).

## Security posture

Curl-pipe install scripts are meant to be **read**. Keep them short, boring,
and free of hidden control flow. `bin/rivethub-hub` is the only helper the
datahub installer drops on the datahub besides a copy of `rivet-ca.sh`. Root
material lives in `$RIVETHUB_ROOT/ca-root` (default `/var/lib/rivethub/ca-root`,
mode 0700) and is never packed into an enroll tarball.

Do not embed real hostnames, IPs, or keys in this repo. Examples use RFC 5737
documentation addresses (`192.0.2.0/24`).

## Enrollment model

1. Operator initializes the CA once on the datahub: `rivethub-hub ca-init`.
2. A node runs `install/node.sh --hub user@datahub-host` (or, later,
   `rivetos mesh enroll user@datahub-host`).
3. That SSH session invokes `rivethub-hub enroll <node-name> <advertise-host>`
   on the datahub.
4. **Stdout is only a base64 tarball** (leaf crt+key, `ca-chain.pem`, current
   `mesh.json`, `node-config-snippet.yaml`). Diagnostics go to stderr so the
   caller can pipe stdout. The blob is all-or-nothing (tar is written to a
   temp file, then encoded); a failed enroll/renew leaves stdout empty.

The same tarball contract is what `rivethub-hub renew` emits. Renew re-issues
the leaf using the stored `mesh.json` host — to change a node's address,
re-enroll. A future HTTP enroll service can call `enroll_core` (issue + merge
+ stage, under flock) and skip the stdout adapter.
