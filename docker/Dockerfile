# syntax=docker/dockerfile:1
#
# Production image for excalidraw-collab: one process, one port.
# Multi-stage: pnpm install (cached store) → build web/server/render →
# lean runtime on Playwright's Chromium base (browsers preinstalled).
#
# Config is env-only (PORT, DATA_DIR, BOOTSTRAP_TOKEN, RENDER_WORKER, LOG_LEVEL,
# plus SERVE_STATIC/STATIC_ROOT defaults baked for the single-container layout).

############################
# Stage 1: install + build
############################
FROM node:24-bookworm AS builder

RUN corepack enable && corepack prepare pnpm@11.9.0 --activate

WORKDIR /src

# Never download browsers in the builder — the runtime image already has them.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH

# Manifests first for layer caching.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY tsconfig.base.json tsconfig.json ./
COPY packages/core/package.json packages/core/tsconfig.json ./packages/core/
COPY packages/server/package.json packages/server/tsconfig.json ./packages/server/
COPY packages/cli/package.json packages/cli/tsconfig.json ./packages/cli/
COPY packages/web/package.json packages/web/tsconfig.json ./packages/web/
COPY packages/render/package.json packages/render/tsconfig.json ./packages/render/

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --frozen-lockfile

# Sources (dockerignore keeps node_modules/dist out).
COPY packages/core ./packages/core
COPY packages/server ./packages/server
COPY packages/cli ./packages/cli
COPY packages/web ./packages/web
COPY packages/render ./packages/render

# Build runtime packages. CLI is host-side only; skip it in the image.
RUN pnpm --filter @excalidraw-collab/core run build && \
    pnpm --filter @excalidraw-collab/render run build && \
    pnpm --filter @excalidraw-collab/server run build && \
    pnpm --filter @excalidraw-collab/web run build

# Portable production tree: server + workspace deps (core, render) + npm deps
# (including optional playwright). --legacy avoids inject-workspace-packages.
# PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD keeps browsers out of this layer.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm --filter @excalidraw-collab/server deploy --prod --legacy /out/app

# Built SPA for SERVE_STATIC (includes hidden /render route for the worker).
RUN mkdir -p /out/app/public && cp -a packages/web/dist/. /out/app/public/

# Lean final payload: drop source, tests, maps, buildinfo, and declarations.
RUN rm -rf /out/app/src \
           /out/app/tsconfig.json \
           /out/app/tsconfig.tsbuildinfo && \
    find /out/app -type f \( \
         -name '*.map' \
         -o -name '*.tsbuildinfo' \
         -o -name '*.test.js' \
         -o -name '*.test.d.ts' \
         -o -name '*.d.ts' \
       \) -delete && \
    find /out/app/node_modules -type d -name src -prune -exec rm -rf {} + 2>/dev/null || true && \
    find /out/app/node_modules -type d \( -name test -o -name tests -o -name __tests__ \) \
      -prune -exec rm -rf {} + 2>/dev/null || true

############################
# Stage 2: runtime
############################
# Match packages/render's resolved playwright@1.62.0 so browser paths align.
FROM mcr.microsoft.com/playwright:v1.62.0-jammy AS runtime

# Image already sets PLAYWRIGHT_BROWSERS_PATH=/ms-playwright.
# Keep skip flag so any accidental npx/playwright call does not re-fetch.
ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PORT=3000 \
    DATA_DIR=/data \
    BOOTSTRAP_TOKEN= \
    RENDER_WORKER=on \
    LOG_LEVEL=info \
    SERVE_STATIC=true \
    STATIC_ROOT=/app/public \
    HOME=/home/pwuser

WORKDIR /app

# Deployed server package (dist + production node_modules). No pnpm store.
COPY --from=builder /out/app /app

COPY docker/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 755 /usr/local/bin/docker-entrypoint.sh && \
    mkdir -p /data && \
    chown -R pwuser:pwuser /app /data

# Start as root only long enough for the entrypoint to chown the volume and
# exec Node as pwuser (PID 1 = node → SIGTERM reaches graceful shutdown).
EXPOSE 3000

VOLUME ["/data"]

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
