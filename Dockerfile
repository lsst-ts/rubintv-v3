# Multi-stage build: build the SPA with Node, then serve API + static assets
# from a Python runtime. The DDV web app is deliberately *not* built here:
# the entrypoint (scripts/start.sh) builds it at container start, so a pod
# restart picks up new commits of the DDV repo without rebuilding this
# image. The runtime image therefore carries Node as well.

# --- Stage 1: build the frontend ---
FROM node:22-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# --- Stage 2: Python runtime ---
FROM python:3.12-slim AS runtime
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# What the container-start DDV build needs: git to clone (npm also fetches
# the app's rubin-charts git dependency with it) and Node to build. Debian's
# own nodejs is too old for the app's toolchain (Vite needs 20.19+), so Node
# comes from NodeSource; 24 matches what the DDV repo's CI builds with.
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl git && \
    curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    rm -rf /var/lib/apt/lists/*

# Everything runs as a dedicated, unprivileged user.
RUN groupadd -g 1000 rubintv && useradd -u 1000 -g rubintv -m rubintv
WORKDIR /app
RUN chown rubintv:rubintv /app
USER rubintv

# setuptools_scm derives the version from git, which isn't present in this
# context. CI passes the computed version as a build arg; fall back to 0.0.0
# for ad-hoc local builds so the install still succeeds.
ARG RUBINTV_VERSION=0.0.0
ENV SETUPTOOLS_SCM_PRETEND_VERSION=${RUBINTV_VERSION}

# Install deps first for layer caching.
COPY --chown=rubintv:rubintv pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev --no-install-project

# Source + packaged config live under python/ (lsst.ts.rubintv namespace).
COPY --chown=rubintv:rubintv python/ ./python/
# pyproject declares readme = README.md; the build backend refuses to build
# the project wheel without it.
COPY --chown=rubintv:rubintv README.md ./
RUN uv sync --locked --no-dev

# Built SPA assets, served by FastAPI (catch-all for deep links).
COPY --from=web --chown=rubintv:rubintv /web/dist ./web/dist

COPY --chown=rubintv:rubintv scripts/build-ddv.sh scripts/start.sh ./scripts/

# Build provenance for the Admin page. Passed in by the image builder
# (`--build-arg GIT_SHA=$(git rev-parse --short HEAD) --build-arg
# GIT_DATE=$(git log -1 --format=%cd --date=format:%Y-%m-%d)`) because the
# runtime image carries no .git, so the backend can't recover them later.
# Default "unknown" keeps a plain `docker build` (no build args) working.
ARG GIT_SHA=unknown
ARG GIT_DATE=unknown

# RUBINTV_DDV_PATH matches where start.sh leaves the DDV build (under
# DDV_BUILD_DIR); the mount skips quietly when no build happened.
ENV RUBINTV_SPA_DIST=/app/web/dist \
    RUBINTV_DDV_PATH=/app/ddv-build/ddv/dist \
    RUBINTV_JSON_LOGS=true \
    RUBINTV_GIT_SHA=$GIT_SHA \
    RUBINTV_GIT_DATE=$GIT_DATE

EXPOSE 8080
CMD ["bash", "scripts/start.sh"]
