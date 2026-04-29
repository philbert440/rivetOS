# RivetOS Datahub Container
# Postgres 16 + pgvector + shared directory structure.
# Serves as the central data store for all agents.
#
# Build context = repo root (so we can pull plugins/memory/postgres/ into the image).
#   docker build -f apps/infra/containers/datahub/Dockerfile -t rivetos-datahub .

FROM pgvector/pgvector:pg16

# Init scripts — postgres runs these on first start, in alphabetical order.
# 01-init-db.sh applies migrations from /migrations/*.sql.
COPY apps/infra/containers/datahub/init-db.sh /docker-entrypoint-initdb.d/01-init-db.sh
COPY apps/infra/containers/datahub/init-shared.sh /docker-entrypoint-initdb.d/02-init-shared.sh

# Schema migrations — single source of truth lives in @rivetos/memory-postgres.
# The init script reads from /migrations/ on first start; for subsequent
# schema changes use the unified RivetOS image's `db migrate` command.
COPY plugins/memory/postgres/src/schema/migrations/ /migrations/

# Shared directory for inter-agent collaboration
RUN mkdir -p /rivet-shared/plans /rivet-shared/docs /rivet-shared/status /rivet-shared/whiteboard \
    && chmod -R 777 /rivet-shared

VOLUME ["/var/lib/postgresql/data", "/rivet-shared"]

EXPOSE 5432

LABEL org.opencontainers.image.source="https://github.com/philbert440/rivetOS"
LABEL org.opencontainers.image.description="RivetOS Datahub — Postgres + Shared Storage"
LABEL org.opencontainers.image.licenses="Apache-2.0"
