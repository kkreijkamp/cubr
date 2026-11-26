# syntax=docker/dockerfile:1
# Build context = repo root:  docker build -f services/auth/Dockerfile -t cubr/auth:dev .
# ---- build stage: runs natively on the build machine; output is architecture-independent JS
FROM --platform=$BUILDPLATFORM node:26-alpine AS build
WORKDIR /repo
COPY . .
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
RUN node scripts/build-service.mjs services/auth

# ---- sharp stage: profile pictures are re-encoded with sharp (src/avatarImage.ts), whose libvips is
# native code: it stays out of the bundle and is installed here for the platform the image is for
# (no --platform=$BUILDPLATFORM, so amd64 on Cloud Build and arm64 on an Apple Silicon Mac, natively in
# both). Pinned to the repo's version in package-lock.json (test/avatarImage.test.ts checks they match).
# Its WebAssembly fallback (9 MB, with its runtime) is removed: the native build has to load, which the
# last step checks, so a bad install fails this build instead of the service.
FROM node:26-alpine AS sharp
ARG SHARP_VERSION=0.35.5
WORKDIR /app
RUN --mount=type=cache,target=/root/.npm \
    npm init -y >/dev/null \
 && npm install --omit=dev --no-audit --no-fund sharp@${SHARP_VERSION} \
 && rm -rf node_modules/@img/sharp-wasm32 node_modules/@emnapi node_modules/tslib \
 && node -e "const s = require('sharp'); console.log('sharp', s.versions.sharp, 'libvips', s.versions.vips)"

# ---- runtime stage: node + one bundled file + node_modules/sharp, runs as the unprivileged "node" user
FROM node:26-alpine
ARG APP_VERSION=dev
ENV NODE_ENV=production SERVICE_NAME=auth APP_VERSION=${APP_VERSION} PORT=8080
WORKDIR /app
COPY --from=sharp /app/node_modules ./node_modules
# the bundle's `import 'sharp'` resolves from /app/dist -> /app/node_modules
COPY --from=build /repo/services/auth/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "--enable-source-maps", "dist/index.mjs"]
