# The stand: the gateway (Node) and the platform (static files behind Caddy), built from this repository.
#   docker compose -f deploy/stand/compose.yaml --env-file deploy/stand/.env up -d --build
# See docs/stand.md.

FROM node:22.12-bookworm-slim AS build
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 CI=1
# corepack in older Node images carries outdated npm signing keys; npm installs the pinned pnpm instead.
RUN npm install -g pnpm@10.28.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/content/package.json packages/content/
COPY packages/learning/package.json packages/learning/
COPY packages/xapi/package.json packages/xapi/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY e2e/package.json e2e/
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY packages packages
COPY apps apps
COPY content content
RUN pnpm content:validate && pnpm build:web

# The gateway runs the TypeScript sources through tsx, as in development.
FROM build AS gateway
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 CONTENT_DIR=/app/content
USER node
EXPOSE 8787
CMD ["node", "--import", "tsx", "apps/server/src/main.ts"]

# The platform: built files, HTTPS and the /api route to the gateway.
FROM caddy:2.8.4-alpine AS web
COPY --from=build /app/apps/web/dist /srv
COPY deploy/stand/Caddyfile /etc/caddy/Caddyfile
