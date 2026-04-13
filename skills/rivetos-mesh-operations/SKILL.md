---
name: rivetos-mesh-operations
description: Standard commands for managing the RivetOS mesh: updating instances, health checks, delegation testing. Stop reinventing the wheel.
category: rivetos
tags: rivetos,mesh,update,instances,deployment
---
# RivetOS Mesh Operations

## ⚠️ USE THE CLI — DO NOT MANUALLY SSH LOOP

RivetOS has built-in mesh management commands. Use them.

## Updating All Instances

```bash
# After merging a PR to main:
rivetos update --mesh
```

This command does EVERYTHING:
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
# Check all mesh peers
rivetos mesh ping

# List known nodes
rivetos mesh list

# Local mesh status
rivetos mesh status
```

## Mesh Nodes

Node IPs are in `/shared/mesh.json` and `~/.rivetos/config.yaml`. Don't hardcode them — read from config at runtime.

Typical layout: one node per provider (opus, grok, gemini, local, datahub).

## PR → Deploy Workflow

1. Open PR, CI runs (lint + build + secrets scan)
2. Get PR approved (branch protection requires 1 approving review)
3. Merge via `gh pr merge <num> --squash --delete-branch` (need human approval — bot can't admin-merge)
4. Run `rivetos update --mesh` — done.

**DO NOT:**
- Manually SSH into each instance to git pull/build/restart
- Write custom shell loops to update instances
- Forget that `rivetos update --mesh` exists

## Troubleshooting

- **Ping returns 401:** Instance has old code before the ping-before-auth fix (PR #39). Update it.
- **Health check times out:** The update command tries SSH `systemctl is-active` first, then HTTP ping. Both failing = service didn't start.
- **rsync fails:** Falls back to agent API update. Check SSH key access with `rivetos keys list`.
- **Branch not on main:** `rivetos update` auto-switches to main before pulling.

## Source Code
- CLI: `packages/cli/src/commands/update.ts`
- Mesh file: `/shared/mesh.json`
- Ping endpoint: `packages/core/src/runtime/agent-channel.ts`
