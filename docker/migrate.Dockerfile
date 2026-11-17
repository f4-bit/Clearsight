# syntax=docker/dockerfile:1

FROM node:20-slim AS migrate

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY backend/package*.json ./
RUN npm ci

COPY backend/prisma ./prisma
COPY backend/prisma.config.ts ./prisma.config.ts

CMD ["npx", "prisma", "migrate", "deploy"]
