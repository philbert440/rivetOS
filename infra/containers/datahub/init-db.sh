#!/bin/bash
set -e

# Create pgvector extension for embedding-based memory search.
# Runs only on first database initialization.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE EXTENSION IF NOT EXISTS vector;
EOSQL

echo "[RivetOS] Database initialized with pgvector extension."
