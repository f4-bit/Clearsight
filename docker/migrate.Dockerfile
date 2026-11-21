# syntax=docker/dockerfile:1

FROM node:24-slim AS migrate

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY backend/package*.json ./
RUN npm ci

COPY backend/prisma ./prisma
COPY backend/prisma.config.ts ./prisma.config.ts
COPY backend/prisma.migrate.config.ts ./prisma.migrate.config.ts
COPY backend/scripts ./scripts
COPY backend/src/services/migration-deployment.ts ./src/services/migration-deployment.ts

# Audited wrapper: read-only preflight, baseline-only resolve once, then deploy.
# No shell `||` fallback and no DSN in argv.
CMD ["npm", "run", "prisma:deploy"]
