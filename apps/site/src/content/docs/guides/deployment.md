---
title: Deployment
sidebar:
  order: 3
description: Deploy RivetOS with Docker, Proxmox, or bare-metal
---


RivetOS supports three deployment targets: **Docker** (recommended for most users), **Proxmox** (homelab), and **bare-metal** (manual). This guide covers each approach, multi-agent setups, networking, and backup/restore.

---

## Docker Deployment

The simplest way to run RivetOS. Works on any machine with Docker.

### Single Agent

```bash
# Clone and install (automatically builds all packages)
git clone https://github.com/philbert440/rivetOS.git
cd rivetOS
npm install

# Run the interactive setup
npx rivetos init
# Choose "Docker" as deployment target
# Configure your agent, API key, and channels
# The wizard generates config.yaml + .env + starts containers

# Or manually:
cp config.example.yaml config.yaml
cp .env.example .env
# Edit both files, then:
npx rivetos build
docker compose up -d
```

### Multi-Agent

Run multiple agents in the same Docker Compose stack:

```yaml
# config.yaml
agents:
  opus:
    provider: anthropic
  grok:
    provider: xai
  local:
    provider: ollama
    local: true

channels:
  discord:
    channel_bindings:
      "111111111": opus
      "222222222": grok
      "333333333": local
```

```bash
# Start with multi-agent profile
docker compose --profile multi up -d
```

This creates separate containers for each agent plus a shared datahub (Postgres + shared storage).

### Docker Compose Architecture

```
┌──────────────────────────────────────────────┐
│  Docker Network: rivetos-net                 │
│                                              │
│   ┌───────────┐  ┌──────────┐  ┌──────────┐  │
│   │  opus     │  │  grok    │  │  local   │  │
│   │  :3100    │  │  :3101   │  │  :3102   │  │
│   │ agent img │  │ agent img│  │ agent img│  │
│   └────┬──────┘  └────┬─────┘  └────┬─────┘  │
│        │              │             │        │
│        └──────────────┼─────────────┘        │
│                       │                      │
│               ┌───────┴───────┐              │
│               │   datahub     │              │
│               │  postgres:16  │              │
│               │  pgvector     │              │
│               │  /rivet-shared/     │              │
│               │  :5432        │              │
│               └───────────────┘              │
└──────────────────────────────────────────────┘

Volumes:
  rivetos-pgdata  → Postgres data (survives rebuilds)
  rivetos-shared  → Shared storage (agent collaboration)
  ./workspace/    → Agent workspace files (bind mount)
  ./config.yaml   → Configuration (bind mount)
  ./.env          → Secrets (bind mount)
```

### Data Persistence

Containers are stateless. All persistent data lives on the host:

| Data | Storage | Survives Update |
|------|---------|-----------------|
| Workspace files (CORE.md, memory/, skills/) | Bind mount `./workspace/` | ✅ |
| Configuration | Bind mount `./config.yaml` | ✅ |
| Secrets | `.env` on host | ✅ |
| PostgreSQL data | Named volume `rivetos-pgdata` | ✅ |
| Shared storage | Named volume `rivetos-shared` | ✅ |
| Plugins | In source tree | ✅ |
| Runtime code | Rebuilt from source | 🔄 |

### Updating

```bash
npx rivetos update
```

This pulls the latest source, rebuilds container images, and restarts. Your workspace, config, secrets, and database survive.

For a specific version:
```bash
npx rivetos update --version 0.8.2
```

---

## Proxmox Deployment

For homelab setups with Proxmox VE. Each agent runs in its own LXC container.

### Prerequisites

- Proxmox VE 8.x
- At least one node with sufficient RAM (1-2 GB per agent container)
- Network bridge configured (e.g., `vmbr1`)

### Configuration

```yaml
# config.yaml
deployment:
  target: proxmox
  
  datahub:
    postgres: true
    shared_storage: true
  
  image:
    build_from_source: true
  
  proxmox:
    api_url: https://192.168.1.1:8006
    nodes:
      - name: pve1
        host: 192.168.1.1
        role: datahub        # Runs Postgres + NFS
      - name: pve2
        host: 192.168.1.2
        role: agents          # Runs agent containers
      - name: pve3
        host: 192.168.1.3
        role: agents
    network:
      bridge: vmbr1
      subnet: 192.168.1.0/24
      gateway: 192.168.1.1
```

### Deployment

```bash
# Preview what will be created
npx rivetos infra preview

# Deploy
npx rivetos infra up

# Check status
npx rivetos infra status
```

### Proxmox Architecture

```
┌─────────────────────────────────────────────────────┐
│  Network: 192.168.1.0/24 (vmbr1)                      │
│                                                     │
│  PVE1 (datahub)    PVE2 (agents)    PVE3 (agents)   │
│  ┌────────────┐    ┌────────────┐   ┌────────────┐  │
│  │ CT 106     │    │ CT 101     │   │ CT 100     │  │
│  │ postgres   │    │ opus       │   │ local      │  │
│  │ NFS server │    │ 192.168.1.101│   │ 192.168.1.100│  │
│  │ /rivet-shared/   │    ├────────────┤   └────────────┘  │
│  │ 192.168.1.106│    │ CT 102     │                   │
│  └────────────┘    │ grok       │                   │
│                    │ 192.168.1.102│                   │
│                    └────────────┘                   │
│                                                     │
│  NFS exports /rivet-shared/ to all agents                 │
│  Agents mount /rivet-shared/ via bind mount               │
└─────────────────────────────────────────────────────┘
```

### Multi-Node Shared Storage

The datahub node runs NFS to share `/rivet-shared/` across all agents:

```bash
# On the datahub node (automatic with rivetos infra up):
apt install nfs-kernel-server
echo "/rivet-shared 192.168.1.0/24(rw,sync,no_subtree_check)" >> /etc/exports
exportfs -ra

# On each Proxmox host:
mount -t nfs 192.168.1.106:/rivet-shared /rivet-shared
# Add to fstab for persistence
echo "192.168.1.106:/rivet-shared /rivet-shared nfs defaults 0 0" >> /etc/fstab
```

Each agent container gets `/rivet-shared/` as a bind mount.

### Updating on Proxmox

```bash
# Update all agents (rolling — one at a time with health checks)
npx rivetos update --mesh

# Update a single agent
npx rivetos update
```

---

## Multi-Agent Mesh

Multiple RivetOS instances can form a mesh for cross-instance collaboration.

### Setting Up a Mesh

**First instance (seed node):**
```bash
npx rivetos init
# Configure normally — this becomes the seed
```

**Additional instances:**
```bash
npx rivetos init --join 192.168.1.101
# Discovers the existing mesh and registers
```

### Mesh Operations

```bash
# List all mesh nodes
npx rivetos mesh list

# Health check all peers
npx rivetos mesh ping

# Show local mesh status
npx rivetos mesh status

# Join an existing mesh
npx rivetos mesh join 192.168.1.101
```

### How Mesh Delegation Works

When an agent receives a `delegate_task` targeting an agent that isn't local:

1. Check local agents → not found
2. Check mesh registry → found on remote node
3. Send delegation request via HTTP to the remote agent channel
4. Remote agent processes the task
5. Result returned to the requesting agent

This is transparent — the requesting agent doesn't know or care whether the delegate is local or remote.

### Mesh Configuration

```yaml
# Agent channel config (enables mesh)
channels:
  agent:
    port: 3100
    secret: ${RIVETOS_AGENT_SECRET}

# Mesh seeds (optional — for discovery)
# Peers are also discovered via rivetos init --join
```

---

## Bare-Metal Deployment

Run RivetOS directly on your machine without containers.

### Setup

```bash
git clone https://github.com/philbert440/rivetOS.git
cd rivetOS
npm install    # Installs deps + builds all packages

# Configure
cp config.example.yaml config.yaml
cp .env.example .env
# Edit both files

# Start
npx rivetos start
```

### Systemd Service

```bash
# Install as a systemd service
npx rivetos service install

# Manage
sudo systemctl start rivetos
sudo systemctl stop rivetos
sudo systemctl status rivetos
sudo systemctl enable rivetos   # Start on boot

# Uninstall
npx rivetos service uninstall
```

### PostgreSQL Setup

You need PostgreSQL 16+ with pgvector running separately:

```bash
# Ubuntu/Debian
sudo apt install postgresql-16 postgresql-16-pgvector
sudo -u postgres createdb rivetos
sudo -u postgres psql rivetos -c "CREATE EXTENSION IF NOT EXISTS vector;"

# Set connection string
echo 'RIVETOS_PG_URL=postgresql://localhost:5432/rivetos' >> .env
```

---

## Networking

### Port Reference

| Port | Service    | Description                              |
|------|------------|------------------------------------------|
| 3100 | Agent HTTP | Agent channel (delegation, mesh, health) |
| 5432 | PostgreSQL | Database (datahub only)                  |

### Firewall Rules

For multi-instance setups, agents need to reach each other on port 3100 and the datahub on port 5432:

```bash
# Allow agent mesh traffic (adjust subnet)
ufw allow from 192.168.1.0/24 to any port 3100
ufw allow from 192.168.1.0/24 to any port 5432
```

### DNS / Service Discovery

The mesh uses seed-node discovery by default. When you `rivetos init --join <host>`, the joining node contacts the seed's `/api/mesh/join` endpoint and receives the full registry of known peers.

mDNS auto-discovery is supported for future use but not yet implemented.

---

## Backup & Restore

### What to Back Up

| Component | Location | Method |
|----------------|----------------------|---------------------|
| Config         | `./config.yaml`      | File copy           |
| Secrets        | `./.env`             | File copy (secure!) |
| Workspace      | `./workspace/`       | File copy / rsync   |
| Database       | PostgreSQL           | `pg_dump`           |
| Shared storage | `/rivet-shared/` or volume | File copy / rsync   |

### Backup Script

```bash
#!/bin/bash
BACKUP_DIR="./backups/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"

# Config and secrets
cp config.yaml "$BACKUP_DIR/"
cp .env "$BACKUP_DIR/"

# Workspace
rsync -a workspace/ "$BACKUP_DIR/workspace/"

# Database
docker compose exec datahub pg_dump -U rivetos rivetos > "$BACKUP_DIR/database.sql"

# Shared storage
rsync -a /rivet-shared/ "$BACKUP_DIR/rivet-shared/"

echo "Backup complete: $BACKUP_DIR"
```

### Restore

```bash
BACKUP_DIR="./backups/20260405-120000"

# Config and secrets
cp "$BACKUP_DIR/config.yaml" ./
cp "$BACKUP_DIR/.env" ./

# Workspace
rsync -a "$BACKUP_DIR/workspace/" workspace/

# Database
docker compose exec -T datahub psql -U rivetos rivetos < "$BACKUP_DIR/database.sql"

# Shared storage
rsync -a "$BACKUP_DIR/rivet-shared/" /rivet-shared/

# Restart
npx rivetos update
```

### Automated Backups

Set up a cron job:
```bash
# Daily at 3am
0 3 * * * /path/to/rivetos/backup.sh >> /var/log/rivetos-backup.log 2>&1
```

---

## Resource Requirements

### Minimum (Single Agent, Docker)

- **CPU:** 1 core
- **RAM:** 1 GB (512 MB for agent + 512 MB for Postgres)
- **Disk:** 2 GB (source + node_modules + database)

### Recommended (Multi-Agent, Docker)

- **CPU:** 2+ cores
- **RAM:** 2-4 GB (512 MB per agent + 512 MB for Postgres)
- **Disk:** 10 GB (room for database growth and skills)

### Proxmox (Per Container)

- **Agent CT:** 512 MB RAM, 1 vCPU, 2 GB disk
- **Datahub CT:** 1 GB RAM, 1 vCPU, 10 GB disk

---

## Health Monitoring

### Health Endpoint

Each agent exposes:
- `GET /health` — Full runtime status (agents, providers, channels, memory, metrics)
- `GET /health/live` — Simple liveness check (returns 200)
- `GET /metrics` — Raw metrics (turns, tool calls, tokens, latency)

### CLI Checks

```bash
npx rivetos status           # Runtime overview
npx rivetos doctor           # 12-category health check
npx rivetos test             # Smoke test (provider, memory, tools)
npx rivetos mesh ping        # Check all mesh peers
```

### Docker Health Checks

The agent Dockerfile includes a built-in health check:
```
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:3100/health/live || exit 1
```

Docker Compose uses this for dependency ordering — agents wait for the datahub to be healthy before starting.
