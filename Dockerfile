FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY core ./core
COPY adapters ./adapters
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production BRIDGE_CONFIG=/app/config/bridge.json
RUN addgroup -S bridge && adduser -S bridge -G bridge
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Runtime config, registry and .env are mounted by the host (read-only), never baked in.
RUN mkdir -p /app/data /app/config && chown bridge:bridge /app/data
USER bridge
EXPOSE 18090
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:18090/healthz || exit 1
CMD ["node", "dist/src/main.js"]
