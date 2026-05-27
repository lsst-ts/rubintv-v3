# Multi-stage build: build the SPA with Node, then serve API + static assets
# from a slim Python runtime. The frontend build is wired into the image in
# Phase 7 (static mount); Phase 1 establishes the stages.

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
WORKDIR /app

# Install deps first for layer caching.
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev --no-install-project

COPY rubintv/ ./rubintv/
COPY config/ ./config/
RUN uv sync --locked --no-dev

# Built SPA assets, served by FastAPI (catch-all for deep links).
COPY --from=web /web/dist ./web/dist

ENV RUBINTV_SPA_DIST=/app/web/dist \
    RUBINTV_JSON_LOGS=true

EXPOSE 8000
CMD ["uv", "run", "uvicorn", "rubintv.main:app", "--host", "0.0.0.0", "--port", "8000"]
