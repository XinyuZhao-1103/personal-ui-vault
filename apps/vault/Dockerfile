ARG NODE_IMAGE=node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914
FROM ${NODE_IMAGE} AS build
WORKDIR /source/apps/vault
COPY apps/vault/package.json apps/vault/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY apps/vault/ ./
COPY apps/web/lib/parsers.ts ../web/lib/parsers.ts
RUN npm run check && npm run build

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production VAULT_HOST=0.0.0.0 VAULT_PORT=4310 VAULT_DATA_DIR=/app/data
WORKDIR /app
COPY apps/vault/package.json apps/vault/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && mkdir -p /app/data && chown node:node /app/data
COPY --from=build /source/apps/vault/dist ./dist
COPY --from=build /source/apps/vault/generated ./generated
COPY apps/vault/server ./server
USER node
EXPOSE 4310
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD node -e "fetch('http://127.0.0.1:4310/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.mjs", "--production"]
