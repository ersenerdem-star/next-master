# Same exact runtime as the native staging engine and supplier worker.
FROM node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d

WORKDIR /app
COPY apps/engine/catalog-import/package.json ./package.json
COPY apps/engine/catalog-import/package-lock.json ./package-lock.json
RUN npm ci --omit=dev --no-audit --no-fund
COPY apps/engine/catalog-import/src ./src

ENV NODE_ENV=production
CMD ["node", "src/worker.mjs"]
