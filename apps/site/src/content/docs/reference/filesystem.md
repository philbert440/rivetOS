---
title: Filesystem Layout
sidebar:
  order: 6
description: Canonical paths for runtime, workspace, and shared storage
---
> **This document is the source of truth for where things live in RivetOS.**
> It should be read by every agent before any file, directory, or path operation.
> `workspace-templates/WORKSPACE.md` links here; the init wizard copies a reference into each instance's workspace.

RivetOS separates its files across three root directories by concern:

| Path | Purpose | Who writes it |
|---|---|---|
| `/opt/rivetos/` | System runtime (binaries, core, built-in plugins) | Install / update only |
| `~/.rivetos/` on the hub or agent host | Personal config + workspace for this instance | The agent + its human |
| `$RIVETOS_SHARED_DIR` (unset → product default shared root) | Shared mesh data directory (often a network mount) | Any agent, shared |

Agents should treat these boundaries as hard contracts. Never assume or hallucinate paths. If unsure, consult this file.

---

## 1. Runtime directory: `/opt/rivetos/`

The immutable RivetOS installation. The CLI binary, compiled core, built-in plugins, and runtime dependencies live here.

**What belongs:**

- `bin/rivetos` (CLI entry point)
- `packages/` (compiled core: `types`, `core`, `boot`, `cli`)
- `plugins/` (built-in plugins: channels, providers, tools, memory, transports)
- `node_modules/` (runtime dependencies)
- `package.json`, `package-lock.json`
- Container files (`infra/docker/rivetos/docker-compose.yml`, `infra/containers/...`)

**Agent rules:**

- **Read-only** during normal operation.
- Safe uses: version checks (`rivetos --version`, inspecting `package.json`), listing plugins, diagnostics.
- **Never** write user data, logs, configs, plans, or agent state here.
- Updates happen via `rivetos update --mesh` (rolling pull → install → build → restart → health check across the mesh). Never `git pull` / `npm install` / restart individual nodes by hand.

**Example safe commands:**

```bash
ls /opt/rivetos/bin
cat /opt/rivetos/package.json | grep version
rivetos plugins list
```

---

## 2. Config & workspace: `~/.rivetos/`

The per-instance home directory. Equivalent to a Unix user's `~/.config/rivetos` plus a persistent workspace. On the hub or agent host this is `~/.rivetos/` for the account that runs the service.

**What belongs:**

- `config.yaml`: primary configuration (`runtime.workspace`, agents, providers, channels, memory, MCP, etc.)
- `.env`: secrets and environment variables (API keys, DB URLs, tokens). **Never commit.**
- `users.json`: fallback tenancy registry when `$RIVETOS_SHARED_DIR/rivetos/users.json` is absent (override with `RIVETOS_USERS_FILE`).
- `workspace/`: the directory referenced by `runtime.workspace`:
  - `CORE.md`: identity, personality, operating values (injected every turn)
  - `USER.md`: who the human is
  - `WORKSPACE.md`: operating rules, safety boundaries
  - `MEMORY.md`: lightweight context index (main sessions only; see note in the file)
  - `CAPABILITIES.md`: tools + skills inventory
  - `HEARTBEAT.md`: background task checklist (injected on heartbeat turns only)
  - `FILESYSTEM.md`: mirror of this guide
  - `memory/YYYY-MM-DD.md`: daily rolling notes
  - `skills/`: per-instance skill directories (optional)

**Agent rules:**

- **Full read/write access** for self-management.
- Primary location for updating your identity, rules, memory, and daily context.
- Use `ToolContext.workspace` path when available; otherwise resolve to `config.yaml`'s `runtime.workspace` value.
- Keep this directory clean and well-organized; the files here are injected into your context on every turn.

**Default config:** `runtime.workspace: ~/.rivetos/workspace` (init wizard sets this; `~` expands to `$HOME`).

**Example safe paths:**

```
~/.rivetos/config.yaml
~/.rivetos/.env
~/.rivetos/workspace/CORE.md
~/.rivetos/workspace/memory/2026-04-22.md
```

**Secrets rule:** API keys and tokens go in `~/.rivetos/.env` only. Never anywhere else.

---

## 3. Shared mesh data directory

Cross-agent, multi-instance collaborative workspace. This is the shared mesh data directory you configured (`$RIVETOS_SHARED_DIR`; unset → product default shared root). Deployments often mount it from the datahub host. Neutral territory, not tied to any single agent's config.

**What belongs:**

- `rivetos/users.json`: tenancy registry (user id → devices → database handle). Source of truth for per-user memory routing. Override path with `RIVETOS_USERS_FILE`.
- Project plans, roadmaps, specifications (`*.md`, diagrams)
- Shared repositories or project directories
- Research notes, meeting summaries, decision logs
- Multi-agent task outputs and delegation artifacts
- Version control working directories for team projects

**Agent rules:**

- **Read/write access.**
- Use this for collaboration, long-lived shared artifacts, and multi-agent work.
- **Never** store personal config, runtime code, per-session ephemeral state, or secrets here.
- Coordinate via channels or shared plans when modifying shared files to avoid conflicts.

**Example safe paths** (under `$RIVETOS_SHARED_DIR`):

```
$RIVETOS_SHARED_DIR/planning/roadmap.md
$RIVETOS_SHARED_DIR/projects/some-project/
$RIVETOS_SHARED_DIR/meetings/
```

---

## Quick decision matrix

| Task / File Type | Correct Directory | Why |
|---|---|---|
| Check RivetOS version or plugins | `/opt/rivetos/` | Runtime / system |
| Update personality or rules | `~/.rivetos/workspace/` | Personal workspace |
| Read / write daily notes | `~/.rivetos/workspace/memory/` | Personal memory |
| Edit config or add a provider | `~/.rivetos/config.yaml` | Per-instance config |
| Store API keys or secrets | `~/.rivetos/.env` | **Only place for secrets** |
| Collaborate on a shared plan | `$RIVETOS_SHARED_DIR/planning/` | Shared mesh data |
| Clone a repo for a team project | `$RIVETOS_SHARED_DIR/projects/` | Shared mesh data |
| Temporary scratch for one turn | `/tmp/` or `~/.rivetos/workspace/scratch/` | Personal / ephemeral |
| Multi-agent meeting notes | `$RIVETOS_SHARED_DIR/meetings/` | Shared mesh data |

---

## Enforcement rules

1. **Verify directory purpose** before any `ls`, `cat`, `>`, `rm`, `mv`, or tool call involving a new path.
2. If a path doesn't clearly match one of the three categories above, **stop and ask the human** (or consult this file).
3. **Never write to `/opt/rivetos/`** except through `rivetos update --mesh`.
4. **Never store secrets outside `~/.rivetos/.env`.**
5. Prefer absolute paths in tool calls. When in doubt, name the category ("personal workspace" / "shared dev" / "runtime") in your reasoning.

---

## Source of truth

- **Canonical version:** `docs/FILESYSTEM.md` in the `rivetOS` repo.
- **Per-instance mirror:** copied by `rivetos init` into `<workspace>/FILESYSTEM.md`.
- Update via PR against `docs/FILESYSTEM.md`, then propagate.
