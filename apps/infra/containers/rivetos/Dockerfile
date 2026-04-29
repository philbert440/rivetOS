# RivetOS Unified Image — single image, role selected at startup.
#
# Build context = repo root.
#   docker build -f apps/infra/containers/rivetos/Dockerfile -t rivetos:latest .
#
# Run modes:
#   docker run rivetos:latest                          # role=agent (default)
#   docker run -e RIVETOS_ROLE=worker rivetos:latest   # workers
#   docker run -e RIVETOS_ROLE=migrate rivetos:latest  # apply migrations + exit
#   docker run -e RIVETOS_ROLE=monolith rivetos:latest # agent + workers
#
# Postgres remains a separate service (use upstream pgvector/pgvector:pg16
# image; this image does not bundle a database).

# ---------------------------------------------------------------------------
# Build stage — produce the esbuild bundle.
# ---------------------------------------------------------------------------
FROM node:24-alpine AS build

RUN apk add --no-cache git

WORKDIR /build

# Copy the full source needed for build. Workspaces require all package.json
# files to be present at npm ci time so the workspace graph resolves.
COPY package.json package-lock.json nx.json tsconfig.base.json ./
COPY scripts/ scripts/
COPY packages/ packages/
COPY plugins/ plugins/
COPY apps/ apps/
COPY bin/ bin/

# Install workspace deps (skip postinstall — we'll run only what we need).
RUN npm ci --ignore-scripts

# Per-package tsc build (for cross-package type resolution + service deps).
# Then esbuild bundle for the runtime entrypoint.
RUN npx nx run-many -t build --exclude container-agent,container-datahub,container-rivetos,site --parallel=1 \
 && npm run bundle

# ---------------------------------------------------------------------------
# Runtime stage — slim image, only what the bundle needs.
# ---------------------------------------------------------------------------
FROM node:24-alpine

RUN apk add --no-cache tini

WORKDIR /app

# Bundle + sourcemap.
COPY --from=build /build/dist/ ./dist/

# Native dep modules — the bundle externalizes these, so they need to be
# available at runtime. Copying the whole node_modules is the safe path;
# we can prune later once we know the precise runtime closure.
COPY --from=build /build/node_modules/ ./node_modules/

# Workers are .js files, not bundled. Copy them so role=worker / monolith
# can spawn them. They live alongside @rivetos/memory-postgres.
COPY --from=build /build/plugins/memory/postgres/workers/ ./plugins/memory/postgres/workers/

# Migration runner + SQL files (compiled by @rivetos/memory-postgres build).
COPY --from=build /build/plugins/memory/postgres/dist/schema/ ./plugins/memory/postgres/dist/schema/

# Source-tree files referenced by the runtime (e.g. workspace templates).
# Created as a directory in the build stage to ensure COPY succeeds.
RUN mkdir -p ./packages/cli/workspace-templates

# Non-root runtime user.
RUN addgroup -S rivetos && adduser -S rivetos -G rivetos \
    && mkdir -p /home/rivetos/.rivetos/workspace/memory \
    && mkdir -p /home/rivetos/.rivetos/workspace/skills \
    && chown -R rivetos:rivetos /home/rivetos /app

ENV NODE_ENV=production
ENV RIVETOS_DATA_DIR=/home/rivetos/.rivetos
ENV RIVETOS_HEALTH_PORT=3100
ENV RIVETOS_ROLE=agent

EXPOSE 3100

# Healthcheck: hit the runtime's /health/live endpoint. Workers / migrate
# roles don't expose this — disable healthcheck for those by setting
# HEALTHCHECK_DISABLE=1 at run time, or override with --no-healthcheck.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "if (process.env.RIVETOS_ROLE !== 'agent' && process.env.RIVETOS_ROLE !== 'monolith') process.exit(0); require('http').get('http://127.0.0.1:' + (process.env.RIVETOS_HEALTH_PORT || '3100') + '/health/live', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

USER rivetos

# tini handles PID 1 + signal forwarding.
ENTRYPOINT ["tini", "--"]
# Default: agent role. Override via RIVETOS_ROLE env or `--role <role>` CLI arg.
CMD ["node", "dist/rivetos.js", "start"]

LABEL org.opencontainers.image.source="https://github.com/philbert440/rivetOS"
LABEL org.opencontainers.image.description="RivetOS unified runtime image (agent / worker / monolith)"
LABEL org.opencontainers.image.licenses="Apache-2.0"
