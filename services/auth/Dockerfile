# syntax=docker/dockerfile:1
# Build context = repo root:  docker build -f services/auth/Dockerfile -t cubr/auth:dev .
# ---- build stage: runs natively on the build machine; output is architecture-independent JS
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /repo
COPY . .
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
RUN node scripts/build-service.mjs services/auth

# ---- runtime stage: node + one bundled file, runs as the unprivileged "node" user
FROM node:22-alpine
ARG APP_VERSION=dev
ENV NODE_ENV=production SERVICE_NAME=auth APP_VERSION=${APP_VERSION} PORT=8080
WORKDIR /app
COPY --from=build /repo/services/auth/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "--enable-source-maps", "dist/index.mjs"]
