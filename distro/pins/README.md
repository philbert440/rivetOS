# RivetHub pins

`stable.json` is the stable-channel pin file. It is published at
`https://get.rivethub.io/pins/stable.json` (and `/stable.json`). First-install
(`curl -fsSL https://get.rivethub.io/local.sh | bash`) and site downloads are
the **stable** channel on the production server. Dev/nightly **app** builds
come from the mesh update share your deployment publishes (in-app Updates).
GitHub tags are source pins (`local_ref` / `rivetos_tag`), not the app update
feed.

`rivetos_tag` is the datahub/node runtime pin. `local_ref` is the git ref
`install/local.sh` clones (the tag that contains `rivetos local`). Keep
them independent: a datahub/node pin must not silently become the laptop
installer's default.

A value of `UNPINNED` is a placeholder. What an installer does with one
differs: `datahub.sh` refuses an `UNPINNED` `rivetos_tag` (unless
`RIVETHUB_MIGRATIONS_DIR` is set) and any helper without a sha256;
`local.sh` falls back to `main` for `local_ref` with a loud warning;
`pgvector_image` falls back to the floating tag `pgvector/pgvector:pg16`
with a warning.

`hub_helper_version` tracks `bin/rivethub-hub`.

`datahub_sh_sha256` pins `install/datahub.sh` itself, and `local_sh_sha256`
pins `install/local.sh`, for anyone checking the advertised curl-pipe
against what they downloaded.

`hub_helper_sha256`, `rivet_ca_sha256`, `rivet_embedder_unit_sha256` and
`rivet_compactor_unit_sha256` are what a curl-piped `install/datahub.sh`
verifies its fetched helpers against (`bin/rivethub-hub`, `lib/rivet-ca.sh`,
`systemd/rivet-{embedder,compactor}.service`). Change a helper and its pin
together, and publish both in the same deploy; `test/datahub-sh.bats` fails
when they drift.

`lib/rivet-ca.sh` is a vendored copy of `scripts/rivet-ca.sh` from this
repository, pinned as the enroll interface: leaf files
`issued/<id>.{crt,key}`, intermediate `intermediate/{int.crt,int.key,chain.pem}`,
env `RIVET_CA_ROOT_DIR` / `RIVET_CA_SHARED_DIR`, `issue-node <id> [DNS:|IP:…]`.

`pgvector_image` pins the `--docker` image. Prefer digest form
(`pgvector/pgvector@sha256:…`); it is currently the floating tag.

`image` is the agent container image `node.sh --docker` runs.

## Publishing

Nothing here is published by merging. The web root mirrors this directory,
with `install/*.sh` served at the root (`get.rivethub.io/datahub.sh`). A
change to an installer, a helper or `stable.json` goes out as one deploy:
the script, `bin/`, `lib/`, `systemd/`, `pins/stable.json` and its root-level
copy `stable.json`. The site's `releases/latest.json` carries
`datahub_sh_sha256` and `node_sh_sha256` too; update them in the same deploy.
