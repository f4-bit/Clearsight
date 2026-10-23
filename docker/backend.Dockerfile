# syntax=docker/dockerfile:1

FROM node:20-slim AS backend

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY backend/package*.json ./
RUN npm ci

COPY backend/prisma ./prisma
RUN npx prisma generate

COPY backend ./
RUN npm run build

EXPOSE 8000
CMD ["npm", "start"]
