#!/bin/bash
set -e

# ===========================================================================
# RivetOS — Datahub Worker Setup
#
# Sets up the embedding and compaction worker services on the Datahub CT.
# Installs Node.js (if needed), creates env file templates, installs
# systemd services, and enables them.
#
# Prerequisites:
#   - Datahub CT is running with Postgres
#   - RivetOS repo is cloned to /opt/rivetos
#   - init-db.sh has been run (queue tables + triggers exist)
#
# Usage:
#   sudo bash /opt/rivetos/infra/containers/datahub/setup-workers.sh
#
# Environment variables (set before running or edit .env files after):
#   RIVETOS_PG_URL         — Postgres connection string
#   RIVETOS_EMBED_URL      — Nemotron embedding endpoint (required, e.g. http://your-gpu-host:9401)
#   RIVETOS_COMPACTOR_URL  — E2B compaction endpoint (required, e.g. http://your-llm-host:8001/v1)
# ===========================================================================

RIVETOS_DIR="/opt/rivetos"
SERVICES_DIR="${RIVETOS_DIR}/services"
CONFIG_DIR="/etc/rivetos"

echo "=========================================="
echo "  RivetOS Datahub Worker Setup"
echo "=========================================="

# -----------------------------------------------------------------------
# 1. Install Node.js 22 LTS (if not already installed)
# -----------------------------------------------------------------------

if ! command -v node &>/dev/null || [[ $(node --version | cut -d. -f1 | tr -d v) -lt 22 ]]; then
    echo ""
    echo "[1/5] Installing Node.js 22 LTS..."
    if command -v apt-get &>/dev/null; then
        curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
        apt-get install -y nodejs
    else
        echo "ERROR: Only Debian/Ubuntu supported. Install Node.js 22+ manually."
        exit 1
    fi
else
    echo ""
    echo "[1/5] Node.js $(node --version) already installed ✓"
fi

# -----------------------------------------------------------------------
# 2. Install npm dependencies for worker services
# -----------------------------------------------------------------------

echo ""
echo "[2/5] Installing worker dependencies..."

cd "${SERVICES_DIR}/embedding-worker"
npm install --omit=dev

cd "${SERVICES_DIR}/compaction-worker"
npm install --omit=dev

# -----------------------------------------------------------------------
# 3. Create config directory and env file templates
# -----------------------------------------------------------------------

echo ""
echo "[3/5] Creating config directory and env files..."

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

# Idle session detection interval (ms) — how often to check for idle conversations
COMPACT_IDLE_CHECK_MS=300000

# Idle timeout (minutes) — conversation must be idle this long to trigger compaction
COMPACT_IDLE_MINUTES=15

# Minimum unsummarized messages for idle session detection
COMPACT_MIN_UNSUMMARIZED=10
EOF
    echo "  Created ${CONFIG_DIR}/compactor.env (edit with your Postgres URL)"
else
    echo "  ${CONFIG_DIR}/compactor.env already exists ✓"
fi

# -----------------------------------------------------------------------
# 4. Install systemd services
# -----------------------------------------------------------------------

echo ""
echo "[4/5] Installing systemd services..."

# Embedding worker service
cat > /etc/systemd/system/rivet-embedder.service <<EOF
[Unit]
Description=RivetOS Embedding Worker — event-driven via Postgres NOTIFY
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
User=root
WorkingDirectory=${SERVICES_DIR}/embedding-worker
ExecStart=/usr/bin/node ${SERVICES_DIR}/embedding-worker/index.js
Restart=always
RestartSec=5
EnvironmentFile=${CONFIG_DIR}/embedder.env

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=rivet-embedder

# Resource limits (lightweight worker)
MemoryMax=512M
CPUQuota=50%

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
User=root
WorkingDirectory=${SERVICES_DIR}/compaction-worker
ExecStart=/usr/bin/node ${SERVICES_DIR}/compaction-worker/index.js
Restart=always
RestartSec=10
EnvironmentFile=${CONFIG_DIR}/compactor.env

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=rivet-compactor

# Resource limits (lightweight worker, LLM is remote)
MemoryMax=512M
CPUQuota=50%

[Install]
WantedBy=multi-user.target
EOF

# -----------------------------------------------------------------------
# 5. Enable and start services
# -----------------------------------------------------------------------

echo ""
echo "[5/5] Enabling and starting services..."

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
echo "  Config files:"
echo "    ${CONFIG_DIR}/embedder.env"
echo "    ${CONFIG_DIR}/compactor.env"
echo ""
echo "  Logs:"
echo "    journalctl -u rivet-embedder -f"
echo "    journalctl -u rivet-compactor -f"
echo "=========================================="
