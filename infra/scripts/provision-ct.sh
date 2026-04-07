#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# RivetOS — Proxmox LXC Container Provisioning Script
# ──────────────────────────────────────────────────────────────────────────────
#
# Creates a fresh Ubuntu 24.04 LXC container and bootstraps it as a RivetOS
# agent runtime. Generates config.yaml and .env from templates so you get a
# fully working agent with zero manual config steps.
#
# Usage:
#   ./provision-ct.sh --ctid 114 --hostname rivet-local --node pve3 \
#       --ip 10.4.20.114 --agent local --provider llama-server \
#       --model qwen2.5-coder-32b --base-url http://10.4.20.12:8000/v1 \
#       --secrets-from 10.4.20.111
#
# Prerequisites:
#   - SSH access to the Proxmox node (as root)
#   - Ubuntu 24.04 template in /var/lib/vz/template/cache/
#   - RivetOS repo cloned on this machine (the control plane)
#
set -euo pipefail

# ──────────────────────────────────────────────────────────────────────────────
# Config defaults
# ──────────────────────────────────────────────────────────────────────────────

CTID=""
HOSTNAME=""
PVE_NODE=""
IP=""
GATEWAY="10.4.20.1"
BRIDGE="vmbr0"
NAMESERVER="10.4.20.1"
CORES=4
MEMORY=8192
SWAP=2048
DISK=32
STORAGE="local-lvm"
TEMPLATE="ubuntu-24.04-standard_24.04-2_amd64.tar.zst"
SHARED_MOUNT=""       # Path to shared NFS mount on Proxmox host (optional)
DATAHUB_IP=""         # IP of DataHub CT (auto-detected from nodes.json or convention)
AGENT_NAME=""
PROVIDER_NAME=""
DEFAULT_MODEL=""      # Model name (auto-set per provider if empty)
BASE_URL=""           # Base URL for openai-compat/llama-server
RESTORE_FROM=""       # Path to backup tarball for workspace restoration
SECRETS_FROM=""       # IP of existing CT to pull shared secrets from
TELEGRAM_TOKEN=""     # Telegram bot token (written directly to .env)
DISCORD_TOKEN=""      # Discord bot token (written directly to .env)
DEPLOY_METHOD="git"   # git (default) or rsync
GIT_REPO="https://github.com/philbert440/rivetOS.git"
DRY_RUN=false
SKIP_DESTROY=false
PRIVILEGED=true       # Privileged CT with direct NFS mount (default for agent CTs)

# Derived paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SECRETS_DIR="${REPO_ROOT}/.secrets"
TEMPLATES_DIR="${SCRIPT_DIR}/../templates"

# ──────────────────────────────────────────────────────────────────────────────
# Parse args
# ──────────────────────────────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
    case $1 in
        --ctid)          CTID="$2";          shift 2;;
        --hostname)      HOSTNAME="$2";      shift 2;;
        --node)          PVE_NODE="$2";      shift 2;;
        --ip)            IP="$2";            shift 2;;
        --gateway)       GATEWAY="$2";       shift 2;;
        --bridge)        BRIDGE="$2";        shift 2;;
        --nameserver)    NAMESERVER="$2";    shift 2;;
        --cores)         CORES="$2";         shift 2;;
        --memory)        MEMORY="$2";        shift 2;;
        --swap)          SWAP="$2";          shift 2;;
        --disk)          DISK="$2";          shift 2;;
        --storage)       STORAGE="$2";       shift 2;;
        --template)      TEMPLATE="$2";      shift 2;;
        --agent)         AGENT_NAME="$2";    shift 2;;
        --provider)      PROVIDER_NAME="$2"; shift 2;;
        --model)         DEFAULT_MODEL="$2"; shift 2;;
        --base-url)      BASE_URL="$2";      shift 2;;
        --restore)       RESTORE_FROM="$2";  shift 2;;
        --secrets-from)  SECRETS_FROM="$2";  shift 2;;
        --telegram-token) TELEGRAM_TOKEN="$2"; shift 2;;
        --discord-token) DISCORD_TOKEN="$2"; shift 2;;
        --deploy-method) DEPLOY_METHOD="$2"; shift 2;;
        --git-repo)      GIT_REPO="$2";      shift 2;;
        --shared-mount)  SHARED_MOUNT="$2";  shift 2;;
        --datahub-ip)    DATAHUB_IP="$2";    shift 2;;
        --dry-run)       DRY_RUN=true;       shift;;
        --skip-destroy)  SKIP_DESTROY=true;  shift;;
        --privileged)    PRIVILEGED=true;     shift;;
        --unprivileged)  PRIVILEGED=false;    shift;;
        -h|--help)
            cat << 'HELPEOF'
Usage: provision-ct.sh --ctid ID --hostname NAME --node PVE --ip IP --agent AGENT --provider PROVIDER [options]

Required:
  --ctid        Container ID (e.g., 114)
  --hostname    Container hostname (e.g., rivet-local)
  --node        Proxmox node SSH alias or IP (e.g., pve3)
  --ip          Container IP (e.g., 10.4.20.114)
  --agent       RivetOS agent name (e.g., local, opus, grok, gemini)
  --provider    AI provider (anthropic, xai, google, llama-server, openai-compat)

Config Generation:
  --model       Model name (default: auto per provider)
  --base-url    Base URL for llama-server/openai-compat providers
  --secrets-from IP  Pull shared secrets (PG, embed, xAI) from existing CT
  --telegram-token   Telegram bot token for this agent
  --discord-token    Discord bot token for this agent

Deployment:
  --deploy-method    git (default) or rsync
  --git-repo         Git repo URL (default: https://github.com/philbert440/rivetOS.git)

Infrastructure:
  --storage     Proxmox storage backend (default: local-lvm)
  --cores       CPU cores (default: 4)
  --memory      RAM in MB (default: 8192)
  --disk        Disk in GB (default: 32)
  --gateway     Network gateway (default: 10.4.20.1)
  --privileged  Create privileged CT (default)
  --unprivileged  Create unprivileged CT
  --datahub-ip  IP of DataHub/NFS server (default: auto-detect or 10.4.20.110)
  --restore     Path to backup tarball for workspace restoration
  --dry-run     Print commands without executing
  --skip-destroy  Don't destroy existing CT
HELPEOF
            exit 0;;
        *) echo "Unknown option: $1"; exit 1;;
    esac
done

# Validate required args
for var in CTID HOSTNAME PVE_NODE IP AGENT_NAME PROVIDER_NAME; do
    if [[ -z "${!var}" ]]; then
        echo "ERROR: --$(echo $var | tr '[:upper:]' '[:lower:]' | tr '_' '-') is required"
        exit 1
    fi
done

# Validate deploy method
if [[ "$DEPLOY_METHOD" != "git" && "$DEPLOY_METHOD" != "rsync" ]]; then
    echo "ERROR: --deploy-method must be 'git' or 'rsync'"
    exit 1
fi

# Validate base-url for local providers
if [[ "$PROVIDER_NAME" == "llama-server" || "$PROVIDER_NAME" == "openai-compat" ]]; then
    if [[ -z "$BASE_URL" ]]; then
        echo "ERROR: --base-url is required for provider $PROVIDER_NAME"
        exit 1
    fi
fi

# Auto-set default model per provider if not specified
if [[ -z "$DEFAULT_MODEL" ]]; then
    case "$PROVIDER_NAME" in
        anthropic)      DEFAULT_MODEL="claude-opus-4-6";;
        xai)            DEFAULT_MODEL="grok-4.20-0309-reasoning";;
        google)         DEFAULT_MODEL="gemini-3-flash-preview";;
        llama-server)   DEFAULT_MODEL="default";;
        openai-compat)  DEFAULT_MODEL="default";;
        *)              DEFAULT_MODEL="default";;
    esac
fi

# Auto-set telegram token env var name
case "$PROVIDER_NAME" in
    xai) TELEGRAM_TOKEN_VAR="RIVETOS_TELEGRAM_TOKEN";;
    *)   TELEGRAM_TOKEN_VAR="TELEGRAM_BOT_TOKEN";;
esac

# ──────────────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────────────

log() { echo -e "\033[1;36m[rivetos]\033[0m $*"; }
warn() { echo -e "\033[1;33m[rivetos]\033[0m $*"; }
err() { echo -e "\033[1;31m[rivetos]\033[0m $*" >&2; }

run_on_pve() {
    if $DRY_RUN; then
        echo "[DRY RUN] ssh $PVE_NODE \"$*\""
    else
        ssh "$PVE_NODE" "$@"
    fi
}

run_on_ct() {
    if $DRY_RUN; then
        echo "[DRY RUN] ssh $PVE_NODE \"pct exec $CTID -- bash -c '$*'\""
    else
        ssh "$PVE_NODE" "pct exec $CTID -- bash -c '$*'"
    fi
}

# ──────────────────────────────────────────────────────────────────────────────
# Phase 0: Pre-flight checks
# ──────────────────────────────────────────────────────────────────────────────

log "Phase 0: Pre-flight checks..."

# Verify templates exist
TEMPLATE_FILE="${TEMPLATES_DIR}/config-${PROVIDER_NAME}.yaml"
if [[ ! -f "$TEMPLATE_FILE" ]]; then
    # Fall back to openai-compat for llama-server if no dedicated template
    if [[ "$PROVIDER_NAME" == "openai-compat" && -f "${TEMPLATES_DIR}/config-llama-server.yaml" ]]; then
        TEMPLATE_FILE="${TEMPLATES_DIR}/config-llama-server.yaml"
    else
        err "No config template found at: $TEMPLATE_FILE"
        err "Available templates: $(ls "${TEMPLATES_DIR}"/config-*.yaml 2>/dev/null | xargs -n1 basename)"
        exit 1
    fi
fi
ENV_TEMPLATE="${TEMPLATES_DIR}/env-${PROVIDER_NAME}.template"
if [[ ! -f "$ENV_TEMPLATE" ]]; then
    if [[ "$PROVIDER_NAME" == "openai-compat" && -f "${TEMPLATES_DIR}/env-llama-server.template" ]]; then
        ENV_TEMPLATE="${TEMPLATES_DIR}/env-llama-server.template"
    else
        err "No env template found at: $ENV_TEMPLATE"
        exit 1
    fi
fi
log "  Config template: $(basename "$TEMPLATE_FILE")"
log "  Env template:    $(basename "$ENV_TEMPLATE")"

# Verify control plane SSH key exists
CONTROL_PUBKEY_PATH="${HOME}/.ssh/id_ed25519.pub"
if [[ ! -f "$CONTROL_PUBKEY_PATH" ]]; then
    CONTROL_PUBKEY_PATH="${HOME}/.ssh/id_rsa.pub"
fi
if [[ ! -f "$CONTROL_PUBKEY_PATH" ]]; then
    err "No SSH public key found at ~/.ssh/id_ed25519.pub or ~/.ssh/id_rsa.pub"
    err "Generate one with: ssh-keygen -t ed25519"
    exit 1
fi
CONTROL_PUBKEY=$(cat "$CONTROL_PUBKEY_PATH")
log "  Control plane SSH key: ${CONTROL_PUBKEY_PATH}"

# For rsync deploy, verify repo is built
if [[ "$DEPLOY_METHOD" == "rsync" ]]; then
    if [[ ! -d "${REPO_ROOT}/node_modules" ]]; then
        err "RivetOS repo not built. Run 'npm ci' in ${REPO_ROOT} first."
        exit 1
    fi
fi

# Verify Proxmox node is reachable
if ! $DRY_RUN && ! ssh -o ConnectTimeout=5 "$PVE_NODE" "echo ok" &>/dev/null; then
    err "Cannot reach Proxmox node: $PVE_NODE"
    exit 1
fi
log "  Proxmox node reachable: $PVE_NODE"

# Auto-detect DataHub IP for NFS (used by both privileged and unprivileged paths)
if [[ -z "$DATAHUB_IP" ]]; then
    DATAHUB_IP=$(python3 -c "
import json
d = json.load(open('${SECRETS_DIR}/nodes.json'))
for n in d.get('nodes', {}).values():
    if n.get('agent') == 'datahub':
        print(n['ip'])
        break
" 2>/dev/null || echo "")
fi
if [[ -z "$DATAHUB_IP" ]]; then
    # Convention: DataHub is CT110 at x.x.x.110
    DATAHUB_IP="$(echo "$IP" | sed 's/\.[0-9]*$/.110/')"
    log "  Using convention DataHub IP: $DATAHUB_IP"
else
    log "  DataHub IP: $DATAHUB_IP"
fi

# For privileged CTs, NFS is mounted directly inside the container (Phase 3.5).
# For unprivileged CTs, we need a bind mount from the Proxmox host's NFS mount.
if ! $PRIVILEGED; then
    # Auto-detect or set up shared mount on Proxmox host (unprivileged path)
    if [[ -z "$SHARED_MOUNT" ]]; then
        if ssh -o ConnectTimeout=5 "$PVE_NODE" "test -d /mnt/shared && ls /mnt/shared/ &>/dev/null" &>/dev/null; then
            SHARED_MOUNT="/mnt/shared"
            log "  Auto-detected shared mount: /mnt/shared on $PVE_NODE"
        else
            NFS_HOST="$DATAHUB_IP"

            if [[ -n "$NFS_HOST" ]]; then
                log "  Setting up NFS mount from $NFS_HOST on $PVE_NODE..."
                ssh "$PVE_NODE" "bash -c '
                    apt-get install -y -qq nfs-common 2>/dev/null
                    mkdir -p /mnt/shared
                    if ! grep -q \"${NFS_HOST}:/shared\" /etc/fstab; then
                        echo \"${NFS_HOST}:/shared /mnt/shared nfs defaults,_netdev 0 0\" >> /etc/fstab
                    fi
                    mount /mnt/shared 2>/dev/null || mount -t nfs ${NFS_HOST}:/shared /mnt/shared
                '" 2>/dev/null
                if ssh "$PVE_NODE" "test -d /mnt/shared && ls /mnt/shared/ &>/dev/null" &>/dev/null; then
                    SHARED_MOUNT="/mnt/shared"
                    log "  NFS mount configured: ${NFS_HOST}:/shared → /mnt/shared on $PVE_NODE"
                else
                    log "  ⚠ Failed to mount NFS from $NFS_HOST. Continuing without shared storage."
                fi
            else
                log "  No NFS export found. Continuing without shared storage."
                log "  To set up shared storage, see docs/architecture.md"
            fi
        fi
    fi
else
    log "  Privileged mode: NFS will be mounted directly inside CT (Phase 3.5)"
fi

# ──────────────────────────────────────────────────────────────────────────────
# Phase 0.5: Fallback password
# ──────────────────────────────────────────────────────────────────────────────

# Check if we already have a fallback password stored
mkdir -p "$SECRETS_DIR"
NODES_FILE="${SECRETS_DIR}/nodes.json"

if [[ -f "$NODES_FILE" ]]; then
    FALLBACK_PASSWORD=$(python3 -c "import json; d=json.load(open('$NODES_FILE')); print(d.get('fallback_password', ''))" 2>/dev/null || echo "")
fi

if [[ -z "${FALLBACK_PASSWORD:-}" ]]; then
    log ""
    log "═══════════════════════════════════════════════════════════════"
    log "  Set a fallback password for all RivetOS nodes."
    log "  This lets you regain access with 'rivetos keys rotate'"
    log "  if your SSH key ever changes."
    log "═══════════════════════════════════════════════════════════════"
    log ""
    read -rsp "  Fallback password: " FALLBACK_PASSWORD
    echo ""
    read -rsp "  Confirm password:  " FALLBACK_PASSWORD_CONFIRM
    echo ""

    if [[ "$FALLBACK_PASSWORD" != "$FALLBACK_PASSWORD_CONFIRM" ]]; then
        err "Passwords don't match."
        exit 1
    fi

    if [[ -z "$FALLBACK_PASSWORD" ]]; then
        err "Password cannot be empty."
        exit 1
    fi

    # Save to .secrets/nodes.json
    if [[ -f "$NODES_FILE" ]]; then
        python3 -c "
import json
d = json.load(open('$NODES_FILE'))
d['fallback_password'] = '$FALLBACK_PASSWORD'
json.dump(d, open('$NODES_FILE', 'w'), indent=2)
"
    else
        cat > "$NODES_FILE" << EOF
{
  "fallback_password": "${FALLBACK_PASSWORD}",
  "nodes": {}
}
EOF
    fi
    chmod 600 "$NODES_FILE"
    log "  Fallback password saved to ${NODES_FILE}"
fi

# ──────────────────────────────────────────────────────────────────────────────
# Phase 1: Backup existing CT (if it exists)
# ──────────────────────────────────────────────────────────────────────────────

BACKUP_PATH=""
if [[ -n "$SHARED_MOUNT" ]]; then
    BACKUP_PATH="${SHARED_MOUNT}/backups/ct${CTID}-$(date +%Y%m%d-%H%M%S)"
else
    BACKUP_PATH="/tmp/rivetos-backup-ct${CTID}-$(date +%Y%m%d-%H%M%S)"
fi

log "Phase 1: Checking for existing CT $CTID on $PVE_NODE..."

CT_EXISTS=$(run_on_pve "pct status $CTID 2>/dev/null && echo 'exists' || echo 'none'")

if [[ "$CT_EXISTS" == *"exists"* ]] && ! $SKIP_DESTROY; then
    log "CT $CTID exists. Backing up workspace data..."

    # Create backup directory
    if [[ -n "$SHARED_MOUNT" ]]; then
        run_on_pve "mkdir -p ${BACKUP_PATH}"
    else
        mkdir -p "${BACKUP_PATH}"
    fi

    # Stop the service gracefully first
    run_on_ct "systemctl stop rivetos 2>/dev/null || true"
    sleep 2

    # Backup workspace, config, env, and SSH keys
    run_on_ct "tar czf /tmp/ct-backup.tar.gz \
        -C / root/.rivetos/ root/.ssh/ 2>/dev/null || true"

    if [[ -n "$SHARED_MOUNT" ]]; then
        run_on_pve "pct pull $CTID /tmp/ct-backup.tar.gz ${BACKUP_PATH}/rivetos-data.tar.gz 2>/dev/null || true"
    else
        # Pull backup to control plane
        scp "root@${IP}:/tmp/ct-backup.tar.gz" "${BACKUP_PATH}/rivetos-data.tar.gz" 2>/dev/null || \
            run_on_pve "pct pull $CTID /tmp/ct-backup.tar.gz /tmp/ct${CTID}-backup.tar.gz" 2>/dev/null || true
        if [[ -f "/tmp/ct${CTID}-backup.tar.gz" ]]; then
            scp "${PVE_NODE}:/tmp/ct${CTID}-backup.tar.gz" "${BACKUP_PATH}/rivetos-data.tar.gz" 2>/dev/null || true
        fi
    fi

    log "Backup saved to ${BACKUP_PATH}/"

    # Stop and destroy
    log "Stopping and destroying CT $CTID..."
    run_on_pve "pct stop $CTID 2>/dev/null || true"
    sleep 3
    run_on_pve "pct destroy $CTID --purge"
    log "CT $CTID destroyed."
else
    if $SKIP_DESTROY; then
        log "Skipping destroy (--skip-destroy)"
    else
        log "No existing CT $CTID found. Creating fresh."
    fi
fi

# ──────────────────────────────────────────────────────────────────────────────
# Phase 2: Create new container
# ──────────────────────────────────────────────────────────────────────────────

log "Phase 2: Creating CT $CTID ($HOSTNAME) on $PVE_NODE..."

if $PRIVILEGED; then
    UNPRIV_FLAG="0"
    FEATURES_FLAG="nesting=1,mount=nfs"
else
    UNPRIV_FLAG="1"
    FEATURES_FLAG="nesting=1"
fi

PCT_CREATE_CMD="pct create $CTID local:vztmpl/${TEMPLATE} \
    --hostname $HOSTNAME \
    --memory $MEMORY \
    --swap $SWAP \
    --cores $CORES \
    --rootfs ${STORAGE}:${DISK} \
    --net0 name=eth0,bridge=${BRIDGE},ip=${IP}/24,gw=${GATEWAY} \
    --nameserver ${NAMESERVER} \
    --features ${FEATURES_FLAG} \
    --unprivileged ${UNPRIV_FLAG} \
    --onboot 1 \
    --startup order=3"

# Unprivileged CTs use bind mount from host; privileged CTs mount NFS directly
if ! $PRIVILEGED && [[ -n "$SHARED_MOUNT" ]]; then
    PCT_CREATE_CMD+=" --mp0 ${SHARED_MOUNT},mp=/shared"
fi

run_on_pve "$PCT_CREATE_CMD"

log "Starting CT $CTID..."
run_on_pve "pct start $CTID"
sleep 5  # Wait for network to come up

log "CT $CTID created and running."

# ──────────────────────────────────────────────────────────────────────────────
# Phase 3: Bootstrap runtime inside the container
# ──────────────────────────────────────────────────────────────────────────────

log "Phase 3: Bootstrapping runtime..."

# Update system and install prerequisites
run_on_ct "apt-get update -qq && apt-get upgrade -y -qq"
run_on_ct "apt-get install -y -qq curl git build-essential ca-certificates gnupg openssh-server rsync"

# Install Node.js 24 via NodeSource
run_on_ct "curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt-get install -y -qq nodejs"

# Verify
run_on_ct "node -v && npm -v"

# Enable and start SSH server for rsync/SSH access
run_on_ct "systemctl enable ssh && systemctl start ssh"

# ──────────────────────────────────────────────────────────────────────────────
# Phase 3.5: Direct NFS mount (privileged CTs only)
# ──────────────────────────────────────────────────────────────────────────────

if $PRIVILEGED && [[ -n "$DATAHUB_IP" ]]; then
    log "Phase 3.5: Setting up direct NFS mount from DataHub ($DATAHUB_IP)..."

    run_on_ct "apt-get install -y -qq nfs-common"
    run_on_ct "mkdir -p /shared"

    # Add fstab entry for persistence
    run_on_ct "if ! grep -q '${DATAHUB_IP}:/shared' /etc/fstab; then
        echo '${DATAHUB_IP}:/shared /shared nfs defaults,_netdev 0 0' >> /etc/fstab
    fi"

    # Mount NFS
    run_on_ct "mount /shared"

    # Verify
    if run_on_ct "test -d /shared && ls /shared/ &>/dev/null" 2>/dev/null; then
        log "  ✅ NFS mounted: ${DATAHUB_IP}:/shared → /shared"
    else
        warn "  ⚠ NFS mount failed. Check that CT110 exports /shared to this subnet."
        warn "  Manual fix: ssh root@${IP} 'mount -t nfs ${DATAHUB_IP}:/shared /shared'"
    fi
fi

# ──────────────────────────────────────────────────────────────────────────────
# Phase 4: SSH access setup
# ──────────────────────────────────────────────────────────────────────────────

log "Phase 4: Setting up SSH access..."

# Create .ssh directory
run_on_ct "mkdir -p /root/.ssh && chmod 700 /root/.ssh"

# Add control plane's SSH public key to authorized_keys
# This ensures the person who provisioned always has access
run_on_ct "echo '${CONTROL_PUBKEY}' >> /root/.ssh/authorized_keys && \
    sort -u /root/.ssh/authorized_keys -o /root/.ssh/authorized_keys && \
    chmod 600 /root/.ssh/authorized_keys"

log "  Control plane SSH key added to CT authorized_keys"

# Generate per-CT mesh key (for CT-to-CT communication)
run_on_ct "ssh-keygen -t ed25519 -f /root/.ssh/id_ed25519 -N '' -C '${HOSTNAME}-ct${CTID}'"
CT_PUBKEY=$(run_on_ct "cat /root/.ssh/id_ed25519.pub")
log "  CT mesh key generated"

# Set fallback password for root
run_on_ct "echo 'root:${FALLBACK_PASSWORD}' | chpasswd"
log "  Fallback password set"

# Configure SSH: allow both key and password auth (password as fallback)
run_on_ct "sed -i 's/^#*PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config && \
    sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config && \
    systemctl restart ssh"

# ──────────────────────────────────────────────────────────────────────────────
# Phase 5: Deploy code to the container
# ──────────────────────────────────────────────────────────────────────────────

log "Phase 5: Deploying RivetOS code (method: ${DEPLOY_METHOD})..."

if [[ "$DEPLOY_METHOD" == "git" ]]; then
    # Clone the repo — gives the CT its own .git so `rivetos update` works
    run_on_ct "git clone ${GIT_REPO} /opt/rivetos"
    log "  Repo cloned from ${GIT_REPO}"

    # Install dependencies and build
    run_on_ct "cd /opt/rivetos && npm ci 2>&1 | tail -5"
    run_on_ct "cd /opt/rivetos && npx nx run-many -t build --exclude container-agent,container-datahub,site 2>&1 | tail -10"
else
    # rsync from control plane (no .git, but works without GitHub access)
    rsync -az --delete \
        -e "ssh -o StrictHostKeyChecking=no" \
        --exclude='.git/' \
        --exclude='node_modules/' \
        --exclude='.secrets/' \
        --exclude='workspace/' \
        --exclude='.env' \
        --exclude='.env.*' \
        --exclude='*.pid' \
        --exclude='.nx/' \
        "${REPO_ROOT}/" "root@${IP}:/opt/rivetos/"

    log "  Code synced to CT"

    # Install dependencies and build
    run_on_ct "cd /opt/rivetos && npm ci 2>&1 | tail -5"
    run_on_ct "cd /opt/rivetos && npx nx run-many -t build --exclude container-agent,container-datahub,site 2>&1 | tail -10"
fi

log "  Build complete"

# ──────────────────────────────────────────────────────────────────────────────
# Phase 6: Generate config from templates
# ──────────────────────────────────────────────────────────────────────────────

log "Phase 6: Generating config from templates..."

# Create data directory
run_on_ct "mkdir -p /root/.rivetos/workspace/memory /root/.rivetos/workspace/skills"

# --- Generate config.yaml from template ---

GENERATED_CONFIG=$(cat "$TEMPLATE_FILE" \
    | sed "s|%%AGENT_NAME%%|${AGENT_NAME}|g" \
    | sed "s|%%PROVIDER_NAME%%|${PROVIDER_NAME}|g" \
    | sed "s|%%DEFAULT_MODEL%%|${DEFAULT_MODEL}|g" \
    | sed "s|%%BASE_URL%%|${BASE_URL}|g" \
    | sed "s|%%TELEGRAM_TOKEN_VAR%%|${TELEGRAM_TOKEN_VAR}|g")

# Check if there are leftover template variables
REMAINING=$(echo "$GENERATED_CONFIG" | grep -o '%%[A-Z_]*%%' | sort -u || true)
if [[ -n "$REMAINING" ]]; then
    warn "  ⚠ Unresolved template variables in config: $REMAINING"
fi

# Write config to CT
echo "$GENERATED_CONFIG" | ssh "$PVE_NODE" "pct exec $CTID -- bash -c 'cat > /root/.rivetos/config.yaml'"
log "  config.yaml generated"

# --- Generate .env from template + secrets ---

# Start with the template
GENERATED_ENV=$(cat "$ENV_TEMPLATE" | grep -v '^#' | grep -v '^$')

# If --secrets-from is provided, pull shared secrets from an existing CT
if [[ -n "$SECRETS_FROM" ]]; then
    log "  Pulling shared secrets from ${SECRETS_FROM}..."
    DONOR_ENV=$(ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no "root@${SECRETS_FROM}" "cat /root/.rivetos/.env" 2>/dev/null || true)

    if [[ -n "$DONOR_ENV" ]]; then
        # Extract shared secrets from donor
        for SECRET_KEY in RIVETOS_PG_URL RIVETOS_EMBED_URL XAI_API_KEY GOOGLE_API_KEY GOOGLE_CSE_ID GOOGLE_CSE_API_KEY ANTHROPIC_API_KEY DISCORD_BOT_TOKEN; do
            DONOR_VALUE=$(echo "$DONOR_ENV" | grep "^${SECRET_KEY}=" | head -1 | cut -d'=' -f2-)
            if [[ -n "$DONOR_VALUE" ]]; then
                # Replace placeholder in generated env, or add if missing
                if echo "$GENERATED_ENV" | grep -q "^${SECRET_KEY}="; then
                    GENERATED_ENV=$(echo "$GENERATED_ENV" | sed "s|^${SECRET_KEY}=.*|${SECRET_KEY}=${DONOR_VALUE}|")
                fi
            fi
        done
        log "  Shared secrets merged from ${SECRETS_FROM}"
    else
        warn "  Could not pull secrets from ${SECRETS_FROM}"
    fi
fi

# Override telegram token if provided directly
if [[ -n "$TELEGRAM_TOKEN" ]]; then
    # Replace whichever telegram token var exists in the env
    GENERATED_ENV=$(echo "$GENERATED_ENV" | sed "s|^TELEGRAM_BOT_TOKEN=.*|TELEGRAM_BOT_TOKEN=${TELEGRAM_TOKEN}|")
    GENERATED_ENV=$(echo "$GENERATED_ENV" | sed "s|^RIVETOS_TELEGRAM_TOKEN=.*|RIVETOS_TELEGRAM_TOKEN=${TELEGRAM_TOKEN}|")
fi

# Override discord token if provided directly
if [[ -n "$DISCORD_TOKEN" ]]; then
    GENERATED_ENV=$(echo "$GENERATED_ENV" | sed "s|^DISCORD_BOT_TOKEN=.*|DISCORD_BOT_TOKEN=${DISCORD_TOKEN}|")
fi

# Check for remaining placeholders
UNFILLED=$(echo "$GENERATED_ENV" | grep '__ENTER_\|__PASSWORD__' || true)
if [[ -n "$UNFILLED" ]]; then
    warn "  ⚠ Some .env values still need to be filled in:"
    echo "$UNFILLED" | while read -r line; do
        warn "    $line"
    done
fi

# Write .env to CT
echo "$GENERATED_ENV" | ssh "$PVE_NODE" "pct exec $CTID -- bash -c 'cat > /root/.rivetos/.env'"
run_on_ct "chmod 600 /root/.rivetos/.env"
log "  .env generated"

# Restore workspace from backup if available (overrides template defaults)
if [[ -n "$RESTORE_FROM" ]] && [[ -f "$RESTORE_FROM" ]]; then
    log "  Restoring workspace from ${RESTORE_FROM}..."
    scp -o StrictHostKeyChecking=no "$RESTORE_FROM" "root@${IP}:/tmp/rivetos-data.tar.gz"
    run_on_ct "cd / && tar xzf /tmp/rivetos-data.tar.gz root/.rivetos/workspace/ 2>/dev/null || true"
    run_on_ct "rm -f /tmp/rivetos-data.tar.gz"
    log "  Workspace restored (config.yaml and .env kept from template generation)."
elif [[ -d "${BACKUP_PATH}" ]] && [[ -f "${BACKUP_PATH}/rivetos-data.tar.gz" ]]; then
    log "  Restoring workspace from backup..."
    scp -o StrictHostKeyChecking=no "${BACKUP_PATH}/rivetos-data.tar.gz" "root@${IP}:/tmp/rivetos-data.tar.gz"
    run_on_ct "cd / && tar xzf /tmp/rivetos-data.tar.gz root/.rivetos/workspace/ 2>/dev/null || true"
    run_on_ct "rm -f /tmp/rivetos-data.tar.gz"
    log "  Workspace restored."
fi

# ──────────────────────────────────────────────────────────────────────────────
# Phase 7: Systemd service
# ──────────────────────────────────────────────────────────────────────────────

log "Phase 7: Installing systemd service..."

run_on_ct "cat > /etc/systemd/system/rivetos.service << 'SVCEOF'
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
SVCEOF
systemctl daemon-reload
systemctl enable rivetos"

# ──────────────────────────────────────────────────────────────────────────────
# Phase 8: Mesh key exchange
# ──────────────────────────────────────────────────────────────────────────────

log "Phase 8: Mesh key exchange..."

# Exchange SSH keys with existing mesh peers
# Read mesh.json from shared storage or fall back to scanning known nodes
MESH_PEERS=()

if [[ -f "${REPO_ROOT}/.secrets/mesh.json" ]]; then
    # Parse mesh.json for known node IPs
    MESH_PEERS=($(python3 -c "
import json
try:
    m = json.load(open('${REPO_ROOT}/.secrets/mesh.json'))
    for n in m.get('nodes', {}).values():
        if n.get('host'):
            print(n['host'])
except: pass
" 2>/dev/null || true))
fi

for PEER_IP in "${MESH_PEERS[@]}"; do
    # Skip self
    [[ "$PEER_IP" == "$IP" ]] && continue

    # Add new CT's key to peer's authorized_keys
    if ssh -o ConnectTimeout=3 -o StrictHostKeyChecking=no "root@${PEER_IP}" "echo '${CT_PUBKEY}' >> /root/.ssh/authorized_keys && sort -u /root/.ssh/authorized_keys -o /root/.ssh/authorized_keys" 2>/dev/null; then
        log "  Added mesh key to ${PEER_IP}"

        # Get peer's key and add to new CT
        PEER_KEY=$(ssh -o ConnectTimeout=3 "root@${PEER_IP}" "cat /root/.ssh/id_ed25519.pub 2>/dev/null" 2>/dev/null || true)
        if [[ -n "$PEER_KEY" ]]; then
            run_on_ct "echo '${PEER_KEY}' >> /root/.ssh/authorized_keys && sort -u /root/.ssh/authorized_keys -o /root/.ssh/authorized_keys"
            log "  Added ${PEER_IP}'s key to CT"
        fi
    else
        warn "  Could not reach peer at ${PEER_IP} — manual key exchange needed"
    fi
done

# ──────────────────────────────────────────────────────────────────────────────
# Phase 9: Update secrets store
# ──────────────────────────────────────────────────────────────────────────────

log "Phase 9: Updating secrets store..."

# Update .secrets/nodes.json with new node info
python3 -c "
import json, os
f = '${NODES_FILE}'
d = json.load(open(f)) if os.path.exists(f) else {'fallback_password': '', 'nodes': {}}
d['nodes']['ct${CTID}'] = {
    'hostname': '${HOSTNAME}',
    'ip': '${IP}',
    'agent': '${AGENT_NAME}',
    'provider': '${PROVIDER_NAME}',
    'pve_node': '${PVE_NODE}',
    'provisioned_at': '$(date -Iseconds)'
}
json.dump(d, open(f, 'w'), indent=2)
"
chmod 600 "$NODES_FILE"
log "  Node registered in ${NODES_FILE}"

# ──────────────────────────────────────────────────────────────────────────────
# Phase 10: Start and verify
# ──────────────────────────────────────────────────────────────────────────────

log "Phase 10: Starting RivetOS..."

# Only start if config exists and .env has no unfilled placeholders
if run_on_ct "test -f /root/.rivetos/config.yaml" 2>/dev/null; then
    UNFILLED_CHECK=$(run_on_ct "grep -c '__ENTER_\|__PASSWORD__' /root/.rivetos/.env" 2>/dev/null || echo "0")
    if [[ "$UNFILLED_CHECK" -gt 0 ]]; then
        warn "⚠️  .env has $UNFILLED_CHECK unfilled placeholder(s). Service not started."
        warn "   Fill them in: ssh root@${IP} nano /root/.rivetos/.env"
        warn "   Then start:   ssh root@${IP} systemctl start rivetos"
    else
        run_on_ct "systemctl start rivetos"
        sleep 5

        # Check if service is running
        STATUS=$(run_on_ct "systemctl is-active rivetos" || true)
        if [[ "$STATUS" == "active" ]]; then
            log "✅ RivetOS is running on CT $CTID ($HOSTNAME)"
        else
            warn "⚠️  RivetOS service not active. Check logs:"
            warn "   ssh root@${IP} journalctl -u rivetos -n 50"
        fi
    fi
else
    warn "No config.yaml found — service not started. This shouldn't happen."
fi

# ──────────────────────────────────────────────────────────────────────────────
# Summary
# ──────────────────────────────────────────────────────────────────────────────

log ""
log "═══════════════════════════════════════════════════════════════"
log "  Provisioning complete!"
log "═══════════════════════════════════════════════════════════════"
log "  CT ID:        $CTID"
log "  Hostname:     $HOSTNAME"
log "  IP:           $IP"
log "  Agent:        $AGENT_NAME"
log "  Provider:     $PROVIDER_NAME"
log "  Model:        $DEFAULT_MODEL"
log "  Deploy:       $DEPLOY_METHOD"
log "  Node:         $PVE_NODE"
log "  Storage:      $STORAGE"
log "  Privileged:   $PRIVILEGED"
log ""
log "  Access:"
log "    ssh root@${IP}                   Direct SSH"
log "    ssh $PVE_NODE 'pct enter $CTID'  Console via Proxmox"
log ""
log "  Manage:"
log "    ssh root@${IP} systemctl status rivetos"
log "    ssh root@${IP} journalctl -u rivetos -f"
log ""
if [[ "$DEPLOY_METHOD" == "git" ]]; then
log "  Update:"
log "    ssh root@${IP} 'cd /opt/rivetos && git pull && npm ci && npx nx run-many -t build --exclude container-agent,container-datahub,site'"
fi
log ""
if [[ -d "${BACKUP_PATH}" ]]; then
log "  Backup: ${BACKUP_PATH}/"
fi
log "═══════════════════════════════════════════════════════════════"
