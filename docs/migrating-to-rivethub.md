# Migrating to RivetHub

RivetHub is the successor to the RivetOS TypeScript runtime: the same node
(gateway, agents, memory, mesh, harness integrations) as a single native
binary, `rh`. This page covers moving an existing RivetOS node onto it with
`rivetos migrate-to-rivethub`, what changes, what keeps working, and how to go
back.

The TypeScript runtime is deprecated as of this release. `rivetos start` and
`rivetos update` print a one-line pointer here; they keep working until the
TypeScript packages are removed in a later release.

## Before you start

- **Update first.** `rivetos update` (or `rivetos update --mesh`) brings in the
  CLI that has the command. On a mesh, every node needs it before `--mesh` can
  reach that node.
- **Linux with systemd.** RivetHub runs as `rivethub.service`, in the same
  scope (system or user unit) as the `rivetos.service` it replaces. Release
  binaries are published for linux x86_64; anything else needs
  `--binary <path>` to a build of your own.
- **Run it as the install owner, from a shell.** That is the user that owns
  `~/.rivetos` and that `rivetos.service` runs as. A system unit needs root or
  passwordless `sudo` for `systemctl`. Do not run the command from an agent
  session hosted by `rivetos.service` itself: stopping the service would end
  the command halfway, so the preflight refuses. Use an SSH shell, or run
  `--mesh` from another node.
- **Database backup.** The Postgres adoption is designed to be safe to roll
  back (see below), but a shared production database deserves its own backup
  before any schema change.

## Quick start

```bash
rivetos migrate-to-rivethub --dry-run     # preflight + the exact plan, changes nothing
rivetos migrate-to-rivethub               # migrate this node
rivetos migrate-to-rivethub --mesh        # every agent node over SSH, this node last
rivetos migrate-to-rivethub --rollback    # go back to rivetos.service
```

| Option              | Meaning                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| `--dry-run`         | Run the preflight and print every step with its command; change nothing.                          |
| `--rollback`        | Reverse the migration (or a half-finished one) on this node.                                      |
| `--mesh`            | Walk the agent nodes in `mesh.json` one at a time over SSH, then this node.                       |
| `--binary <path>`   | Install this local `rh` instead of downloading a release; `rivethub-migrate` must sit next to it. |
| `--version <tag>`   | Release tag to download (default: the latest release).                                            |
| `--ssh-user <user>` | SSH user for remote nodes (default `rivet`; a node's `sshUser` in `mesh.json` wins).              |

Exit codes: `0` migrated (or already migrated, or nothing to roll back), `1` a
step failed, `2` the preflight refused or the arguments were wrong.

## What the command does

The preflight runs first and refuses, with the reason, when the node cannot be
migrated safely: no `~/.rivetos`, an existing `~/.rivethub` or
`rivethub.service`, a system unit without sudo, a unit that runs as a
different user, unwritable state or home directories, a runtime still
answering on the gateway port with no unit to stop, a config that
`rh config validate` rejects, or a PGlite node that already has a
`memory.sqlite`. Nothing has changed at that point.

Then, in order:

1. Install `rh` and `rivethub-migrate` into `~/.local/bin`, from the GitHub
   release of `philbert440/rivethub-runtime` (each asset checked against its
   `.sha256`) or from `--binary`.
2. `rh config validate` against `~/.rivetos/config.yaml`; for Postgres nodes,
   `rivethub-migrate status postgres`.
3. Stop and disable `rivetos.service`.
4. Back up `~/.rivetos` to `~/rivetos-state-<stamp>.tgz` (mode 600; it holds
   keys, so it stays on the node).
5. Bring memory over (next section).
6. Install `rivethub.service` and start it.
7. Wait for RivetHub to move `~/.rivetos` to `~/.rivethub`, then link
   `~/.rivetos → ~/.rivethub`.
8. Health: the unit is active, the gateway answers `/healthz`, `rh status`.

If a step fails while the TypeScript runtime is down (steps 3–7), the command
puts it back on its own: it removes `rivethub.service`, moves the state back if
it had moved, and re-enables `rivetos.service`. Once RivetHub owns the state
(step 8), a failure is reported with the rollback command instead; nothing is
undone without you deciding to.

The unit carries the old unit's semantics: `User=` the install owner (system
units), `HOME`, a `PATH` that starts with `~/.local/bin`, `TERM`,
`EnvironmentFile=-~/.rivetos/.env` (valid before the move and, through the
link, after it), and `ExecStart=~/.local/bin/rh start`.

## What moves

|                          | RivetOS                             | RivetHub                                           |
| ------------------------ | ----------------------------------- | -------------------------------------------------- |
| State directory          | `~/.rivetos`                        | `~/.rivethub` (moved once, at the first start)     |
| Service                  | `rivetos.service`                   | `rivethub.service`, same scope                     |
| CLI                      | `rivetos`                           | `rh`                                               |
| Binaries                 | `/opt/rivetos` checkout or npm      | `~/.local/bin/rh`, `~/.local/bin/rivethub-migrate` |
| MCP server for harnesses | TS sidecar (`services/mcp-sidecar`) | `rh mcp` (stdio)                                   |
| Environment variables    | `RIVETOS_*`                         | `RIVETHUB_*`                                       |

**Memory, Postgres nodes.** `rivethub-migrate postgres` adopts the database:
the memory tables are renamed to `rh_*` and `ros_*` views keep the old names
working. It is idempotent, and it refuses while a RivetOS writer is
mid-migration. The database URL is passed
through the environment, never on the command line.

**Memory, standalone (PGlite) nodes.** RivetHub keeps memory in a SQLite file
instead of embedded Postgres. With the service stopped, the command dumps the
memory tables from the PGlite engine (a plain, data-only dump in `pg_dump`
format, kept at `~/.rivethub/migrate/pglite-memory-<stamp>.sql`, mode 600) and
imports it with `rivethub-migrate sqlite --import-pg-dump` into
`~/.rivethub/memory.sqlite`. The import is all-or-nothing and refuses a
non-empty target; it leaves a receipt, so `rh local` does not import again.
The PGlite directory itself is left untouched.

**Memory, SQLite nodes.** `rivethub-migrate sqlite` brings the existing file to
the RivetHub schema in place.

## What stays compatible

- **Paths.** `~/.rivetos` remains a link to `~/.rivethub`, so integrations,
  workspace paths, scripts and anything else that names `~/.rivetos` keep
  working. RivetHub never adopts `~/.rivetos` again once `~/.rivethub` exists.
- **Configuration.** `config.yaml` is read where it is. Keys RivetHub no longer
  uses (retired channels, plugin lists) are reported as warnings by
  `rh config validate`, not errors.
- **Environment.** Every `RIVETOS_*` variable that has a `RIVETHUB_*`
  successor is still read, with one deprecation warning, while the new name is
  unset. `~/.rivetos/.env` stays the unit's environment file.
- **Capture and MCP.** Harness capture hooks keep posting to the node gateway's
  `/api/capture`, which RivetHub serves. The `rivet-memory-mcp.sh` launchers
  switch to `rh mcp` by themselves on a node that has `~/.rivethub` and an `rh`
  binary (in `~/.local/bin` or on `PATH`); `RIVETOS_MCP_USE_TS=1` keeps the TS
  sidecar.
- **Database.** Code that reads `ros_*` tables keeps working through the views.
- **Mesh.** The node keeps its name and mesh identity, and RivetHub speaks the
  same mesh protocol, so a mesh can migrate one node at a time.

## The alias window

For one release, `rivetos` is an alias of `rh`, so muscle memory and scripts
keep working while you switch to the new name. The migration does not install
that alias itself. After a node is migrated, check which one your `PATH` finds
(`command -v rivetos`): when it is RivetHub's alias, run the TypeScript CLI's
own commands (such as `--rollback`) through the checkout,
`node /opt/rivetos/packages/cli/dist/index.js migrate-to-rivethub --rollback`.

Later releases remove the alias, then the TypeScript runtime packages, and the
`ros_*` views go away with the 1.0 migration collapse.

## Rolling back

```bash
rivetos migrate-to-rivethub --rollback          # this node
rivetos migrate-to-rivethub --rollback --mesh   # every node, this one last
```

The rollback stops, disables and removes `rivethub.service`, removes the
`~/.rivetos` link and moves `~/.rivethub` back to `~/.rivetos`, then enables
and starts `rivetos.service` and waits for its gateway. Each step checks what
is left to undo, so it also cleans up a migration that stopped halfway, and it
can be re-run after fixing whatever stopped it.

What a rollback does not undo:

- **The database stays adopted.** RivetOS reads and writes memory through the
  `ros_*` views, so there is nothing to revert.
- **Standalone nodes:** memory written while RivetHub ran lives in its SQLite
  file, which the rollback parks as `memory.sqlite.rivethub-<stamp>` next to the
  PGlite directory; PGlite has what it had at the migration. Migrating again
  later starts from a fresh import.
- **State written by RivetHub** under `~/.rivethub` stays in place, and RivetOS
  can read it.
- The `rh` binaries stay in `~/.local/bin`. Without `~/.rivethub` the MCP
  launchers go back to the TS sidecar.

The backup tarball is the last resort if the state directory itself was damaged:
stop both services, move the damaged directory aside, and
`tar xzf ~/rivetos-state-<stamp>.tgz -C ~`.

## Mesh migration

`--mesh` reads `mesh.json` and runs each agent node's own
`rivetos migrate-to-rivethub` over SSH (the checkout CLI under the node's
install root, else a `rivetos` on `PATH` that knows the command), so each node
preflights itself. Nodes go one at a time and the walk stops at the first
failed node, so a bad release or a database problem does not reach every node;
refusals are reported and the walk continues. This node goes last. Datahub
worker nodes, non-Linux nodes and nodes marked `deployable: false` are skipped.
With `--binary`, the binaries are copied to each node first.

## Troubleshooting

- `journalctl -u rivethub -n 50` (or `journalctl --user -u rivethub -n 50` for a
  user unit) shows why RivetHub did not start or did not move the state.
- `rh status` reports gateway health; `rh doctor` checks the node.
- A preflight refusal names its cause and the fix; nothing was changed.
- The release location is one constant, `RIVETHUB_RELEASE` in
  `packages/cli/src/commands/migrate-to-rivethub/release.ts`, should the release
  layout change.
