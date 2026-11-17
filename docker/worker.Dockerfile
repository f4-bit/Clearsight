# syntax=docker/dockerfile:1

FROM node:20-slim AS worker

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY backend/package*.json ./
RUN npm ci

COPY backend/prisma ./prisma
COPY backend/prisma.config.ts ./prisma.config.ts
RUN npx prisma generate

COPY backend ./

CMD ["npm", "run", "worker"]
