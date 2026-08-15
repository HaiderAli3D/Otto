# syntax=docker/dockerfile:1

# ── Build stage: install deps (incl. dev) and compile TypeScript → dist ───────
FROM node:22-slim AS build
WORKDIR /app

# better-sqlite3 ships a native addon. node:22-slim usually pulls a prebuilt binary,
# but keep the toolchain here so the build never fails if a prebuild is missing.
# These packages live in the build stage ONLY — the runtime image never sees them.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 build-essential \
  && rm -rf /var/lib/apt/lists/*

# Install against the lockfile first so this layer caches across source-only changes.
COPY package*.json ./
RUN npm ci

# Compile src → dist.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop devDependencies so only runtime deps (incl. the compiled better-sqlite3) remain.
RUN npm prune --omit=dev

# ── Runtime stage: minimal image with just node_modules + dist ────────────────
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

# The SQLite file lives on a mounted volume so data survives restarts and redeploys.
RUN mkdir -p /data
ENV DATABASE_PATH=/data/otto.sqlite

EXPOSE 3000
CMD ["node", "dist/index.js"]
