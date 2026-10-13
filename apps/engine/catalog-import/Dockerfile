FROM node:20-bookworm-slim

WORKDIR /app
COPY apps/engine/catalog-import/package.json ./package.json
COPY apps/engine/catalog-import/package-lock.json ./package-lock.json
RUN npm ci --omit=dev --no-audit --no-fund
COPY apps/engine/catalog-import/src ./src

ENV NODE_ENV=production
CMD ["node", "src/worker.mjs"]
