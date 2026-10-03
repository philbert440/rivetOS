# RivetHub pins

`stable.json` is the stable-channel pin file for this distro. It is published
at `https://get.rivethub.io/pins/stable.json` (and `/stable.json`). First-install
(`curl -fsSL https://get.rivethub.io/local.sh | bash`) and site downloads are
the **stable** channel on the production server. Dev/nightly **app** builds live
on `/rivet-shared/builds/rivethub/` (in-app Updates). GitHub tags are source
pins (`local_ref` / `rivetos_tag`), not the app update feed.

`rivetos_tag` is the datahub/node runtime pin. `local_ref` is the git ref
`install/local.sh` clones (the tag that contains `rivetos local`). Keep
them independent: a datahub/node pin must not silently become the laptop
installer's default. `local_ref` of `UNPINNED` falls back to `main` with
a loud warning.

`UNPINNED` values are placeholders until the first rivetOS stable tag
(`vX.Y.Z`) exists. Do not ship a datahub/node installer that consumes this
file until those fields are real tag/image/sha256 pins.

`hub_helper_version` tracks `bin/rivethub-hub` and is already a real value
(`0.1.0`).

`datahub_sh_sha256` pins `install/datahub.sh` itself, like `local_sh_sha256`.
`hub_helper_sha256`, `rivet_ca_sha256`, `rivet_embedder_unit_sha256` and
`rivet_compactor_unit_sha256` are what a curl-piped `install/datahub.sh`
verifies its fetched helpers against (`bin/rivethub-hub`, `lib/rivet-ca.sh`,
`systemd/rivet-{embedder,compactor}.service`). Change a helper and its pin
together, and publish both in the same deploy; `test/datahub-sh.bats` fails
when they drift.

`local_sh_sha256` pins `install/local.sh` for the advertised curl-pipe
(`curl -fsSL https://get.rivethub.io/local.sh | bash`). `UNPINNED` until
hashed (no shell in this pass). Reviewer: `sha256sum install/local.sh`
and write that digest when ready.

`pgvector_image` pins the `--docker` image. Prefer digest form
(`pgvector/pgvector@sha256:…`) when a pin exists. `UNPINNED` falls back to
the floating tag `pgvector/pgvector:pg16` with a warning. Reviewer: `docker
image inspect pgvector/pgvector:pg16 --format '{{index .RepoDigests 0}}'`
and write that digest when ready.

`rivet_ca_sha256` stays `UNPINNED` until hashed (no shell in this pass).
The enroll interface is pinned as `lib/rivet-ca.sh` (vendored from
`/opt/rivetos/scripts/rivet-ca.sh`): leaf files `issued/<id>.{crt,key}`,
intermediate `intermediate/{int.crt,int.key,chain.pem}`, env
`RIVET_CA_ROOT_DIR` / `RIVET_CA_SHARED_DIR`, `issue-node <id> [DNS:|IP:…]`.
Reviewer: `sha256sum lib/rivet-ca.sh` and write that digest into
`rivet_ca_sha256` when ready. The image field uses a personal GHCR
namespace (`ghcr.io/philbert440/rivetos`) — flag before any installer
consumes this file; org-owned registry is a follow-up.
