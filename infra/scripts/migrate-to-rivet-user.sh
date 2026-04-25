#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# RivetOS — Migrate existing node from root to rivet user (Phase 0.25)
# ──────────────────────────────────────────────────────────────────────────────
#
# Idempotent: a marker file at /home/rivet/.rivetos/.migrated prevents re-runs.
#
# Usage:
#   sudo bash infra/scripts/migrate-to-rivet-user.sh
#   sudo bash infra/scripts/migrate-to-rivet-user.sh --distribute-keys
#
# Options:
#   --distribute-keys   After local migration, exchange rivet pubkeys with all
#                       mesh peers listed in config.yaml (dual-key window:
#                       keys land in both /home/rivet and /root authorized_keys).
#
# Requirements: must be run as root on the target node.
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

RIVET_UID=2000
RIVET_GID=2000
RIVET_HOME="/home/rivet"
RIVETOS_DIR="/opt/rivetos"
RIVETOS_DATA="${RIVET_HOME}/.rivetos"
MARKER="${RIVETOS_DATA}/.migrated"
DISTRIBUTE_KEYS=false

# ── Helpers ─────────────────────────────────────────────────────────────────

log()  { echo -e "\033[1;36m[rivet-migrate]\033[0m $*"; }
warn() { echo -e "\033[1;33m[rivet-migrate]\033[0m $*"; }
err()  { echo -e "\033[1;31m[rivet-migrate]\033[0m $*" >&2; }
die()  { err "$*"; exit 1; }

# ── Argument parsing ─────────────────────────────────────────────────────────

for arg in "$@"; do
    case "$arg" in
        --distribute-keys) DISTRIBUTE_KEYS=true ;;
        --help|-h)
            echo "Usage: sudo bash migrate-to-rivet-user.sh [--distribute-keys]"
            exit 0 ;;
        *) die "Unknown option: $arg" ;;
    esac
done

# ── Pre-flight ───────────────────────────────────────────────────────────────

[[ $EUID -eq 0 ]] || die "Must be run as root."

if [[ -f "$MARKER" ]]; then
    MIGRATED_AT=$(cat "$MARKER")
    log "Already migrated (marker: ${MARKER}, timestamp: ${MIGRATED_AT})."
    log "If you need to re-run, remove the marker first: rm ${MARKER}"
    if $DISTRIBUTE_KEYS; then
        log "--distribute-keys requested on already-migrated node — running key exchange only."
        # Jump straight to key distribution
        distribute_keys_only=true
    else
        exit 0
    fi
else
    distribute_keys_only=false
fi

# ── Step 0: Confirm services that will be managed ────────────────────────────

SERVICES=("rivetos")
for svc in rivet-embedder rivet-compactor; do
    if systemctl cat "$svc" &>/dev/null; then
        SERVICES+=("$svc")
    fi
done
log "Services to migrate: ${SERVICES[*]}"

if ! $distribute_keys_only; then

# ── Step 1: Create rivet group + user ────────────────────────────────────────

log "Step 1: Creating rivet user (uid ${RIVET_UID})..."
if getent group rivet &>/dev/null; then
    log "  Group 'rivet' already exists."
else
    groupadd --gid "${RIVET_GID}" rivet
    log "  Group 'rivet' created (gid ${RIVET_GID})."
fi

if id rivet &>/dev/null; then
    log "  User 'rivet' already exists."
else
    useradd \
        --uid "${RIVET_UID}" \
        --gid rivet \
        --home-dir "${RIVET_HOME}" \
        --create-home \
        --shell /bin/bash \
        rivet
    log "  User 'rivet' created."
fi

# Add to sudo group
usermod -aG sudo rivet
log "  'rivet' added to sudo group."

# ── Step 2: Generate SSH keypair for rivet ───────────────────────────────────

log "Step 2: SSH keypair for rivet..."
mkdir -p "${RIVET_HOME}/.ssh"
chmod 700 "${RIVET_HOME}/.ssh"

if [[ -f "${RIVET_HOME}/.ssh/id_ed25519" ]]; then
    log "  Keypair already exists — skipping generation."
else
    ssh-keygen -t ed25519 \
        -f "${RIVET_HOME}/.ssh/id_ed25519" \
        -N "" \
        -C "rivet@$(hostname)"
    log "  Keypair generated: ${RIVET_HOME}/.ssh/id_ed25519"
fi

RIVET_PUBKEY=$(cat "${RIVET_HOME}/.ssh/id_ed25519.pub")

# ── Step 3: Move /root/.rivetos → /home/rivet/.rivetos ───────────────────────

log "Step 3: Migrating .rivetos data directory..."
if [[ -d "/root/.rivetos" ]]; then
    if [[ -d "${RIVETOS_DATA}" ]]; then
        warn "  ${RIVETOS_DATA} already exists — merging (not overwriting)."
        # Only copy files that don't exist yet
        rsync -a --ignore-existing /root/.rivetos/ "${RIVETOS_DATA}/"
        warn "  Merged. Original /root/.rivetos left in place — remove manually after verification."
    else
        mv /root/.rivetos "${RIVETOS_DATA}"
        log "  Moved /root/.rivetos → ${RIVETOS_DATA}"
    fi
else
    mkdir -p "${RIVETOS_DATA}/workspace/memory" "${RIVETOS_DATA}/workspace/skills"
    log "  No /root/.rivetos found — created fresh ${RIVETOS_DATA}."
fi

# ── Step 4: Fix absolute /root/.rivetos paths inside config.yaml ─────────────

CONFIG_YAML="${RIVETOS_DATA}/config.yaml"
log "Step 4: Patching absolute paths in config.yaml..."
if [[ -f "$CONFIG_YAML" ]]; then
    # Use a temp file to avoid partial-write if sed fails
    TMPFILE=$(mktemp)
    sed "s|/root/\.rivetos|${RIVETOS_DATA}|g" "$CONFIG_YAML" > "$TMPFILE"
    mv "$TMPFILE" "$CONFIG_YAML"
    log "  Patched: /root/.rivetos → ${RIVETOS_DATA} in config.yaml"
else
    warn "  config.yaml not found — skipping path patch."
fi

# ── Step 5: Move /root/.claude if present ────────────────────────────────────

log "Step 5: Migrating .claude directory..."
if [[ -d "/root/.claude" ]]; then
    if [[ -d "${RIVET_HOME}/.claude" ]]; then
        warn "  ${RIVET_HOME}/.claude already exists — skipping."
    else
        mv /root/.claude "${RIVET_HOME}/.claude"
        log "  Moved /root/.claude → ${RIVET_HOME}/.claude"
    fi
else
    log "  No /root/.claude found — nothing to move."
fi

# ── Step 6: Fix ownership ────────────────────────────────────────────────────

log "Step 6: Fixing ownership..."
chown -R rivet:rivet "${RIVETOS_DIR}" "${RIVET_HOME}"
log "  chown -R rivet:rivet ${RIVETOS_DIR} ${RIVET_HOME}"

# ── Step 7: Authorized keys — copy root keys → rivet, deduplicated ───────────

log "Step 7: Copying authorized_keys from root → rivet..."
RIVET_AUTH="${RIVET_HOME}/.ssh/authorized_keys"
ROOT_AUTH="/root/.ssh/authorized_keys"

# Start from existing rivet keys (possibly just the generated pubkey)
touch "$RIVET_AUTH"
if [[ -f "$ROOT_AUTH" ]]; then
    # Append root's keys (dedup handled by sort -u)
    cat "$ROOT_AUTH" >> "$RIVET_AUTH"
fi
# Ensure rivet's own pubkey is in there
echo "$RIVET_PUBKEY" >> "$RIVET_AUTH"
sort -u "$RIVET_AUTH" -o "$RIVET_AUTH"
chmod 600 "$RIVET_AUTH"
chown rivet:rivet "$RIVET_AUTH"
log "  authorized_keys: $(wc -l < "$RIVET_AUTH") entries."

# ── Step 8: Rewrite systemd service units ────────────────────────────────────

log "Step 8: Rewriting systemd service units..."

# Helper: write the main rivetos.service
write_rivetos_service() {
    log "  Writing /etc/systemd/system/rivetos.service..."
    TMPUNIT=$(mktemp)
    cat > "$TMPUNIT" << SVCEOF
[Unit]
Description=RivetOS Agent Runtime
After=network.target

[Service]
Type=simple
User=rivet
Group=rivet
WorkingDirectory=${RIVETOS_DIR}
ExecStart=/usr/bin/npx tsx packages/cli/src/index.ts start --config ${RIVETOS_DATA}/config.yaml
EnvironmentFile=${RIVETOS_DATA}/.env
Environment=HOME=${RIVET_HOME}
Environment=RIVETOS_LOG_LEVEL=info
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

# Hardening
ProtectSystem=strict
ProtectHome=false
ReadWritePaths=${RIVET_HOME} /rivet-shared ${RIVETOS_DIR}

[Install]
WantedBy=multi-user.target
SVCEOF
    mv "$TMPUNIT" /etc/systemd/system/rivetos.service
    log "  rivetos.service written."
}

# Helper: write rivet-embedder.service (DataHub only)
write_embedder_service() {
    local services_dir="${RIVETOS_DIR}/services"
    local config_dir="/etc/rivetos"
    log "  Writing /etc/systemd/system/rivet-embedder.service..."
    TMPUNIT=$(mktemp)
    cat > "$TMPUNIT" << SVCEOF
[Unit]
Description=RivetOS Embedding Worker — event-driven via Postgres NOTIFY
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
User=rivet
Group=rivet
WorkingDirectory=${services_dir}/embedding-worker
ExecStart=/usr/bin/node ${services_dir}/embedding-worker/index.js
Restart=always
RestartSec=5
EnvironmentFile=${config_dir}/embedder.env
Environment=HOME=${RIVET_HOME}

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=rivet-embedder

# Resource limits
MemoryMax=512M
CPUQuota=50%

# Hardening
ProtectSystem=strict
ProtectHome=false
ReadWritePaths=${RIVET_HOME} /rivet-shared ${RIVETOS_DIR}

[Install]
WantedBy=multi-user.target
SVCEOF
    mv "$TMPUNIT" /etc/systemd/system/rivet-embedder.service
    log "  rivet-embedder.service written."
}

# Helper: write rivet-compactor.service (DataHub only)
write_compactor_service() {
    local services_dir="${RIVETOS_DIR}/services"
    local config_dir="/etc/rivetos"
    log "  Writing /etc/systemd/system/rivet-compactor.service..."
    TMPUNIT=$(mktemp)
    cat > "$TMPUNIT" << SVCEOF
[Unit]
Description=RivetOS Compaction Worker — event-driven summarization via Postgres NOTIFY
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
User=rivet
Group=rivet
WorkingDirectory=${services_dir}/compaction-worker
ExecStart=/usr/bin/node ${services_dir}/compaction-worker/index.js
Restart=always
RestartSec=10
EnvironmentFile=${config_dir}/compactor.env
Environment=HOME=${RIVET_HOME}

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=rivet-compactor

# Resource limits
MemoryMax=512M
CPUQuota=50%

# Hardening
ProtectSystem=strict
ProtectHome=false
ReadWritePaths=${RIVET_HOME} /rivet-shared ${RIVETOS_DIR}

[Install]
WantedBy=multi-user.target
SVCEOF
    mv "$TMPUNIT" /etc/systemd/system/rivet-compactor.service
    log "  rivet-compactor.service written."
}

write_rivetos_service

# DataHub workers — only rewrite if they exist
if systemctl cat rivet-embedder &>/dev/null; then
    write_embedder_service
fi
if systemctl cat rivet-compactor &>/dev/null; then
    write_compactor_service
fi

# ── Step 9: Reload systemd + restart services ─────────────────────────────────

log "Step 9: Reloading systemd and restarting services..."
systemctl daemon-reload

for svc in "${SERVICES[@]}"; do
    log "  Restarting ${svc}..."
    systemctl restart "$svc" || {
        err "  Failed to restart ${svc}! Check: journalctl -u ${svc} -n 50"
        die "Halting — service restart failed. The unit file is intact; fix and re-run."
    }
done

# Short pause then verify
sleep 3
log "  Verifying service user..."
ACTUAL_USER=$(systemctl show rivetos -p User --value)
if [[ "$ACTUAL_USER" == "rivet" ]]; then
    log "  ✅ rivetos running as user='rivet'"
else
    die "  rivetos User is '${ACTUAL_USER}', expected 'rivet'. Check journalctl."
fi

for svc in "${SERVICES[@]}"; do
    STATE=$(systemctl is-active "$svc" || true)
    if [[ "$STATE" == "active" ]]; then
        log "  ✅ ${svc}: active"
    else
        warn "  ⚠ ${svc}: ${STATE} — check journalctl -u ${svc} -n 30"
    fi
done

# ── Step 10: Write marker ─────────────────────────────────────────────────────

log "Step 10: Writing migration marker..."
date -Iseconds > "$MARKER"
chown rivet:rivet "$MARKER"
log "  Marker written: ${MARKER}"

fi  # end: if ! $distribute_keys_only

# ── Step 11 (optional): Distribute keys across mesh ──────────────────────────

if $DISTRIBUTE_KEYS; then
    log "Step 11: Distributing rivet pubkey to mesh peers..."

    RIVET_PUBKEY=$(cat "${RIVET_HOME}/.ssh/id_ed25519.pub")

    # Parse peer IPs from config.yaml mesh section
    CONFIG_YAML="${RIVETOS_DATA}/config.yaml"
    PEER_IPS=()
    if [[ -f "$CONFIG_YAML" ]] && command -v python3 &>/dev/null; then
        mapfile -t PEER_IPS < <(python3 - "$CONFIG_YAML" <<'PYEOF'
import sys, re

try:
    # Try yaml module first
    import yaml
    with open(sys.argv[1]) as f:
        cfg = yaml.safe_load(f)
    mesh = cfg.get('mesh', {})
    nodes = mesh.get('nodes', [])
    for node in nodes:
        host = node.get('host') or node.get('ip', '')
        if host:
            print(host)
    sys.exit(0)
except ImportError:
    pass

# Fallback: regex scrape for host/ip lines under [mesh]
with open(sys.argv[1]) as f:
    content = f.read()
# Look for host: <ip> patterns (rough but works for simple configs)
for m in re.finditer(r'host:\s*([0-9]{1,3}(?:\.[0-9]{1,3}){3})', content):
    print(m.group(1))
PYEOF
        2>/dev/null || true)
    fi

    if [[ ${#PEER_IPS[@]} -eq 0 ]]; then
        warn "  No peer IPs found in config.yaml mesh section. Skipping key distribution."
        warn "  If mesh is defined elsewhere, exchange keys manually."
    else
        MY_IP=$(hostname -I | awk '{print $1}')
        for PEER in "${PEER_IPS[@]}"; do
            [[ "$PEER" == "$MY_IP" ]] && continue
            [[ -z "$PEER" ]] && continue

            log "  Checking peer ${PEER}..."

            # Check if peer has the rivet user migrated already
            if ! ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no \
                    -o BatchMode=yes "rivet@${PEER}" "echo ok" &>/dev/null && \
               ! ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no \
                    -o BatchMode=yes "root@${PEER}" \
                    "test -d /home/rivet/.ssh" &>/dev/null; then
                warn "  Peer ${PEER}: /home/rivet/.ssh does not exist yet (not migrated). Skipping."
                continue
            fi

            # Function to push our pubkey to a peer user's authorized_keys
            push_key_to_peer() {
                local user="$1"
                local peer="$2"
                local key="$3"
                # Try rivet@ first, then root@
                local target_user
                for target_user in rivet root; do
                    if ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no \
                            -o BatchMode=yes "${target_user}@${peer}" \
                            "mkdir -p /home/${user}/.ssh && \
                             echo '${key}' >> /home/${user}/.ssh/authorized_keys && \
                             sort -u /home/${user}/.ssh/authorized_keys \
                                  -o /home/${user}/.ssh/authorized_keys && \
                             chown -R ${user}:${user} /home/${user}/.ssh && \
                             chmod 700 /home/${user}/.ssh && \
                             chmod 600 /home/${user}/.ssh/authorized_keys" 2>/dev/null; then
                        return 0
                    fi
                done
                return 1
            }

            # Append our rivet pubkey to peer's rivet authorized_keys
            if push_key_to_peer rivet "$PEER" "$RIVET_PUBKEY"; then
                log "  ✅ Our key added to ${PEER}:/home/rivet/.ssh/authorized_keys"
            else
                warn "  Could not push key to rivet@${PEER} — manual exchange needed."
            fi

            # Also mirror to peer's root authorized_keys (dual-key window)
            for ssh_user in rivet root; do
                if ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no \
                        -o BatchMode=yes "${ssh_user}@${PEER}" \
                        "echo '${RIVET_PUBKEY}' >> /root/.ssh/authorized_keys && \
                         sort -u /root/.ssh/authorized_keys -o /root/.ssh/authorized_keys" \
                        2>/dev/null; then
                    log "  ✅ Our key also added to ${PEER}:/root/.ssh/authorized_keys (dual-key)"
                    break
                fi
            done

            # Pull peer's rivet pubkey and add to our authorized_keys
            PEER_RIVET_KEY=""
            for ssh_user in rivet root; do
                PEER_RIVET_KEY=$(ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no \
                    -o BatchMode=yes "${ssh_user}@${PEER}" \
                    "cat /home/rivet/.ssh/id_ed25519.pub 2>/dev/null" 2>/dev/null || true)
                [[ -n "$PEER_RIVET_KEY" ]] && break
            done

            if [[ -n "$PEER_RIVET_KEY" ]]; then
                RIVET_AUTH="${RIVET_HOME}/.ssh/authorized_keys"
                echo "$PEER_RIVET_KEY" >> "$RIVET_AUTH"
                sort -u "$RIVET_AUTH" -o "$RIVET_AUTH"
                chown rivet:rivet "$RIVET_AUTH"
                chmod 600 "$RIVET_AUTH"
                # Also mirror to root (dual-key window)
                if [[ -f "/root/.ssh/authorized_keys" ]]; then
                    echo "$PEER_RIVET_KEY" >> /root/.ssh/authorized_keys
                    sort -u /root/.ssh/authorized_keys -o /root/.ssh/authorized_keys
                fi
                log "  ✅ Peer ${PEER} rivet pubkey pulled into our authorized_keys (dual-key)"
            else
                warn "  Could not pull peer ${PEER}'s rivet pubkey."
            fi
        done
    fi
fi

# ── Summary ───────────────────────────────────────────────────────────────────

log ""
log "═══════════════════════════════════════════════════════════════"
log "  Migration complete!"
log "  Node:    $(hostname)"
log "  User:    rivet (uid ${RIVET_UID})"
log "  Home:    ${RIVET_HOME}"
log "  Data:    ${RIVETOS_DATA}"
log "  Marker:  ${MARKER}"
log ""
log "  Validation:"
log "    id rivet"
log "    systemctl show rivetos -p User -p Group -p WorkingDirectory"
log "    systemctl is-active rivetos"
log "    ssh rivet@$(hostname -I | awk '{print $1}') 'echo ok'"
log "═══════════════════════════════════════════════════════════════"
