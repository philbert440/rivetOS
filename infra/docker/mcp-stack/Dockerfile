# RivetOS MCP Server Container
#
# Builds the workspace and runs the standalone `rivetos-mcp-server` binary
# from `@rivetos/mcp-server`. Build context must be the repo root.
#
#   docker build -f infra/docker/mcp-stack/Dockerfile -t rivetos-mcp-server .
#
# Dev image, single-stage. Mirrors infra/containers/rivetos/Dockerfile
# in shape — the workspace graph requires the full source tree at `npm ci`
# time. Future iterations can tighten this to a multi-stage that only ships
# the compiled `dist/` outputs if image size matters.

FROM node:24-alpine

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
COPY bin/ bin/

# Belt-and-suspenders: wipe any TypeScript incremental state that leaked in.
# `tsc -b` reads *.tsbuildinfo and may skip emit if it thinks dist/ is current,
# but dist/ is excluded from the context — TS6305 results.
RUN find packages plugins apps -name 'tsconfig.tsbuildinfo' -delete 2>/dev/null || true \
 && find packages plugins apps -name '.nx' -type d -exec rm -rf {} + 2>/dev/null || true

# Install all dependencies (workspaces need full install to resolve correctly).
# Skip postinstall, build serially.
RUN npm ci --ignore-scripts \
 && npx nx run-many -t build --exclude container-rivetos,site --parallel=1 \
 && node scripts/link-cli.mjs

# Non-root user
RUN addgroup -S rivetos && adduser -S rivetos -G rivetos \
    && chown -R rivetos:rivetos /app

ENV NODE_ENV=production
ENV MCP_HOST=0.0.0.0
ENV MCP_PORT=5700

EXPOSE 5700

# Healthcheck — hit the MCP server's /health/live endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "require('http').get('http://127.0.0.1:' + (process.env.MCP_PORT || '5700') + '/health/live', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

USER rivetos

# tini handles PID 1 and signal forwarding properly in containers.
ENTRYPOINT ["tini", "--"]
CMD ["node", "plugins/transports/mcp-server/dist/cli.js"]

LABEL org.opencontainers.image.source="https://github.com/philbert440/rivetOS"
LABEL org.opencontainers.image.description="RivetOS MCP Server — exposes RivetOS tools over the Model Context Protocol"
LABEL org.opencontainers.image.licenses="Apache-2.0"
