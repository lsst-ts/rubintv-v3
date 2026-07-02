# Multi-stage build: build the SPA with Node, then serve API + static assets
# from a Python runtime. The DDV Flutter app is deliberately *not* built
# here: the entrypoint (scripts/start.sh) builds it at container start, so a
# pod restart picks up new commits of the DDV repos without rebuilding this
# image. The runtime image therefore carries the Flutter SDK + fvm.

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

# What the container-start DDV build needs: git to clone, the rest for the
# Flutter web toolchain.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ca-certificates curl git libglu1-mesa unzip xz-utils zip && \
    rm -rf /var/lib/apt/lists/*

# Flutter won't run as root, so everything runs as a dedicated user.
RUN groupadd -g 1000 rubintv && useradd -u 1000 -g rubintv -m rubintv
WORKDIR /app
RUN chown rubintv:rubintv /app
USER rubintv

# Flutter SDK + fvm for the container-start DDV build. `flutter doctor`
# pre-warms the Dart SDK so container start only pays for the build itself;
# fvm fetches whatever SDK version the DDV repos pin.
RUN git clone -b stable --depth 1 \
    https://github.com/flutter/flutter.git /home/rubintv/flutter
ENV PATH="/home/rubintv/flutter/bin:/home/rubintv/.pub-cache/bin:${PATH}"
RUN flutter doctor && dart pub global activate fvm

# Install deps first for layer caching.
COPY --chown=rubintv:rubintv pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev --no-install-project

COPY --chown=rubintv:rubintv rubintv/ ./rubintv/
COPY --chown=rubintv:rubintv config/ ./config/
# pyproject declares readme = README.md; hatchling refuses to build the
# project wheel without it.
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
    RUBINTV_DDV_PATH=/app/ddv-build/ddv/build/web \
    RUBINTV_JSON_LOGS=true \
    RUBINTV_GIT_SHA=$GIT_SHA \
    RUBINTV_GIT_DATE=$GIT_DATE

EXPOSE 8000
CMD ["bash", "scripts/start.sh"]
