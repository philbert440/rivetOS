# Phase 0.25 — Rivet User Migration Runbook

No RivetOS process runs as uid 0 after this phase. Every node runs all services
under a standard `rivet` user (uid 2000, group rivet, home `/home/rivet`).

**Migration order:** CT104 (smoke) → CT112 → CT110 (DataHub) → CT111 (Opus/Grok) → GERTY (Local)

---

## Overview

| Node | Role | Extra steps |
|------|------|-------------|
| CT104 | Smoke target (decommissioned, will be reprovisioned) | Just reprovision with updated scripts |
| CT112 | Agent (pve1) | Standard migration |
| CT110 | DataHub (pve2) — embedder + compactor | Verify workers; extra queue drain check |
| CT111 | Agent (pve1) — Opus + Grok | Last agent; validate mesh first |
| GERTY | Agent (Local, Qwen) | Standard migration |

---

## Pre-flight

```bash
# On the control plane — confirm branch is deployed
git -C /opt/rivetos log --oneline -3

# Verify CLI build is current
node /opt/rivetos/packages/cli/dist/index.js --version
```

---

## Dual-Key Window Explained

During the rolling cutover, both `root` and `rivet` SSH keys remain valid.
This means:

- `ssh root@<host>` still works → backwards-compatible
- `ssh rivet@<host>` works → new primary access path
- `update --mesh` tries `rivet@` first, falls back to `root@` with a warning

The root keys are **not** removed in this phase. That is a follow-up (Phase 0.26).

---

## Procedure: Standard Agent Node

Run on each node in order. SSH in, then:

```bash
# Pull latest code
ssh root@<host> "cd /opt/rivetos && git fetch origin && git reset --hard origin/main"

# Run migration script
ssh root@<host> "bash /opt/rivetos/infra/scripts/migrate-to-rivet-user.sh"
```

If the node is already migrated (marker exists), the script exits cleanly.

After the local migration completes, optionally run key distribution:

```bash
ssh root@<host> "bash /opt/rivetos/infra/scripts/migrate-to-rivet-user.sh --mesh-distribute"
```

---

## Procedure: CT104 (Smoke Target)

CT104 is the decommissioned OpenClaw box being reprovisioned as a fresh smoke target.
Coco's OpenClaw data is backed up at `/root/coco-openclaw-backup-2026-04-24.tar.gz` on pve2.

Use the updated `provision-ct.sh` which now bakes in the rivet user:

```bash
cd /opt/rivetos
bash infra/scripts/provision-ct.sh \
  --ctid 104 \
  --hostname rivet-smoke \
  --node pve1 \
  --ip 192.0.2.104 \
  --gateway 192.0.2.1 \
  --nameserver 192.0.2.1 \
  --agent smoke \
  --provider anthropic \
  --secrets-from 192.0.2.111
```

---

## Procedure: CT110 (DataHub — Special Care)

CT110 runs `rivet-embedder` and `rivet-compactor` alongside the main RivetOS agent.
The embedding queue must keep draining; a restart gap is expected but should be brief.

```bash
# 1. Check current queue depth before migration
ssh root@192.0.2.110 "psql -U rivetdb -c 'SELECT count(*) FROM rivet_embed_queue WHERE embedded_at IS NULL;'"

# 2. Run migration
ssh root@192.0.2.110 "bash /opt/rivetos/infra/scripts/migrate-to-rivet-user.sh"

# 3. Verify all three services came back
ssh rivet@192.0.2.110 "sudo systemctl is-active rivetos rivet-embedder rivet-compactor"

# 4. Check queue is still draining (run a few times over 2 minutes)
ssh rivet@192.0.2.110 "psql -U rivetdb -c 'SELECT count(*) FROM rivet_embed_queue WHERE embedded_at IS NULL;'"
```

If the `setup-workers.sh` script needs to be re-run (e.g., to re-apply the updated service units):

```bash
ssh root@192.0.2.110 "bash /opt/rivetos/infra/containers/datahub/setup-workers.sh"
```

---

## Procedure: CT111 (Opus + Grok — Last)

CT111 is last intentionally — Phil and Opus need to validate the mesh is healthy
from already-migrated nodes before touching this one.

```bash
# From a migrated node or control plane, verify mesh is healthy
node /opt/rivetos/packages/cli/dist/index.js mesh ping

# Then migrate CT111
ssh root@192.0.2.111 "bash /opt/rivetos/infra/scripts/migrate-to-rivet-user.sh"
```

---

## Validation Checklist

Run on each node immediately after migration:

```bash
HOST=<node-ip>

# 1. rivet user exists with correct uid
ssh rivet@$HOST "id rivet"
# Expected: uid=2000(rivet) gid=2000(rivet) groups=2000(rivet),27(sudo)

# 2. Service properties
ssh rivet@$HOST "sudo systemctl show rivetos -p User -p Group -p WorkingDirectory"
# Expected: User=rivet  Group=rivet  WorkingDirectory=/opt/rivetos

# 3. Service active
ssh rivet@$HOST "sudo systemctl is-active rivetos"
# Expected: active

# 4. No permission errors in logs for 60s
ssh rivet@$HOST "sudo journalctl -u rivetos -n 30 --no-pager"
# Expected: no 'Permission denied' or EACCES errors

# 5. claude CLI works as rivet (if applicable)
ssh rivet@$HOST "sudo -u rivet claude --dangerously-skip-permissions --help 2>&1 | head -3"
# Expected: exits 0 (help text shown)

# 6. Phil's key works for both users
ssh rivet@$HOST "echo ok"   # rivet user
ssh root@$HOST "echo ok"    # root user (dual-key window)

# 7. update --mesh from another migrated node reaches this one as rivet
node /opt/rivetos/packages/cli/dist/index.js update --mesh --no-restart
# Expected: no "falling back to root" warnings for migrated nodes
```

### DataHub-specific (CT110 only)

```bash
HOST=192.0.2.110

# Embedder + compactor active as rivet
ssh rivet@$HOST "sudo systemctl show rivet-embedder -p User --value"
# Expected: rivet
ssh rivet@$HOST "sudo systemctl show rivet-compactor -p User --value"
# Expected: rivet

# Services active
ssh rivet@$HOST "sudo systemctl is-active rivet-embedder rivet-compactor"
# Expected: active active

# Embedding queue draining
ssh rivet@$HOST "psql -U rivetdb -c 'SELECT count(*) FROM rivet_embed_queue WHERE embedded_at IS NULL;'"
# Run twice 60s apart; count should decrease or hold steady (no new work)
```

---

## Rollback Procedure

If a node fails to start after migration:

### Option 1: Revert service unit to root (fast)

```bash
ssh root@<host> "cat > /etc/systemd/system/rivetos.service << 'EOF'
[Unit]
Description=RivetOS Agent Runtime
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/rivetos
ExecStart=/usr/bin/npx tsx packages/cli/src/index.ts start --config /root/.rivetos/config.yaml
EnvironmentFile=/root/.rivetos/.env
Environment=HOME=/root
Environment=RIVETOS_LOG_LEVEL=info
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload && systemctl restart rivetos"
```

Then restore config/env if they were moved:

```bash
# If .rivetos was moved but service still needs /root
ssh root@<host> "ln -sf /home/rivet/.rivetos /root/.rivetos || true"
```

### Option 2: Re-provision from scratch (last resort)

```bash
bash infra/scripts/provision-ct.sh --ctid <id> --skip-destroy ...
```

### Removing the migration marker (to re-run migration)

```bash
ssh root@<host> "rm /home/rivet/.rivetos/.migrated"
```

---

## Post-Migration Notes

- Root SSH keys are **intentionally retained** in this phase. Phase 0.26 will strip them.
- `update --mesh` will warn `[warn] node X not yet migrated to rivet user, falling back to root` for any nodes still running as root. This is expected during rolling cutover.
- GERTY runs the Local (Qwen) agent — it follows the same `migrate-to-rivet-user.sh` procedure.

---

## Files Changed in Phase 0.25

| File | Change |
|------|--------|
| `infra/scripts/migrate-to-rivet-user.sh` | **New** — one-shot migration script |
| `infra/scripts/provision-ct.sh` | Updated — rivet user, `--legacy-root-keys` flag |
| `infra/containers/datahub/setup-workers.sh` | Updated — User=rivet for both workers |
| `packages/cli/src/commands/update.ts` | `rivet@` default, `--ssh-user`, auto-fallback to root |
| `packages/cli/src/commands/mesh.ts` | SSH checks use rivet@ with root@ fallback |
| `packages/cli/src/commands/keys.ts` | `--ssh-user`, dual-key rotate, rivet+root status |
| `packages/cli/src/commands/doctor.ts` | Service user check (warns if still root) |
