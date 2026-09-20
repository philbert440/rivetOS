---
name: rivetos-onboard
description: >-
  First-run and re-runnable RivetOS setup for Claude Code. Use when the plugin is
  newly installed, memory tools are empty/disabled, RIVETOS_MODE is unset, or
  the user says set up / connect / onboard RivetOS. One fork: cloud vs local.
tags: [rivetos, onboard, setup, claude-code]
version: 0.1.0
---

# RivetOS onboard (Claude Code)

Same plugin either way. Mode chooses **where** memory traffic goes.

## Before you start

1. Ask **one** question (do not assume house layout):

   **Use RivetOS cloud, or your local RivetOS (Tailscale + DataHub)?**

2. Persist the choice as plugin settings (Claude Code plugin `userConfig`)
   **and/or** by setting env and running
   `${CLAUDE_PLUGIN_ROOT}/bin/rivetos-onboard-persist.sh`
   (checkout path: `integrations/claude-code/rivet-memory/bin/rivetos-onboard-persist.sh`).
   Re-runnable: it is safe to change mode later.

3. **Never** print `RIVETOS_PG_URL`, `RIVETOS_CLOUD_TOKEN`, passwords, or full
   connection strings. **Never** ask the user to paste a Tailscale auth key
   into chat or plugin settings — Tailscale login stays in the Tailscale app/CLI.

Nodes already on `~/.rivetos/.env` do not need this wizard. If they run
it anyway, prefer Path B and leave existing `.env` secrets in place.

**Memory write is off by default.** Shell, file, and search write tools are
not shipped. After prove, ask whether they want `memory_append` /
`memory_ingest_session`. Only if they say yes, persist
`RIVETOS_MCP_ENABLE_MEMORY_WRITE=1` (or set the plugin setting to `1`).
Do not enable it silently.

---

## Path A — RivetOS cloud

**Goal:** off and running. No Tailscale. No DataHub URL.

**Honest v1 (do not fake a working browser OAuth):**

This kit does **not** ship a browser OAuth loop yet. v1 is paste-credentials-
from-the-dashboard, **memory only**. Rivet Cloud today is a tenant bundle plus
`rivetos cloud connect` (see `docs/cloud.md`). Memory tools still talk Postgres
via that bundle (same MCP names as local). The launcher does not read
`RIVETOS_CLOUD_TOKEN` for memory yet.

User steps:

1. Confirm they have a Rivet Cloud account / tenant bundle.
2. Set `RIVETOS_MODE=cloud`.
3. Optional: set secret `RIVETOS_CLOUD_TOKEN` in the plugin form (never in
   chat) for later cloud HTTP. The memory launcher does not consume it yet.
4. Optional: `RIVETOS_CLOUD_URL` (default `https://rivetos.cloud`).
5. Until a dedicated cloud memory HTTP API exists, they also need the cloud
   **Postgres + embed** URLs from the tenant bundle (`rivetos cloud connect`).
   Those go in the plugin form / `~/.rivetos/.env` — not in this chat.
6. Whenever an embed URL is given, ask for `RIVETOS_EMBED_MODEL` as well
   (for example `text-embedding-3-small`) and persist both before proving.

If they have no cloud account yet, say so and offer Path B. Do not invent a
sign-in URL or pretend OAuth completed.

**Prove:** call `memory_stats`. If memory is still disabled, run
`rivetos-status` (or `bin/rivetos-status.sh`) and report mode + reachability
only — then tell them which form field is missing (token vs DataHub/PG),
without dumping values.

---

## Path B — RivetOS local

**Goal:** Tailscale up; one DataHub endpoint reachable; MCP talking to their hub.

User steps:

1. Set `RIVETOS_MODE=local`.
2. **Tailscale**
   - If `tailscale` is missing: point them at https://tailscale.com/download
     and `tailscale up` (browser login **or** auth key they already have).
   - Guide both login styles. Store **neither** key in the plugin.
   - Check with `tailscale status` (BackendState only; do not paste the full
     node dump into chat unless they ask).
3. **DataHub endpoint** — one field: `RIVETOS_DATAHUB_URL`
   - Prefer a MagicDNS / `postgres://` URL for their DataHub / PG gateway.
   - The launcher maps `postgres://` / `postgresql://` onto `RIVETOS_PG_URL`.
   - HTTPS values are stored, not converted.
   - Optional `RIVETOS_EMBED_URL` if their hub needs it. Whenever given, ask
     for `RIVETOS_EMBED_MODEL` too (for example `text-embedding-3-small`).
   - `RIVETOS_PG_URL` is legacy, only if DataHub URL is not enough.
4. Persist, then prove.

**Prove:** `bin/rivetos-status.sh` (Tailscale + host:port, no secrets), then
`memory_stats`.

---

## After prove

- Memory skills (`memory-recall`) stay unchanged.
- Capture requires a built checkout and keeps its existing `.env` behavior.
  Without a checkout, the hook logs and skips capture.
- If prove fails: say what is missing (mode, Tailscale, reachable host, token
  set/unset). Do not print the URL.

- Server exits at start: if an embed URL and Postgres/DataHub URL are set,
  check `RIVETOS_EMBED_MODEL`; ask for the model and persist it if missing.
