# syntax=docker/dockerfile:1
# Build context = repo root:  docker build -f services/scramble/Dockerfile -t cubetype/scramble:dev .
# ---- build stage: runs natively on the build machine; output is architecture-independent JS
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /repo
COPY . .
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
RUN node scripts/build-service.mjs services/scramble

# ---- cubing.js stage: cubing is kept OUT of the bundle (it starts its search worker from its own
# files, which esbuild cannot inline), so it is installed here — pinned to the repo's version.
# It is pure JS, so this also runs natively and the result is copied into any target platform.
# Of its declared dependencies only random-uint-below is loaded by cubing/scramble + cubing/search;
# three.js, @optique and the type packages (+ their own deps) serve <twisty-player>, the CLI and
# TypeScript → removed.
FROM --platform=$BUILDPLATFORM node:22-alpine AS cubing
ARG CUBING_VERSION=0.65.1
WORKDIR /app
RUN --mount=type=cache,target=/root/.npm \
    npm init -y >/dev/null \
 && npm install --omit=dev --no-audit --no-fund cubing@${CUBING_VERSION} \
 && rm -rf node_modules/three node_modules/@types node_modules/type-fest node_modules/@optique \
           node_modules/@tweenjs node_modules/@webgpu node_modules/fflate node_modules/meshoptimizer node_modules/tagged-tag

# ---- runtime stage: node + one bundled file + node_modules/cubing, runs as the unprivileged "node" user
FROM node:22-alpine
ARG APP_VERSION=dev
ENV NODE_ENV=production SERVICE_NAME=scramble APP_VERSION=${APP_VERSION} PORT=8080
WORKDIR /app
COPY --from=cubing /app/node_modules ./node_modules
# the bundle's `import('cubing/scramble')` resolves from /app/dist → /app/node_modules
COPY --from=build /repo/services/scramble/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "--enable-source-maps", "dist/index.mjs"]
