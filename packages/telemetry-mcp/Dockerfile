# Telemetry MCP server (ENG-1799).
#
# Build from the repository root, because the package installs against the workspace lockfile:
#   docker build -f packages/telemetry-mcp/Dockerfile -t telemetry-mcp .
#
# Configuration, secrets included (HRX_IDENTITY_SECRET, LIGHTDASH_API_TOKEN, ENGINE_PG_PASSWORD,
# ANTHROPIC_API_KEY, ...), comes from the runtime environment. None is baked into the image.

# Node matches .nvmrc and the main Lightdash image.
FROM node:24.22.1-trixie-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
ENV CI=true
# pnpm comes from the root package.json "packageManager" field (exact version and sha512).
RUN corepack enable

WORKDIR /app
COPY . .

# Only this package and its dependencies, from the committed lockfile.
RUN pnpm install --frozen-lockfile --filter @lightdash/telemetry-mcp...
RUN pnpm --fail-if-no-match --filter @lightdash/telemetry-mcp build
# Drop the dev dependencies (typescript, vitest, @types/*) before copying node_modules out.
RUN pnpm install --frozen-lockfile --prod --filter @lightdash/telemetry-mcp...

FROM node:24.22.1-trixie-slim AS runtime

ENV NODE_ENV=production
ENV MCP_HOST=0.0.0.0
ENV MCP_PORT=8080

WORKDIR /app
# pnpm links the package's node_modules into the root store, so both keep their workspace paths.
# Files stay root-owned: the server only reads them.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/telemetry-mcp/package.json ./packages/telemetry-mcp/package.json
COPY --from=build /app/packages/telemetry-mcp/node_modules ./packages/telemetry-mcp/node_modules
COPY --from=build /app/packages/telemetry-mcp/dist ./packages/telemetry-mcp/dist

WORKDIR /app/packages/telemetry-mcp
# The node image's built-in unprivileged user (uid 1000).
USER node

EXPOSE 8080

# GET /healthz needs no auth: 200 when every configured source is reachable, else 503.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.MCP_PORT || 8080) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

CMD ["node", "dist/main.js"]
