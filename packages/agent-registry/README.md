# @rivetos/agent-registry

Shared agent-preset registry for RivetHub. Tagged `domain:shared`, so den-server (which may only depend on shared libraries) can import it. Runtime dependencies are `@rivetos/types` and `pg` only.

This package does not change how the den, core, boot, or the hub behave. den-server keeps its own `agents.json` copy until a later slice swaps it onto these stores.

## Stores

- `FileAgentPresetStore` — the den file registry: in-process mutex, atomic replace (`0600`), corrupt-file quarantine.
- `PgAgentPresetStore` — `ros_agent_presets` on the DataHub. It never creates the table; migration `0017_agent_presets.sql` does. One statement per mutation (`pool.query` only) so several dens can share the table.

Both apply `migrateAgentPreset` on read and on write, mint ids with `randomUUID` when the caller does not pass one, and reject a duplicate name (case-insensitive, trimmed) with `PresetConflictError`.

Handle lookup is exact id, then exact name, then case-insensitive trimmed name.

## Directories

`ensureAgentDirectory` creates the preset working directory (`0700`) and, unless `sharedLink` is false, a `rivet-shared` symlink onto the shared directory. A real file or directory already at that path is left alone. A missing shared directory does not throw — the symlink may dangle, and the result says so.

`validateDirectory` accepts an absolute, normalised path (no `..` segment after normalisation, no NUL, at most 512 characters). `directoryWarnings` warns when the directory sits inside the shared directory, because the symlink would then point at an ancestor and loop recursive tools. It does not reject.
