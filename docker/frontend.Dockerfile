# syntax=docker/dockerfile:1

# Clearsight Next.js clinical UI image (node dependency layer + production serve).
FROM node:20-alpine AS deps

WORKDIR /app

COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install --no-audit --no-fund

FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/node_modules ./node_modules
COPY frontend/ ./

# Build the production bundle when the project defines a build script. The guard
# keeps the image buildable while the Next.js app is still being scaffolded.
RUN if node -e "const p=require('./package.json'); process.exit(p.scripts && p.scripts.build ? 0 : 1)"; then \
        npm run build; \
    fi

EXPOSE 3000
CMD ["npm", "run", "start", "--", "--hostname", "0.0.0.0", "--port", "3000"]
