---
name: rivetos-mesh-operations
description: Standard commands for managing the RivetOS mesh: updating instances, health checks, delegation testing. Stop reinventing the wheel.
category: rivetos
tags: rivetos,mesh,update,instances,deployment
version: 2
---
# RivetOS Mesh Operations

## 🚨🚨🚨 USE THE CLI — THIS IS NOT OPTIONAL 🚨🚨🚨

**You have been called out MULTIPLE TIMES for manually SSH-ing into nodes instead of using the CLI.**
**Phil is sick of it. It wastes money. It wastes time. STOP.**

After merging ANY PR:
```bash
/opt/rivetos/bin/rivetos update --mesh
```

That's it. ONE command. Don't think. Don't improvise. Don't SSH. Run the command.

## What `rivetos update --mesh` Does

1. Reads `/shared/mesh.json` for all nodes
2. Updates local node (git pull --ff-only, npm install, nx build, systemctl restart)
3. For each remote node: rsync code → npm install → build → restart → health check
4. Rolling, one at a time, with error recovery
5. Non-agent nodes (datahub, infra) get sync-only (no restart)

### Options
- `--version <tag>` — Update to a specific version/tag
- `--no-restart` — Pull and rebuild only, don't restart services
- `--bare-metal` — Force bare-metal mode (skip Docker logic)

## Health Checks

```bash
rivetos mesh ping      # Check all mesh peers
rivetos mesh list      # List known nodes
rivetos mesh status    # Local mesh status
```

## PR → Deploy Workflow

1. Open PR, CI runs (lint + build + secrets scan)
2. Get PR approved
3. Merge via `gh pr merge <num> --squash --delete-branch`
4. Run `rivetos update --mesh` — done.

**DO NOT:**
- ❌ Manually SSH into each instance to git pull/build/restart
- ❌ Write custom shell loops to update instances
- ❌ Forget that `rivetos update --mesh` exists
- ❌ Use `ssh root@<node-ip>` for deployments EVER

## Troubleshooting

- **Ping returns 401:** Instance has old code before the ping-before-auth fix (PR #39). Update it.
- **Health check times out:** The update command tries SSH `systemctl is-active` first, then HTTP ping. Both failing = service didn't start.
- **rsync fails:** Falls back to agent API update. Check SSH key access with `rivetos keys list`.
- **Branch not on main:** `rivetos update` auto-switches to main before pulling.

## Source Code
- CLI: `packages/cli/src/commands/update.ts`
- Mesh file: `/shared/mesh.json`
- Ping endpoint: `packages/core/src/runtime/agent-channel.ts`

## Changelog
- **v2** (2026-04-14): Making the warning impossible to miss after repeated failures to use the CLI
