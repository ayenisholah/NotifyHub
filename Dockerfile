FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json prisma.config.ts tsconfig.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/api/package.json packages/api/package.json
COPY packages/workers/package.json packages/workers/package.json
COPY packages/runtime/package.json packages/runtime/package.json
COPY packages/widget/package.json packages/widget/package.json
COPY packages/demo-host/package.json packages/demo-host/package.json
COPY packages/dashboard/package.json packages/dashboard/package.json
COPY prisma ./prisma

RUN npm ci

COPY packages ./packages
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json /app/prisma.config.ts ./
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/packages/core/package.json ./packages/core/package.json
COPY --from=build --chown=node:node /app/packages/core/dist ./packages/core/dist
COPY --from=build --chown=node:node /app/packages/api/package.json ./packages/api/package.json
COPY --from=build --chown=node:node /app/packages/api/dist ./packages/api/dist
COPY --from=build --chown=node:node /app/packages/workers/package.json ./packages/workers/package.json
COPY --from=build --chown=node:node /app/packages/workers/dist ./packages/workers/dist
COPY --from=build --chown=node:node /app/packages/runtime/package.json ./packages/runtime/package.json
COPY --from=build --chown=node:node /app/packages/runtime/dist ./packages/runtime/dist
COPY --from=build --chown=node:node /app/packages/widget/package.json ./packages/widget/
COPY --from=build --chown=node:node /app/packages/demo-host/package.json ./packages/demo-host/
COPY --from=build --chown=node:node /app/packages/demo-host/dist-client ./packages/demo-host/dist-client
COPY --from=build --chown=node:node /app/packages/demo-host/dist-server ./packages/demo-host/dist-server
COPY --from=build --chown=node:node /app/packages/dashboard/package.json ./packages/dashboard/
COPY --from=build --chown=node:node /app/packages/dashboard/dist ./packages/dashboard/dist
COPY --chmod=755 scripts/container-entrypoint.sh /usr/local/bin/notifyhub-entrypoint

USER node
ENTRYPOINT ["notifyhub-entrypoint"]
CMD ["api"]
