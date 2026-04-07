# RivetOS Agent Container
# Single-stage build — runs from source via tsx.
# Build context must be the repo root.
#
#   docker build -f infra/containers/agent/Dockerfile -t rivetos-agent .

FROM node:24-alpine

# System deps: git (for rivetos update), tini (PID 1 signal handling)
RUN apk add --no-cache git tini

WORKDIR /app

# Copy the full source tree
COPY package.json package-lock.json nx.json tsconfig.base.json config.example.yaml ./
COPY scripts/ scripts/
COPY packages/ packages/
COPY plugins/ plugins/
COPY bin/ bin/
COPY infra/ infra/

# Install all dependencies (workspaces need full install to resolve correctly)
# postinstall runs: npm run build && npm run link-cli
RUN npm ci

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

# Healthcheck — lightweight process check without curl
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "try { require('child_process').execSync('pgrep -f rivetos', { stdio: 'pipe' }); process.exit(0); } catch { process.exit(1); }"

USER rivetos

# tini handles PID 1 and signal forwarding properly in containers
ENTRYPOINT ["tini", "--"]
CMD ["node", "--import", "tsx", "packages/cli/src/index.ts", "start"]

LABEL org.opencontainers.image.source="https://github.com/philbert440/rivetOS"
LABEL org.opencontainers.image.description="RivetOS AI Agent Runtime"
LABEL org.opencontainers.image.licenses="Apache-2.0"
