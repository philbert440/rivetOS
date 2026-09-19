# Host extras (mesh member computer)

These run **on the machine** Grok Bot uses (or beside it), not inside the Grok Bot process.

## Capture
Event-driven transcript watch → convert → RivetOS memory ingest.

On a grokbot-style node the live paths are:

- `~/.rivetos/capture/watch.mjs` — fs.watch on agent transcripts
- `~/.rivetos/capture/discover-models.mjs` — dynamic bot roster from `agent-data/agents/*/profile.json`
- `~/.rivetos/capture/run-once.sh` — batch backstop

Copy or symlink from a RivetOS checkout / node image. Requires `RIVETOS_DATAHUB_URL` or `RIVETOS_PG_URL` from plugin settings or `~/.rivetos/.env` (never commit secrets).

## Mesh runtime
RivetOS with `mesh.enabled`, node certs, shared `mesh.json` storage, and (optional) local den. See house runbooks for Tailscale + NFS.

## When Grok Bot gets hooks
Replace or complement the file watcher with SessionEnd / Stop hooks that call ingest — same contract as Claude Code’s `rivet-memory` hooks, without patching the app binary.
