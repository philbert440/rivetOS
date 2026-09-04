# herdr integration — per-node provisioning

[herdr](https://herdr.dev) is the optional terminal mux backend for the den
(backend lane: `feat/den-herdr-backend`). This directory is everything
*around* the backend so a node can flip the flag safely. **Nothing changes
behavior on nodes that don't opt in** — provisioning only places the binary
and manifests; herdr runs nothing until the den's `term.mux` flips.

## The pin

We run **herdr 0.8.2** exactly (protocol 20). The upstream installer
(`curl -fsSL https://herdr.dev/install.sh | sh`) has **no version-pin
support** — it always fetches `latest.json` (verified 2026-09-04) — so the
pinned install path is a sha256-verified staged binary on the fleet share:

- staged binary: `/rivet-shared/fidelity/bin/herdr-0.8.2`
- sha256: `976150a14d490c94b243ea2e1a7eb2dfb67f12e36b182db90936f6728e6aecf4`
- install target: `~/.local/bin/herdr` (`herdr --version` must print `herdr 0.8.2`)

## Provisioning a node

```sh
rivetos install --herdr
```

Idempotent. It:

1. installs the pinned binary to `~/.local/bin/herdr` (sha256-verified against
   the pin before anything is copied; version-verified after), and
2. drops the manifest overrides from `manifests/*.toml` into herdr's remote
   cache dir (see below), backing up a diverging existing file to
   `<agent>.toml.orig` (the first backup is never clobbered).

`rivetos update` runs the same step non-fatally **only on nodes that opted in**
(`RIVETOS_DEN_TERM_MUX=herdr` in the process env, else in the unit's
EnvironmentFile `~/.rivetos/.env`, else YAML `den.terminal.mux`; a shell-launched
update does not inherit the EnvironmentFile, so it is read explicitly): a node without the staged
binary (off-fleet, offline) skips quietly; a verification failure warns but
never blocks the update. `--from-upstream` opts into the unpinned upstream
installer as a fallback and fails unless it lands exactly 0.8.2.

`rivetos doctor` reports the `herdr` row: binary present, version == 0.8.2,
manifest overrides current, and the `term.mux` value — warn (not fail) when
`term.mux=herdr` but the binary is missing.

## Manifest overrides (the undocumented channel)

herdr 0.8.2 does **not** honor `~/.local/state/herdr/agent-detection/local/`
(verified). The working override channel: drop a manifest with a **higher
version** into

```
~/.local/state/herdr/agent-detection/remote/<agent>.toml
```

herdr uses the newest manifest and its updater then leaves it alone
("remote version … is older than cached"). Our manifests carry
`version = "2099.01.01.1"` for exactly this reason.

- `manifests/grok.toml` — status-line-based working/idle detection for
  grok 1.0.13, which never changes its OSC title and emits no `[stop]` chip
  (evidence: live pane reads on ct112, 2026-09-04).

## Flipping `term.mux`

The den reads the mux from `RIVETOS_DEN_TERM_MUX` (there is no YAML mux key
on main today):

```sh
RIVETOS_DEN_TERM=1 RIVETOS_DEN_TERM_MUX=herdr
```

Requires terminals enabled (`RIVETOS_DEN_TERM=1`) and, for herdr panes, the
pinned binary provisioned as above. The backend itself lands with
`feat/den-herdr-backend`; on main today any value other than `tmux`/`none`
fails safe to `none`.

## Memory hook pane identity

Do **not** run `herdr integration install claude` (or grok) — it rewrites the
harness `settings.json` to add its own SessionStart hook. Instead the
rivet-memory hook scripts (`integrations/claude-code/rivet-memory`,
`integrations/grok/rivet-memory`) report the pane themselves: when
`HERDR_PANE_ID` + `HERDR_SOCKET_PATH` are present in the pane env, they POST
`pane.report_agent_session` (newline-JSON over the session socket) with the
harness session id + transcript path via
`integrations/shared/herdr-report-session.mjs`, and stamp
pane/workspace/host into captured message metadata
(`herdr_pane_id` / `herdr_workspace_id` / `herdr_host`). Silent no-op when
not under herdr.

## Refreshing the schema reference

`schema/herdr-api.schema.json` is the pinned API reference (255 KB, 117
methods). The vitest in `schema/herdr-schema.test.ts` asserts every
method/event the den backend depends on (`workspace.create`, `pane.list`,
`agent.start/get/read/list`, `session.snapshot`, `events.subscribe` + event
`pane.agent_status_changed`, `pane.report_agent_session`). To bump herdr:

```sh
# 1. bump HERDR_VERSION + HERDR_SHA256 in packages/cli/src/lib/herdr.ts
# 2. regenerate the reference and review the diff
scripts/herdr-schema-refresh.sh
git diff integrations/herdr/schema/herdr-api.schema.json
# 3. the schema test fails if a depended-on method was removed/reshaped
```

## Verifying a live pane

```sh
herdr agent list                 # agents herdr sees, with status
herdr agent get <pane>           # shows the reported session id after a hook fire
herdr agent explain <pane>       # which manifest rule produced the status
```
