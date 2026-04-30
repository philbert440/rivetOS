# RivetOS Filesystem Layout — Canonical Reference

> **This document is the source of truth for where things live in RivetOS.**
> It should be read by every agent before any file, directory, or path operation.
> `workspace-templates/WORKSPACE.md` links here; the init wizard copies a reference into each instance's workspace.

RivetOS separates its files across three root directories by concern:

| Path | Purpose | Who writes it |
|---|---|---|
| `/opt/rivetos/` | System runtime (binaries, core, built-in plugins) | Install / update only |
| `~/.rivetos/` (typically `/home/rivet/.rivetos/`) | Personal config + workspace for this instance | The agent + its human |
| `/rivet-shared/` (or equivalent NFS mount) | Shared dev + multi-agent collaboration | Any agent, shared |

Agents should treat these boundaries as hard contracts. Never assume or hallucinate paths — if unsure, consult this file.

---

## 1. Runtime Directory — `/opt/rivetos/`

The immutable RivetOS installation. The CLI binary, compiled core, built-in plugins, and runtime dependencies live here.

**What belongs:**

- `bin/rivetos` (CLI entry point)
- `packages/` (compiled core — `types`, `core`, `boot`, `cli`)
- `plugins/` (built-in plugins — channels, providers, tools, memory, transports)
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

## 2. Config & Workspace — `~/.rivetos/`

The per-instance home directory. Equivalent to a Unix user's `~/.config/rivetos` plus a persistent workspace. The systemd service runs as the `rivet` user, so this resolves to `/home/rivet/.rivetos/`.

**What belongs:**

- `config.yaml` — primary configuration (`runtime.workspace`, agents, providers, channels, memory, MCP, etc.)
- `.env` — secrets and environment variables (API keys, DB URLs, tokens). **Never commit.**
- `workspace/` — the directory referenced by `runtime.workspace`:
  - `CORE.md` — identity, personality, operating values (injected every turn)
  - `USER.md` — who the human is
  - `WORKSPACE.md` — operating rules, safety boundaries
  - `MEMORY.md` — lightweight context index (main sessions only — see note in the file)
  - `CAPABILITIES.md` — tools + skills inventory
  - `HEARTBEAT.md` — background task checklist (injected on heartbeat turns only)
  - `FILESYSTEM.md` — mirror of this guide
  - `memory/YYYY-MM-DD.md` — daily rolling notes
  - `skills/` — per-instance skill directories (optional)

**Agent rules:**

- **Full read/write access** for self-management.
- Primary location for updating your identity, rules, memory, and daily context.
- Use `ToolContext.workspace` path when available; otherwise resolve to `config.yaml`'s `runtime.workspace` value.
- Keep this directory clean and well-organized — the files here are injected into your context on every turn.

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

## 3. Shared Collaboration — `/rivet-shared/`

Cross-agent, multi-instance collaborative workspace. An NFS mount (or equivalent) shared by every agent on the mesh, typically also mounted on the human's workstation. Neutral territory — not tied to any single agent's config.

**What belongs:**

- `RivetOS/` — the shared clone of the source tree (development and PRs happen here; runtimes run from `/opt/rivetos/`)
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

**Example safe paths:**

```
/rivet-shared/RivetOS/              # shared dev clone of the repo
/rivet-shared/planning/roadmap.md
/rivet-shared/projects/some-project/
```

---

## Quick Decision Matrix

| Task / File Type | Correct Directory | Why |
|---|---|---|
| Check RivetOS version or plugins | `/opt/rivetos/` | Runtime / system |
| Update personality or rules | `~/.rivetos/workspace/` | Personal workspace |
| Read / write daily notes | `~/.rivetos/workspace/memory/` | Personal memory |
| Edit config or add a provider | `~/.rivetos/config.yaml` | Per-instance config |
| Store API keys or secrets | `~/.rivetos/.env` | **Only place for secrets** |
| Develop a RivetOS feature / open a PR | `/rivet-shared/RivetOS/` | Shared dev clone |
| Collaborate on a shared plan | `/rivet-shared/planning/` | Shared dev |
| Clone a repo for a team project | `/rivet-shared/projects/` | Shared dev |
| Temporary scratch for one turn | `/tmp/` or `~/.rivetos/workspace/scratch/` | Personal / ephemeral |
| Multi-agent meeting notes | `/rivet-shared/meetings/` | Shared |

---

## Enforcement Rules

1. **Verify directory purpose** before any `ls`, `cat`, `>`, `rm`, `mv`, or tool call involving a new path.
2. If a path doesn't clearly match one of the three categories above, **stop and ask the human** (or consult this file).
3. **Never write to `/opt/rivetos/`** except through `rivetos update --mesh`.
4. **Never store secrets outside `~/.rivetos/.env`.**
5. Prefer absolute paths in tool calls. When in doubt, name the category ("personal workspace" / "shared dev" / "runtime") in your reasoning.

---

## Source of Truth

- **Canonical version:** `docs/FILESYSTEM.md` in the `rivetOS` repo.
- **Per-instance mirror:** copied by `rivetos init` into `<workspace>/FILESYSTEM.md`.
- Update via PR against `docs/FILESYSTEM.md`, then propagate.
