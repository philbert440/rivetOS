# RivetOS Datahub Container
# Postgres 16 + pgvector + shared directory structure.
# Serves as the central data store for all agents.
#
#   docker build -t rivetos-datahub infra/containers/datahub/

FROM pgvector/pgvector:pg16

# Init scripts — postgres runs these on first start, in alphabetical order
COPY init-db.sh /docker-entrypoint-initdb.d/01-init-db.sh
COPY init-shared.sh /docker-entrypoint-initdb.d/02-init-shared.sh

# Shared directory for inter-agent collaboration
RUN mkdir -p /shared/plans /shared/docs /shared/status /shared/whiteboard \
    && chmod -R 777 /shared

VOLUME ["/var/lib/postgresql/data", "/shared"]

EXPOSE 5432

LABEL org.opencontainers.image.source="https://github.com/philbert440/rivetOS"
LABEL org.opencontainers.image.description="RivetOS Datahub — Postgres + Shared Storage"
LABEL org.opencontainers.image.licenses="Apache-2.0"
