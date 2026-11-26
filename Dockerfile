# Callout: backend + website + glasses app, one service (see docs/HOSTED.md).
# Secrets are NOT baked in: set them as environment variables on the host.
FROM node:20-bookworm
WORKDIR /app

# Dependencies first (cached layers). The full image has the toolchain better-sqlite3 needs.
COPY glasses/package.json glasses/package-lock.json glasses/
RUN cd glasses && npm ci
COPY web/package.json web/package-lock.json web/
RUN cd web && npm ci
COPY backend/package.json backend/package-lock.json backend/
RUN cd backend && npm ci

COPY . .
RUN cd glasses && npm run build && cd ../web && npm run build

ENV NODE_ENV=production HOST=0.0.0.0 CALLOUT_DB=/data/callout.sqlite CALLOUT_LOG_DIR=/data/logs
WORKDIR /app/backend
# Seed the labeled synthetic caller record once (real historical prices), then start.
CMD ["sh", "-c", "npx tsx scripts/seed-track-record.ts --if-empty; exec npx tsx src/index.ts"]
