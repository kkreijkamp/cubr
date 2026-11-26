# syntax=docker/dockerfile:1
# cubr web - React SPA built with Vite, served by unprivileged nginx.
# Build context: repository root (needs packages/cubestats for shared stats code).

# ---- build stage (native arch; output is static files)
FROM --platform=$BUILDPLATFORM node:26-alpine AS build
# a headless Chromium for the prerender below (this stage only; the image itself is nginx)
RUN apk add --no-cache chromium
WORKDIR /repo
# the root tsconfig too: esbuild compiles packages/cubestats with the nearest one, so without it the
# image built class fields differently than a laptop does (assigned in the constructor, not defined)
COPY tsconfig.json tsconfig.base.json ./
COPY packages/cubestats packages/cubestats
COPY web/package.json web/package-lock.json web/
RUN --mount=type=cache,target=/root/.npm cd web && npm ci --no-audit --no-fund
COPY web web
# No APP_VERSION here: the bundle doesn't contain the version (the footer reads it from /_info),
# so a release that doesn't change web/ builds identical chunk names and a rollout can't 404 them.
# The offline app's service worker is built with the app (web/plugins/serviceWorker.ts). VITE_SW=off
# builds its kill switch instead, which removes the worker and its caches from every browser: the
# emergency switch in deploy/vps/README.md. Normally on.
ARG VITE_SW=on
# npm run build = typecheck (type errors fail the image build) + vite build
RUN cd web && npm run build
# each public page's content in its file, for crawlers that don't run JavaScript (scripts/prerender.mjs)
RUN cd web && node scripts/prerender.mjs

# ---- runtime stage: nginx as non-root (uid 101), listening on 8080
FROM nginxinc/nginx-unprivileged:1.31-alpine
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION} NODE_NAME=local
COPY web/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /repo/web/dist /usr/share/nginx/html
EXPOSE 8080
