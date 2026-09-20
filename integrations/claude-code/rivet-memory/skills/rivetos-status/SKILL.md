---
name: rivetos-status
description: >-
  Check RivetOS connection health for Claude Code: mode (cloud vs local),
  Tailscale up?, DataHub/cloud endpoint reachable? Use when the user asks
  if memory is connected, why recall is empty, or to diagnose onboard.
  Never dump secrets.
tags: [rivetos, status, health, claude-code]
version: 0.1.0
---

# RivetOS status (Claude Code)

Run the kit helper — do not invent ad-hoc `echo $RIVETOS_PG_URL` / `env` /
`cat ~/.rivetos/.env` (those leak secrets):

```bash
# Plugin install:
"${CLAUDE_PLUGIN_ROOT}/bin/rivetos-status.sh"
# Checkout:
integrations/claude-code/rivet-memory/bin/rivetos-status.sh
```

Report plugin-form values as coming from the form only if the client exported them to the status script; otherwise the env file wins over inherited values.

Report only what the script prints:

- `mode` — `cloud` / `local` / unset (house `.env` fallback)
- `cloud_token` / `datahub` / `pg_url` / `embed_url` / `embed_model` / `memory_write` — **set** or **unset**, never values
- `cloud_url` / `endpoint` — reachable or not, as `scheme host:port` (no userinfo)
- `problem` — missing embedding model when Postgres memory is enabled
- `tailscale` — BackendState / online, or n/a in cloud mode

Optional prove: call `memory_stats` (or `rivetos__memory_stats`). That is
coverage/health of the store, not a secret dump.

If mode is unset and no DataHub/PG/token is set, tell them to run
`rivetos-onboard`.
