# @rivetos/harness-deepseek

The `deepseek-harness` spawn surface: RivetOS starts the DeepSeek Harness CLI
as an interactive TUI.

```
dsh --profile tui
dsh --profile tui --resume <session-uuid>
```

dsh mints its own native id (`session-<uuid>` under `$DSH_HOME/sessions/`).
There is no `--session-id` pin — the control plane **adopts** whatever the
CLI created, the same way `kimi-code` does.

## What this package is

- **Argv + env + spawn** for the den-session form (`--profile tui`).
- **Session-id adoption** (`deepseek-harness:session-<uuid>`).
- **On-disk session listing** under `$DSH_HOME/sessions/<cwd-slug>/session-<uuid>/`.

## What it is not

- **Not a headless `HarnessExecutor`.** dsh has a `headless` profile, but it
  is not wired as a task executor in this PR. See `HARNESS_EXECUTOR_GAPS` in
  `@rivetos/core`. Tasks against this harness reject with that recorded gap.
- **Not hook-fed capture.** dsh has no Claude/kimi-style hooks. Memory capture
  is out-of-band via the Cordis `session/event` plugin
  (`integrations/deepseek/rivet-memory`). This package never installs hooks.

## Config

```yaml
tasks:
  harnesses:
    deepseek-harness:
      binary: /home/rivet/.local/bin/dsh   # absolute — den PATH has no ~/.local/bin
      model: deepseek-v4-flash
      cwd: /home/rivet/.rivetos/workspace
      home: /home/rivet/.dsh               # DSH_HOME
```

The model itself is pinned in `~/.dsh/cordis.patch.yml`; the config `model`
field is documentation + probe metadata, not a CLI flag (dsh has none for it
on the TUI path).

## Testing

`npm test` drives a fake `dsh` binary. No DeepSeek tokens are spent and the
operator's `~/.dsh` is never touched.
