FROM node:24-bookworm-slim AS build
WORKDIR /workspace
COPY package.json package-lock.json* ./
COPY apps/media-ingestion-node/package.json apps/media-ingestion-node/package.json
COPY apps/web-node/package.json apps/web-node/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm install
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
