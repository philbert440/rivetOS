# RivetOS Agent Container
# Single-stage build — runs from source via tsx.
# Build context must be the repo root.
#
#   docker build -f infra/containers/agent/Dockerfile -t rivetos-agent .

FROM node:24-alpine

# System deps: git (for rivetos update), tini (PID 1 signal handling)
RUN apk add --no-cache git tini

WORKDIR /app

# Copy the full source tree.
# All workspace roots declared in the root package.json must be present
# at `npm ci` time so the workspace graph resolves; otherwise npm errors
# with "missing workspace" or silently skips workspace deps.
COPY package.json package-lock.json nx.json tsconfig.base.json config.example.yaml ./
COPY scripts/ scripts/
COPY packages/ packages/
COPY plugins/ plugins/
COPY apps/ apps/
COPY services/ services/
COPY bin/ bin/
COPY infra/ infra/

RUN npm ci --ignore-scripts

# Non-root user — the agent should not run as root
# Workspace dirs are created as mount targets only — all mutable data lives on
# the host via bind mounts or named volumes.
RUN addgroup -S rivetos && adduser -S rivetos -G rivetos \
    && mkdir -p /home/rivetos/.rivetos/workspace/memory \
    && mkdir -p /home/rivetos/.rivetos/workspace/skills \
    && chown -R rivetos:rivetos /home/rivetos \
    && chown -R rivetos:rivetos /app

ENV NODE_ENV=production
ENV RIVETOS_DATA_DIR=/home/rivetos/.rivetos
ENV RIVETOS_HEALTH_PORT=3100

EXPOSE 3100

# Healthcheck — hit the runtime's /health/live endpoint.
# pgrep matching "rivetos" is unreliable because the actual process is
# `node --import tsx packages/cli/src/index.ts start` — the string "rivetos"
# only appears as a path fragment and pgrep -f matches against argv which
# may or may not include the full path depending on tini wrapping.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "require('http').get('http://127.0.0.1:' + (process.env.RIVETOS_HEALTH_PORT || '3100') + '/health/live', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

USER rivetos

# tini handles PID 1 and signal forwarding properly in containers
ENTRYPOINT ["tini", "--"]
CMD ["node", "--import", "tsx", "packages/cli/src/index.ts", "start"]

LABEL org.opencontainers.image.source="https://github.com/philbert440/rivetOS"
LABEL org.opencontainers.image.description="RivetOS AI Agent Runtime"
LABEL org.opencontainers.image.licenses="Apache-2.0"
