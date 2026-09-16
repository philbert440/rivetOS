# RivetOS Unified Image — single image, role selected at startup.
#
# Build context = repo root.
#   docker build -f infra/containers/rivetos/Dockerfile -t rivetos:latest .
#
# Run modes:
#   docker run rivetos:latest                          # role=agent (default)
#   docker run -e RIVETOS_ROLE=migrate rivetos:latest  # apply migrations + exit
#
# The compaction and embedding workers are their own graphile-worker
# processes (services/compaction-worker, services/embedding-worker). Their
# compiled dist ships in this image so the compose stack can run them, but
# they are NOT part of the `rivetos start` bundle and there is no worker
# role — launch them directly:
#   docker run rivetos:latest node services/embedding-worker/dist/index.js
#   docker run rivetos:latest node services/compaction-worker/dist/index.js
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
COPY services/ services/
COPY bin/ bin/

# Install workspace deps (skip postinstall — we'll run only what we need).
RUN npm ci --ignore-scripts

# Per-package tsc build (for cross-package type resolution + service deps).
# Then esbuild bundle for the runtime entrypoint.
RUN npx nx run-many -t build --exclude container-rivetos,site --parallel=1 \
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

# Migration runner + SQL files (compiled by @rivetos/memory-postgres build),
# plus the rest of that package's dist — the compaction worker below imports
# it as a library. `node_modules/@rivetos/*` are relative workspace symlinks
# into these trees, so the package.json must come along for resolution.
COPY --from=build /build/plugins/memory/postgres/package.json ./plugins/memory/postgres/
COPY --from=build /build/plugins/memory/postgres/dist/ ./plugins/memory/postgres/dist/
# Nested dep: npm hoists undici@6 to the root for other consumers; this package
# (and compaction-worker below) lock undici@8 in a nested node_modules. Without
# these copies the in-image workers silently resolve the wrong undici major.
COPY --from=build /build/plugins/memory/postgres/node_modules/ ./plugins/memory/postgres/node_modules/

# Worker services. These are separate processes, not part of dist/rivetos.js:
#   node services/embedding-worker/dist/index.js
#   node services/compaction-worker/dist/index.js
# Only their compiled output plus the workspace packages they pull in
# (memory-postgres above, and types → den-protocol, wiki-core) are copied —
# everything else they need is already hoisted into node_modules.
COPY --from=build /build/services/embedding-worker/package.json ./services/embedding-worker/
COPY --from=build /build/services/embedding-worker/dist/ ./services/embedding-worker/dist/
COPY --from=build /build/services/compaction-worker/package.json ./services/compaction-worker/
COPY --from=build /build/services/compaction-worker/dist/ ./services/compaction-worker/dist/
COPY --from=build /build/services/compaction-worker/node_modules/ ./services/compaction-worker/node_modules/
COPY --from=build /build/packages/types/package.json ./packages/types/
COPY --from=build /build/packages/types/dist/ ./packages/types/dist/
COPY --from=build /build/packages/den-protocol/package.json ./packages/den-protocol/
COPY --from=build /build/packages/den-protocol/dist/ ./packages/den-protocol/dist/
COPY --from=build /build/packages/wiki-core/package.json ./packages/wiki-core/
COPY --from=build /build/packages/wiki-core/dist/ ./packages/wiki-core/dist/

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

# Healthcheck: hit the runtime's /health/live endpoint. The migrate role
# doesn't expose this — the inline check skips healthcheck for any role
# other than `agent`.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "if (process.env.RIVETOS_ROLE !== 'agent') process.exit(0); require('http').get('http://127.0.0.1:' + (process.env.RIVETOS_HEALTH_PORT || '3100') + '/health/live', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

USER rivetos

# tini handles PID 1 + signal forwarding.
ENTRYPOINT ["tini", "--"]
# Default: agent role. Override via RIVETOS_ROLE env or `--role <role>` CLI arg.
CMD ["node", "dist/rivetos.js", "start"]

LABEL org.opencontainers.image.source="https://github.com/philbert440/rivetOS"
LABEL org.opencontainers.image.description="RivetOS unified runtime image (agent / migrate)"
LABEL org.opencontainers.image.licenses="Apache-2.0"
