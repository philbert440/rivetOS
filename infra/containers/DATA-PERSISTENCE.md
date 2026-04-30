# Data Persistence Model

RivetOS containers are **stateless runtimes**. All mutable data lives outside
the container — on the host filesystem (bind mounts) or in Docker named volumes.
Rebuilding or replacing a container image does **not** destroy user data.

## What Lives Where

### Host Bind Mounts (survive everything — backup these)

| Data | Default Host Path | Container Mount | Notes |
|------|-------------------|-----------------|-------|
| Agent config | `~/.rivetos/config.yaml` | `/home/rivetos/.rivetos/config.yaml` | Read-only mount |
| Environment/secrets | `~/.rivetos/.env` | `/home/rivetos/.rivetos/.env` | API keys, DB passwords (read-only) |

### Docker Named Volumes (survive container rebuilds)

| Volume | Container Mount | Notes |
|--------|-----------------|-------|
| `rivetos-pgdata` | `/var/lib/postgresql/data` | Postgres data (conversations, memory embeddings) |

### Inside the Container (rebuilt on every update — no user data here)

| Data | Notes |
|------|-------|
| Node.js runtime | Base image |
| RivetOS source code | Copied from source tree at build time |
| node_modules | Installed at build time |
| Plugin source | Part of source tree, baked in |

## The Update Guarantee

When `rivetos update` runs:

1. `git pull` — updates source tree on host
2. `docker compose build` — rebuilds container image from source
3. `docker compose up -d` — replaces container with new image

**Steps 2 and 3 never touch bind mounts or named volumes.** The workspace,
config, secrets, and database are untouched.

## First-Run vs. Existing Install

On first run (`rivetos init`):
- Creates `./workspace/` with default template files (CORE.md, USER.md, etc.)
- Generates `./config.yaml` from wizard answers
- Creates `.env` from user input

On subsequent runs:
- Existing workspace files are preserved as-is
- Only missing template files are added (never overwritten)
- Config changes go through `rivetos config` which modifies in-place

## Migration: Bare Metal → Container

For users upgrading from a bare-metal install to containers:

```bash
rivetos migrate --to-container
```

This:
1. Copies workspace files to the bind mount location
2. Exports memory/conversation data from local SQLite (if used) to Postgres
3. Validates the migration
4. Generates docker-compose config

## Backup

Back up these paths and you can restore a full RivetOS install:

```bash
# Workspace + config
cp -r ./workspace/ ./config.yaml ./.env /backup/rivetos/

# Database (container name comes from the compose project — typically rivetos-datahub-1)
docker compose -f infra/docker/rivetos/docker-compose.yml exec datahub \
  pg_dump -U rivetos rivetos > /backup/rivetos/db.sql

# Shared storage (host path; not stored in any container)
cp -r /rivet-shared /backup/rivetos/shared/
```
