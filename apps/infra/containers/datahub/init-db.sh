#!/bin/bash
set -e

# ===========================================================================
# RivetOS — Datahub Database Initialization
#
# Runs once on first Postgres data-dir init. Applies the same migrations the
# unified runner would apply (0001_baseline.sql, ...) from the
# @rivetos/memory-postgres package.
#
# This script is the legacy entrypoint for the standalone `pgvector/pgvector`
# image. The unified RivetOS image calls the migrate runner from its
# datahub-role startup, which works for both first-init and every subsequent
# container start.
#
# Schema source of truth: plugins/memory/postgres/src/schema/migrations/*.sql
# ===========================================================================

MIGRATIONS_DIR="${MIGRATIONS_DIR:-/migrations}"

if [ ! -d "$MIGRATIONS_DIR" ]; then
  echo "[RivetOS] migrations dir $MIGRATIONS_DIR not found — schema setup skipped"
  echo "[RivetOS] (mount plugins/memory/postgres/src/schema/migrations at $MIGRATIONS_DIR to enable)"
  exit 0
fi

echo "[RivetOS] applying baseline migrations from $MIGRATIONS_DIR"

# Track applied migrations so re-runs are idempotent.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-'BOOTSQL'
  CREATE TABLE IF NOT EXISTS _rivetos_migrations (
    name        TEXT PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    checksum    TEXT
  );
BOOTSQL

# Apply each *.sql in lexical order, skipping any already recorded.
for f in $(ls -1 "$MIGRATIONS_DIR"/*.sql 2>/dev/null | sort); do
  name=$(basename "$f")
  applied=$(psql -tA --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
    -c "SELECT 1 FROM _rivetos_migrations WHERE name = '$name'")

  if [ "$applied" = "1" ]; then
    echo "[RivetOS]   ✓ $name (already applied)"
    continue
  fi

  echo "[RivetOS]   applying $name"
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
    --single-transaction \
    -c "BEGIN" \
    -f "$f" \
    -c "INSERT INTO _rivetos_migrations (name) VALUES ('$name')" \
    -c "COMMIT"
done

echo "[RivetOS] migrations done."
