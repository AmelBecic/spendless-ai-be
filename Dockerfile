# syntax=docker/dockerfile:1

# Multi-stage build for the SpendLess backend. The Prisma client + query engine are
# generated INSIDE the image, so the engine matches the linux runtime — the macOS
# `@emnapi` optional-deps drift that reddens a local `npm ci` never reaches prod.

FROM node:24-bookworm-slim AS base
WORKDIR /app
# Prisma's query engine links against OpenSSL at runtime.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# --- deps: full install (incl. dev) so the build tooling is present ---
FROM base AS deps
COPY package.json package-lock.json ./
# postinstall runs `prisma generate`, which needs the schema present.
COPY prisma ./prisma
RUN npm ci

# --- build: bundle src/server.ts -> dist/server.js ---
FROM deps AS build
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN npm run build

# --- prod-deps: production-only modules, Prisma client generated for linux ---
FROM base AS prod-deps
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev

# --- runtime: slim final image ---
FROM base AS runtime
ENV NODE_ENV=production
COPY package.json ./
COPY prisma ./prisma
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

# Drop root for the running process.
USER node
EXPOSE 3000
# Migrations run in the entrypoint; CMD is the process it execs into.
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "dist/server.js"]
