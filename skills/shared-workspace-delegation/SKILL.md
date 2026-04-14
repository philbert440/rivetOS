---
name: shared-workspace-delegation
description: How to use the shared NFS directory (/shared/) for cross-agent collaboration on RivetOS and other projects. Covers repo setup, workflow, and the relationship between /opt/rivetos (runtime) and /shared/RivetOS (development).
category: workflow
tags: delegation,nfs,shared,workflow,mesh
---
# Shared Workspace Delegation

## Overview
All mesh nodes (CT110-CT114) and Phil's desktop mount `/shared/` via NFS from Datahub (10.4.20.110). Use this for all cross-agent development work.

## Directory Layout
```
/shared/
├── RivetOS/          # Development clone of rivetOS (npm monorepo)
├── FamiliesApp/      # families.app shared space
├── docs/
├── homelab/
├── mesh.json         # Live mesh registry
├── plans/
├── status/
└── whiteboard/       # Scratch space
```

## Two Paths, Two Purposes

| Path | Purpose | When to use |
|------|---------|-------------|
| `/opt/rivetos` | **Runtime** — what the agent actually runs on | `pm2 restart`, config changes, `rivetos update` |
| `/shared/RivetOS` | **Development** — where code changes are made | Feature branches, fixes, reviews, delegation work |

**Source of truth is always GitHub.** Both paths are clones. `/opt/rivetos` stays on `main` (or whatever's deployed). `/shared/RivetOS` is where branches are created, tested, and pushed.

## Delegation Workflow

1. **Delegating agent** creates a branch in `/shared/RivetOS`
2. **Delegated agent** works in `/shared/RivetOS` — edits, builds, tests
3. **All agents see the same files** — NFS handles sync, no git push/pull needed between nodes
4. **Push to GitHub** when ready for PR
5. **Deploy to `/opt/rivetos`** after merge via `rivetos update --mesh`

## Setup (already done)
```bash
# Clone exists at /shared/RivetOS with npm workspaces
cd /shared/RivetOS
npm install   # NOT yarn — this is an npm monorepo
npm run build
npm test
```

## Key Rules
- **Never modify `/opt/rivetos` for development** — that's the live runtime
- **Always use npm**, not yarn (package-lock.json, npm workspaces)
- **Branch from main** for all changes
- Phil can see all work from his desktop via the same NFS mount
