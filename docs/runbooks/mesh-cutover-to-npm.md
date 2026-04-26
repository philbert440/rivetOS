# Mesh Cutover to `npm install -g`

This runbook covers the one-time migration of the live RivetOS mesh
(ct111-ct114) from the historical **git-clone + tsx + nx build** deploy
path to **`npm install -g @rivetos/cli`** as the runtime artifact.

## Why

- Live mesh deploys today rely on every CT having a full source checkout at
  `/opt/rivetos`, running TypeScript directly via `tsx`, and rebuilding on
  every `update --mesh`.
- Source-on-CTs encourages "edit on a CT" foot-guns that have bitten Grok
  and Gemini in the past.
- npm is already the canonical distribution channel for `@rivetos/*`
  packages — using it for the live mesh closes the loop and puts every
  consumer (live CTs, future external Phase 4 container, third-party
  installs) on the same artifact.
- Removes the Alpine/Docker build chain as a deploy concern.

## End state

```bash
# Per-CT deploy (after cutover)
npm install -g @rivetos/cli@<channel>   # @beta on main, @latest on tags
systemctl restart rivetos
```

- `/opt/rivetos` becomes a stale dev artifact (not deleted in this PR; left
  as a one-cycle rollback path)
- Source dev still happens in `/rivet-shared/RivetOS` — unchanged
- `update --mesh --npm` is the new deploy verb (see PR #126); after this
  cutover, future PRs may flip `--npm` to be the default

## Prerequisites

1. **PR #123 merged** — workspace protocol cleanup, `0.4.0-beta.2` graph
2. **PR #124 merged** — publish workflow triggers on push to main
3. **PR #125 merged** — `@rivetos/cli` is installable globally
4. **PR #126 merged** — `update --mesh --npm` available
5. **First publish on main has happened** — verify with:
   ```
   npm view @rivetos/cli@beta version
   # → 0.4.0-beta.2 (or higher)
   ```
6. **Throwaway-LXC dry run done** (optional but recommended): create a
   scratch LXC, `npm install -g @rivetos/cli@beta`, drop a config in,
   confirm `rivetos start` reaches `[Runtime] Ready.`

## Cutover steps

### 0. Pre-flight

From the control-plane node (where you run `rivetos update --mesh`):

```bash
# Confirm all 4 agent CTs are on the same git commit and healthy
rivetos mesh ping
rivetos mesh list

# Confirm latest beta is published
npm view @rivetos/cli@beta version
```

If any CT is unhealthy, fix that first — don't migrate a sick node.

### 1. Snapshot the existing /opt/rivetos checkouts (rollback path)

```bash
for ct in ct111 ct112 ct113 ct114; do
  ssh rivet@$ct "sudo cp -a /opt/rivetos /opt/rivetos.pre-npm"
done
```

Cheap, fast, gives a one-command rollback if cutover fails for any reason
(`mv /opt/rivetos /opt/rivetos.failed && mv /opt/rivetos.pre-npm /opt/rivetos`).

### 2. Cutover (rolling, automated)

```bash
rivetos update --mesh --npm
```

This:

- SSHes to each agent CT in parallel
- Runs `npm install -g @rivetos/cli@beta` (with sudo fallback)
- Idempotently rewrites the systemd `ExecStart` from the old `npx tsx
  packages/cli/src/index.ts` path to the new global `rivetos` bin shim
- `systemctl daemon-reload && systemctl restart rivetos`
- Health-checks `/health/live` for each agent
- Updates the local control-plane node last

If any node fails, the script prints which step failed and continues with
the others. Per-node rollback in step 4.

### 3. Post-cutover verification

```bash
# Per-CT — should report 0.4.0-beta.X (the channel version)
for ct in ct111 ct112 ct113 ct114; do
  echo "--- $ct ---"
  ssh rivet@$ct "rivetos version"
  ssh rivet@$ct "systemctl is-active rivetos"
  ssh rivet@$ct "grep ExecStart /etc/systemd/system/rivetos.service"
done

# Mesh ping — all 4 nodes online
rivetos mesh ping

# Optional smoke test — round-trip a delegate_task across the mesh
rivetos test delegate-matrix    # if available
```

### 4. Rollback (if a node misbehaves)

For a single node:

```bash
ssh rivet@<ct> '
  sudo systemctl stop rivetos
  sudo mv /etc/systemd/system/rivetos.service /etc/systemd/system/rivetos.service.npm
  # restore old unit (the per-CT pre-npm snapshot has the original)
  sudo cp /opt/rivetos.pre-npm/infra/etc/rivetos.service /etc/systemd/system/rivetos.service 2>/dev/null \
    || sudo sed -i "s|^ExecStart=.*|ExecStart=/usr/bin/npx tsx packages/cli/src/index.ts start --config %h/.rivetos/config.yaml|" /etc/systemd/system/rivetos.service
  sudo systemctl daemon-reload
  sudo systemctl restart rivetos
'
```

Or fall back to the full `/opt/rivetos.pre-npm` snapshot:

```bash
ssh rivet@<ct> "sudo systemctl stop rivetos && \
  sudo mv /opt/rivetos /opt/rivetos.failed && \
  sudo mv /opt/rivetos.pre-npm /opt/rivetos && \
  sudo systemctl restart rivetos"
```

### 5. Cleanup (after one-cycle of stable operation)

Once everything has been stable for a day or so:

```bash
for ct in ct111 ct112 ct113 ct114; do
  ssh rivet@$ct "sudo rm -rf /opt/rivetos.pre-npm /opt/rivetos.failed"
done
```

Optionally also: `sudo rm -rf /opt/rivetos` (the original) once you are
absolutely certain nothing on the system references it. Worker services
(embedder, compactor) on the datahub still reference `/opt/rivetos` —
**leave datahub alone in this cutover**.

## What this PR ships

- **`infra/scripts/provision-ct.sh`** — new `--deploy-method npm` mode and
  `--npm-channel <tag>` option. Newly-provisioned CTs go straight to the
  npm-installed shape — no git clone, no source build. systemd unit is
  generated with `ExecStart=$(which rivetos) start ...` and
  `WorkingDirectory=$RIVET_HOME` (no `/opt/rivetos` dependency).
- **`docs/runbooks/mesh-cutover-to-npm.md`** — this file.

## What this PR does NOT do

- Does **not** flip `--npm` to be the default in `update --mesh`. Still
  opt-in. Flip in a follow-up after the cutover has been stable for a
  cycle.
- Does **not** migrate datahub workers (embedder, compactor). Those keep
  the git path; package and migrate them separately.
- Does **not** delete `/opt/rivetos`. Leaves it as a rollback path.

## Followups (separate PRs)

1. Flip `--npm` to be the default in `update --mesh`; rename `--git` to be
  the explicit-opt-in for emergencies.
2. Migrate `services/embedding-worker` and `services/compaction-worker` to
  publishable npm packages so datahub can use the same deploy path.
3. Delete `/opt/rivetos` from all CTs after one stable cycle.
