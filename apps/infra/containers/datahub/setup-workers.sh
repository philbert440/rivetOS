#!/bin/bash
set -e

# ===========================================================================
# RivetOS — Datahub Worker Setup
#
# Sets up the embedding and compaction worker services on the Datahub CT.
# Installs Node.js (if needed), creates env file templates, installs
# systemd services (running as the 'rivet' user), and enables them.
#
# Prerequisites:
#   - Datahub CT is running with Postgres
#   - RivetOS repo is cloned to /opt/rivetos
#   - init-db.sh has been run (queue tables + triggers exist)
#   - rivet user (uid 2000) exists, or will be created by this script
#
# Usage:
#   sudo bash /opt/rivetos/apps/infra/containers/datahub/setup-workers.sh
#
# Environment variables (set before running or edit .env files after):
#   RIVETOS_PG_URL         — Postgres connection string
#   RIVETOS_EMBED_URL      — Nemotron embedding endpoint (required)
#   RIVETOS_COMPACTOR_URL  — E2B compaction endpoint (required)
# ===========================================================================

RIVETOS_DIR="/opt/rivetos"
WORKERS_DIR="${RIVETOS_DIR}/plugins/memory/postgres/workers"
CONFIG_DIR="/etc/rivetos"
RIVET_HOME="/home/rivet"
RIVET_UID=2000
RIVET_GID=2000

echo "=========================================="
echo "  RivetOS Datahub Worker Setup"
echo "=========================================="

# -----------------------------------------------------------------------
# 0. Create rivet user if not present
# -----------------------------------------------------------------------

echo ""
echo "[0/6] Ensuring rivet user exists..."
if ! getent group rivet &>/dev/null; then
    groupadd --gid "${RIVET_GID}" rivet
    echo "  Group 'rivet' created (gid ${RIVET_GID})"
fi

if ! id rivet &>/dev/null; then
    useradd \
        --uid "${RIVET_UID}" \
        --gid rivet \
        --home-dir "${RIVET_HOME}" \
        --create-home \
        --shell /bin/bash \
        rivet
    echo "  User 'rivet' created (uid ${RIVET_UID})"
else
    echo "  User 'rivet' already exists ✓"
fi

# Add to sudo group
usermod -aG sudo rivet
echo "  'rivet' added to sudo group ✓"

# Ensure rivet owns /opt/rivetos
chown -R rivet:rivet "${RIVETOS_DIR}"
echo "  chown rivet:rivet ${RIVETOS_DIR} ✓"

# -----------------------------------------------------------------------
# 1. Install Node.js 22 LTS (if not already installed)
# -----------------------------------------------------------------------

if ! command -v node &>/dev/null || [[ $(node --version | cut -d. -f1 | tr -d v) -lt 22 ]]; then
    echo ""
    echo "[1/6] Installing Node.js 22 LTS..."
    if command -v apt-get &>/dev/null; then
        curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
        apt-get install -y nodejs
    else
        echo "ERROR: Only Debian/Ubuntu supported. Install Node.js 22+ manually."
        exit 1
    fi
else
    echo ""
    echo "[1/6] Node.js $(node --version) already installed ✓"
fi

# -----------------------------------------------------------------------
# 2. Install npm dependencies for worker services
# -----------------------------------------------------------------------

echo ""
echo "[2/6] Installing worker dependencies..."

cd "${WORKERS_DIR}/embedding"
npm install --omit=dev

cd "${WORKERS_DIR}/compaction"
npm install --omit=dev

# Fix ownership after npm install
chown -R rivet:rivet "${WORKERS_DIR}"

# -----------------------------------------------------------------------
# 3. Create config directory and env file templates
# -----------------------------------------------------------------------

echo ""
echo "[3/6] Creating config directory and env files..."

mkdir -p "${CONFIG_DIR}"

# Embedding worker env
if [ ! -f "${CONFIG_DIR}/embedder.env" ]; then
    cat > "${CONFIG_DIR}/embedder.env" <<'EOF'
# RivetOS Embedding Worker Configuration
# Edit these values for your environment.

# Postgres connection string (required)
RIVETOS_PG_URL=postgres://user:pass@localhost:5432/dbname

# Nemotron embedding service (GPU inference server)
RIVETOS_EMBED_URL=http://your-gpu-host:9401
RIVETOS_EMBED_MODEL=nemotron

# Batch sizes
EMBED_BATCH_SIZE=50
EMBED_API_BATCH_SIZE=8

# Truncate embeddings to match halfvec(4000) column
EMBED_TRUNCATE_DIMS=4000

# API timeout (ms)
EMBED_API_TIMEOUT_MS=30000

# Max retries per API call
EMBED_MAX_RETRIES=3

# Mark row as poison after this many failures
EMBED_MAX_FAILURES=3
EOF
    echo "  Created ${CONFIG_DIR}/embedder.env (edit with your Postgres URL)"
else
    echo "  ${CONFIG_DIR}/embedder.env already exists ✓"
fi

# Compaction worker env
if [ ! -f "${CONFIG_DIR}/compactor.env" ]; then
    cat > "${CONFIG_DIR}/compactor.env" <<'EOF'
# RivetOS Compaction Worker Configuration
# Edit these values for your environment.

# Postgres connection string (required)
RIVETOS_PG_URL=postgres://user:pass@localhost:5432/dbname

# LLM summarization service (CPU inference server)
RIVETOS_COMPACTOR_URL=http://your-llm-host:8001/v1
RIVETOS_COMPACTOR_MODEL=gemma-4-E2B-it-Q4_K_M.gguf

# LLM timeout — generous for thinking model (10 minutes)
COMPACT_LLM_TIMEOUT_MS=600000

# Token budgets per compaction level (thinking model needs room)
COMPACT_LEAF_TOKENS=4096
COMPACT_BRANCH_TOKENS=6144
COMPACT_ROOT_TOKENS=8192

# Temperature for summarization
COMPACT_TEMPERATURE=0.3

# Idle session detection interval (ms)
COMPACT_IDLE_CHECK_MS=300000

# Idle timeout (minutes)
COMPACT_IDLE_MINUTES=15

# Minimum unsummarized messages for idle session detection
COMPACT_MIN_UNSUMMARIZED=10
EOF
    echo "  Created ${CONFIG_DIR}/compactor.env (edit with your Postgres URL)"
else
    echo "  ${CONFIG_DIR}/compactor.env already exists ✓"
fi

# -----------------------------------------------------------------------
# 4. Install systemd services (User=rivet)
# -----------------------------------------------------------------------

echo ""
echo "[4/6] Installing systemd services..."

# Embedding worker service
cat > /etc/systemd/system/rivet-embedder.service <<EOF
[Unit]
Description=RivetOS Embedding Worker — event-driven via Postgres NOTIFY
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
User=rivet
Group=rivet
WorkingDirectory=${WORKERS_DIR}/embedding
ExecStart=/usr/bin/node ${WORKERS_DIR}/embedding/index.js
Restart=always
RestartSec=5
EnvironmentFile=${CONFIG_DIR}/embedder.env
Environment=HOME=${RIVET_HOME}

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=rivet-embedder

# Resource limits (lightweight worker)
MemoryMax=512M
CPUQuota=50%

# Hardening
ProtectSystem=strict
ProtectHome=false
ReadWritePaths=${RIVET_HOME} /rivet-shared ${RIVETOS_DIR}
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

# Compaction worker service
cat > /etc/systemd/system/rivet-compactor.service <<EOF
[Unit]
Description=RivetOS Compaction Worker — event-driven summarization via Postgres NOTIFY
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
User=rivet
Group=rivet
WorkingDirectory=${WORKERS_DIR}/compaction
ExecStart=/usr/bin/node ${WORKERS_DIR}/compaction/index.js
Restart=always
RestartSec=10
EnvironmentFile=${CONFIG_DIR}/compactor.env
Environment=HOME=${RIVET_HOME}

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=rivet-compactor

# Resource limits (lightweight worker, LLM is remote)
MemoryMax=512M
CPUQuota=50%

# Hardening
ProtectSystem=strict
ProtectHome=false
ReadWritePaths=${RIVET_HOME} /rivet-shared ${RIVETOS_DIR}
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

# -----------------------------------------------------------------------
# 5. Migrate any existing /root/.rivetos to /home/rivet/.rivetos
# -----------------------------------------------------------------------

echo ""
echo "[5/6] Checking for existing .rivetos data under root..."
if [[ -d "/root/.rivetos" ]] && [[ ! -d "${RIVET_HOME}/.rivetos" ]]; then
    mv /root/.rivetos "${RIVET_HOME}/.rivetos"
    echo "  Moved /root/.rivetos → ${RIVET_HOME}/.rivetos"
    # Patch any absolute paths in config.yaml
    CONFIG_YAML="${RIVET_HOME}/.rivetos/config.yaml"
    if [[ -f "$CONFIG_YAML" ]]; then
        sed -i "s|/root/\.rivetos|${RIVET_HOME}/.rivetos|g" "$CONFIG_YAML"
        echo "  Patched absolute paths in config.yaml"
    fi
elif [[ -d "${RIVET_HOME}/.rivetos" ]]; then
    echo "  ${RIVET_HOME}/.rivetos already exists ✓"
else
    echo "  No /root/.rivetos found — nothing to migrate"
fi
chown -R rivet:rivet "${RIVET_HOME}"

# -----------------------------------------------------------------------
# 6. Enable and start services
# -----------------------------------------------------------------------

echo ""
echo "[6/6] Enabling and starting services..."

systemctl daemon-reload
systemctl enable rivet-embedder rivet-compactor
systemctl restart rivet-embedder rivet-compactor

echo ""
echo "=========================================="
echo "  Setup complete!"
echo ""
echo "  Services:"
echo "    rivet-embedder   — $(systemctl is-active rivet-embedder)"
echo "    rivet-compactor  — $(systemctl is-active rivet-compactor)"
echo ""
echo "  Running as:  rivet (uid ${RIVET_UID})"
echo ""
echo "  Config files:"
echo "    ${CONFIG_DIR}/embedder.env"
echo "    ${CONFIG_DIR}/compactor.env"
echo ""
echo "  Logs:"
echo "    journalctl -u rivet-embedder -f"
echo "    journalctl -u rivet-compactor -f"
echo "=========================================="
