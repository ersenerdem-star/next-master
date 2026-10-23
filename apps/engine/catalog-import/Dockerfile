# Same exact runtime as the native staging engine and supplier worker.
FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205

WORKDIR /app
COPY apps/engine/catalog-import/package.json ./package.json
COPY apps/engine/catalog-import/package-lock.json ./package-lock.json
RUN npm ci --omit=dev --no-audit --no-fund
COPY apps/engine/catalog-import/src ./src

ENV NODE_ENV=production
CMD ["node", "src/worker.mjs"]
