# workspace-templates/

Canonical workspace template files copied into every new RivetOS instance by `rivetos init`.

Files here are the **default starting point** for an instance's `~/.rivetos/workspace/` directory. They're written generically — per-instance details (the specific model running, environment quirks, personal USER details) get added over time by the agent and its human.

## What's here

| File | Purpose |
|---|---|
| `CORE.md` | Identity — who the agent is (generic "I am Rivet") |
| `USER.md` | Starter template for information about the human |
| `WORKSPACE.md` | Operating rules, safety, session checklist |
| `MEMORY.md` | Lightweight context index template |
| `CAPABILITIES.md` | Tools + skills reference template |
| `HEARTBEAT.md` | Background task checklist template |
| `FILESYSTEM.md` | Mirror of `docs/FILESYSTEM.md` — canonical path reference |

## How it's used

`rivetos init` (the wizard in `packages/cli/src/commands/init/generate.ts`) reads these files and writes them into the target workspace. Existing files are **not** overwritten — the wizard only fills in what's missing.

## Editing these

Treat these files as the shared baseline for all instances. Changes here propagate to every new instance; they do not retroactively update existing instances (those live in the per-instance `~/.rivetos/workspace/`).

When updating:

1. Keep them **generic** — no per-instance facts (specific model names, specific hostnames, specific personal details).
2. Keep them **rooted in "I am Rivet"** — the agent can specialize later in its own workspace.
3. Update `docs/FILESYSTEM.md` and mirror any relevant changes into `workspace-templates/FILESYSTEM.md`.
