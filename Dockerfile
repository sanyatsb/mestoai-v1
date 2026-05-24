# syntax=docker/dockerfile:1.7

# === Stage 1: build ===
FROM node:22-alpine AS builder

WORKDIR /app

# Pin pnpm via corepack (already shipped with Node 22).
RUN corepack enable && corepack prepare pnpm@latest --activate

# Install deps with the lockfile cached as a separate layer.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY drizzle ./drizzle

RUN pnpm build

# Prune dev deps for the runtime layer.
RUN pnpm prune --prod


# === Stage 2: runtime ===
FROM node:22-alpine AS runtime

WORKDIR /app

# [AUDIT-H1] ffmpeg for MP3 -> OGG/Opus voice synth.
# wget is used by HEALTHCHECK below.
RUN apk add --no-cache ffmpeg wget

# Non-root user.
RUN addgroup -g 1001 nodejs && adduser -S nodeapp -u 1001 -G nodejs

COPY --from=builder --chown=nodeapp:nodejs /app/dist           ./dist
COPY --from=builder --chown=nodeapp:nodejs /app/node_modules    ./node_modules
COPY --from=builder --chown=nodeapp:nodejs /app/package.json    ./
COPY --from=builder --chown=nodeapp:nodejs /app/drizzle         ./drizzle
COPY --from=builder --chown=nodeapp:nodejs /app/src/data        ./src/data
COPY --from=builder --chown=nodeapp:nodejs /app/src/locales     ./src/locales

USER nodeapp

EXPOSE 8080

# [AUDIT-L10] Healthcheck probes /ready (DB + Redis), not just /health.
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:8080/ready || exit 1

# [AUDIT-M5] Auto-migrate on container start. Drizzle migrations are
# idempotent so this is safe on every boot.
# scripts/seed-personas.ts arrives in Week 3; left out of the CMD until then.
CMD ["sh", "-c", "node dist/scripts/migrate.js && node dist/main.js"]
