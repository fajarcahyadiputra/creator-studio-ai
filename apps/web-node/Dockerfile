FROM node:24-bookworm-slim AS base
WORKDIR /workspace
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

FROM base AS dependencies
COPY package.json package-lock.json* ./
COPY apps/web-node/package.json apps/web-node/package.json
COPY apps/media-ingestion-node/package.json apps/media-ingestion-node/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm install

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
COPY --from=build /workspace/apps/web-node/dist ./apps/web-node/dist
COPY --from=build /workspace/apps/web-node/package.json ./apps/web-node/package.json
COPY --from=build /workspace/apps/web-node/prisma ./apps/web-node/prisma
COPY --from=build /workspace/apps/web-node/prisma.config.ts ./apps/web-node/prisma.config.ts
COPY --from=build /workspace/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /workspace/packages/contracts/package.json ./packages/contracts/package.json
WORKDIR /workspace/apps/web-node
USER node
CMD ["node", "dist/server.js"]
