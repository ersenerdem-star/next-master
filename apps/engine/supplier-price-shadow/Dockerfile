# Official multi-platform manifest resolved by BuildKit, 2026-10-05.
# Local build is not a remote deployment or a vulnerability certification.
FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src/ ./src/
ENV NODE_ENV=production NODE_OPTIONS=--max-old-space-size=768 PORT=3000
USER node
EXPOSE 3000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e 'fetch("http://127.0.0.1:3000/healthz",{signal:AbortSignal.timeout(3000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'
CMD ["node", "src/worker.mjs", "--service"]
