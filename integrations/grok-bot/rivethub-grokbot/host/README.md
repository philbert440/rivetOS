# Host extras (mesh member computer)

These run **on the machine** Grok Bot uses (or beside it), not inside the Grok Bot process.

## Capture
Event-driven transcript watch → convert → RivetOS memory ingest.

Typical layout on a member node (copy or symlink from a RivetOS checkout):

- `~/.rivetos/capture/watch.mjs` — fs.watch on agent transcripts
- `~/.rivetos/capture/discover-models.mjs` — dynamic bot roster from each agent's `profile.json`
- `~/.rivetos/capture/run-once.sh` — batch backstop

Requires a postgres-shaped `RIVETOS_DATAHUB_URL` or `RIVETOS_PG_URL` from plugin settings or `~/.rivetos/.env` (never commit secrets). An HTTPS DataHub value is not enough for ingest.

## Mesh runtime
RivetOS with `mesh.enabled`, node certs, shared `mesh.json` storage, and (optional) local den. See the RivetOS mesh docs for Tailscale and shared storage.

## When Grok Bot gets hooks
Replace or complement the file watcher with SessionEnd / Stop hooks that call ingest — same contract as other harness `rivet-memory` hooks, without patching the app binary.
