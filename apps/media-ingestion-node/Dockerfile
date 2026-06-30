FROM node:24-bookworm-slim AS build
ARG NPM_REGISTRY=https://registry.npmjs.org/
WORKDIR /workspace
COPY package.json package-lock.json* ./
COPY apps/media-ingestion-node/package.json apps/media-ingestion-node/package.json
COPY apps/web-node/package.json apps/web-node/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN --mount=type=cache,target=/root/.npm \
  npm config set registry "${NPM_REGISTRY}" \
  && npm config set fetch-retries 5 \
  && npm config set fetch-retry-mintimeout 20000 \
  && npm config set fetch-retry-maxtimeout 120000 \
  && npm config set fetch-timeout 300000 \
  && for attempt in 1 2 3; do npm install --no-audit --progress=false && exit 0; echo "npm install failed on attempt ${attempt}, retrying..."; sleep 10; done; exit 1
COPY tsconfig.base.json ./
COPY apps/media-ingestion-node apps/media-ingestion-node
RUN npm run build --workspace @creator-studio/media-ingestion-node

FROM node:24-bookworm-slim
WORKDIR /workspace/apps/media-ingestion-node
ENV NODE_ENV=production
COPY --from=build /workspace/node_modules /workspace/node_modules
COPY --from=build /workspace/apps/media-ingestion-node/dist ./dist
COPY --from=build /workspace/apps/media-ingestion-node/package.json ./package.json
USER node
CMD ["node", "dist/server.js"]
