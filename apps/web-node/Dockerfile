FROM node:24-bookworm-slim AS base
WORKDIR /workspace
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

FROM base AS dependencies
ARG NPM_REGISTRY=https://registry.npmjs.org/
COPY package.json package-lock.json* ./
COPY apps/web-node/package.json apps/web-node/package.json
COPY apps/media-ingestion-node/package.json apps/media-ingestion-node/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN --mount=type=cache,target=/root/.npm \
  npm config set registry "${NPM_REGISTRY}" \
  && npm config set fetch-retries 5 \
  && npm config set fetch-retry-mintimeout 20000 \
  && npm config set fetch-retry-maxtimeout 120000 \
  && npm config set fetch-timeout 300000 \
  && for attempt in 1 2 3; do npm install --no-audit --progress=false && exit 0; echo "npm install failed on attempt ${attempt}, retrying..."; sleep 10; done; exit 1

FROM dependencies AS build
ENV DATABASE_URL=postgresql://build:build@localhost:5432/build?schema=public
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY apps/web-node apps/web-node
RUN npm run build --workspace @creator-studio/contracts \
  && npm run build --workspace @creator-studio/web-node

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=dependencies /workspace/node_modules ./node_modules
COPY --from=dependencies /workspace/apps/web-node/node_modules ./apps/web-node/node_modules
COPY --from=build /workspace/apps/web-node/dist ./apps/web-node/dist
COPY --from=build /workspace/apps/web-node/package.json ./apps/web-node/package.json
COPY --from=build /workspace/apps/web-node/prisma ./apps/web-node/prisma
COPY --from=build /workspace/apps/web-node/prisma.config.ts ./apps/web-node/prisma.config.ts
COPY --from=build /workspace/apps/web-node/src/generated ./apps/web-node/src/generated
COPY --from=build /workspace/apps/web-node/src/modules/auth/password.ts ./apps/web-node/src/modules/auth/password.ts
COPY --from=build /workspace/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /workspace/packages/contracts/json-schema ./packages/contracts/json-schema
COPY --from=build /workspace/packages/contracts/package.json ./packages/contracts/package.json
WORKDIR /workspace/apps/web-node
USER node
CMD ["node", "dist/server.js"]
