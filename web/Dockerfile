# syntax=docker/dockerfile:1
# cubetype web — React SPA built with Vite, served by unprivileged nginx.
# Build context: repository root (needs packages/cubestats for shared stats code).

# ---- build stage (native arch; output is static files)
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /repo
COPY packages/cubestats packages/cubestats
COPY web/package.json web/package-lock.json web/
RUN --mount=type=cache,target=/root/.npm cd web && npm ci --no-audit --no-fund
COPY web web
# No APP_VERSION here: the bundle doesn't contain the version (the footer reads it from /_info),
# so a release that doesn't change web/ builds identical chunk names and a rollout can't 404 them.
# npm run build = tsc --noEmit (type errors fail the image build) + vite build
RUN cd web && npm run build

# ---- runtime stage: nginx as non-root (uid 101), listening on 8080
FROM nginxinc/nginx-unprivileged:1.27-alpine
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION} NODE_NAME=local
COPY web/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /repo/web/dist /usr/share/nginx/html
EXPOSE 8080
