# syntax=docker/dockerfile:1
# cubr seed job - bundled to one file like the services; runs once and exits.
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /repo
COPY . .
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
RUN node scripts/build-service.mjs jobs/seed

FROM node:22-alpine
ARG APP_VERSION=dev
ENV NODE_ENV=production APP_VERSION=${APP_VERSION}
WORKDIR /app
COPY --from=build /repo/jobs/seed/dist ./dist
USER node
CMD ["node", "--enable-source-maps", "dist/index.mjs"]
