# Multi-stage build: build the SPA with Node and the DDV Flutter app with
# the Flutter SDK, then serve API + static assets from a slim Python runtime.

# --- Stage 1: build the frontend ---
FROM node:22-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# --- Stage 2: build the DDV Flutter app ---
# DDV (rubintv_visualization + its rubin_chart dependency) is cloned and
# built here so the runtime image ships ready-made assets — v2 rebuilt it at
# every container start. The websocket address and base href are baked into
# the build, so they're build args, not runtime env.
FROM ghcr.io/cirruslabs/flutter:stable AS ddv
ARG DDV_DEPLOY_BRANCH=main
ARG DDV_BASE_HREF=/rubintv/ddv/
ARG DDV_CLIENT_WS_ADDRESS=rubintv/ws/ddv
ENV PATH="/root/.pub-cache/bin:${PATH}"
RUN dart pub global activate fvm
WORKDIR /src
COPY scripts/build-ddv.sh .
RUN bash build-ddv.sh

# --- Stage 3: Python runtime ---
FROM python:3.12-slim AS runtime
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
WORKDIR /app

# Install deps first for layer caching.
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev --no-install-project

COPY rubintv/ ./rubintv/
COPY config/ ./config/
RUN uv sync --locked --no-dev

# The exp_checker sub-app, mounted at {prefix}/exp_checker only where
# RUBINTV_EXP_CHECKER_ENABLED=true (USDF); installed unconditionally so one
# image serves every site. The tarball URL avoids needing git in the image;
# setuptools_scm can't derive a version without .git, hence the pretend pin.
ARG EXP_CHECKER_REF=main
RUN SETUPTOOLS_SCM_PRETEND_VERSION=0.0.0 uv pip install \
    "rubin-exp-checker @ https://github.com/lsst-sitcom/rubin_exp_checker/archive/${EXP_CHECKER_REF}.tar.gz"

# Built SPA assets, served by FastAPI (catch-all for deep links).
COPY --from=web /web/dist ./web/dist
# Built DDV Flutter assets, served at {prefix}/ddv.
COPY --from=ddv /src/ddv/build/web ./ddv

ENV RUBINTV_SPA_DIST=/app/web/dist \
    RUBINTV_DDV_PATH=/app/ddv \
    RUBINTV_JSON_LOGS=true

EXPOSE 8000
# --no-sync: uv run must not "correct" the venv back to the lockfile, which
# would strip the exp_checker install above.
CMD ["uv", "run", "--no-sync", "uvicorn", "rubintv.main:app", "--host", "0.0.0.0", "--port", "8000"]
