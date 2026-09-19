---
name: rivetos-status
description: >-
  Check RivetOS connection health for Grok Bot: mode (cloud vs local),
  Tailscale up?, DataHub/cloud endpoint reachable? Use when the user asks
  if memory is connected, why recall is empty, or to diagnose onboard.
  Never dump secrets.
tags: [rivetos, status, health, grokbot]
version: 0.1.0
---

# RivetOS status (Grok Bot)

Run the kit helper — do not invent ad-hoc `echo $RIVETOS_PG_URL` / `env` /
`cat ~/.rivetos/.env` (those leak secrets):

```bash
# Plugin install:
"${CURSOR_PLUGIN_ROOT}/bin/rivetos-status.sh"
# Checkout:
integrations/grok-bot/rivethub-grokbot/bin/rivetos-status.sh
```

Report only what the script prints:

- `mode` — `cloud` / `local` / unset (house `.env` fallback)
- `cloud_token` / `datahub` / `pg_url` — **set** or **unset**, never values
- `tailscale` — BackendState / online, or n/a in cloud mode
- `endpoint` — reachable or not, as `scheme host:port` (no userinfo)

Optional prove: call `memory_stats` (or `rivetos__memory_stats`). That is
coverage/health of the store, not a secret dump.

If mode is unset and no DataHub/PG/token is set, tell them to run
`rivetos-onboard`.
