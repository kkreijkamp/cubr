# syntax=docker/dockerfile:1
# ---- build stage: runs natively on the build machine; output is architecture-independent JS
FROM --platform=$BUILDPLATFORM node:26-alpine AS build
WORKDIR /repo
COPY . .
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
RUN node scripts/build-service.mjs services/race

# ---- runtime stage: node + one bundled file (socket.io, redis adapter, ioredis inlined),
#      runs as the unprivileged "node" user
FROM node:26-alpine
ARG APP_VERSION=dev
ENV NODE_ENV=production SERVICE_NAME=race APP_VERSION=${APP_VERSION} PORT=8080
WORKDIR /app
COPY --from=build /repo/services/race/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "--enable-source-maps", "dist/index.mjs"]
