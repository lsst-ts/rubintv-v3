# RubinTV (rebuild)

A ground-up rebuild of RubinTV — the Vera C. Rubin Observatory's web app for
near-real-time and historical viewing of telescope data products.

This repository is the clean reimplementation described in
[design/00-overview.md](design/00-overview.md). It is developed phase by
phase, one branch per phase:

| Phase | Branch                 | Scope                                            |
| ----- | ---------------------- | ------------------------------------------------ |
| 1     | `phase-1-foundation`   | Project skeleton, config, models, dev loop, CI   |
| 2     | `phase-2-data-layer`   | S3 ingestion, in-memory `EventStore`, cache      |
| 3     | `phase-3-api`          | REST API over the store                          |
| 4     | `phase-4-realtime`     | WebSocket server + live updates                  |
| 5     | `phase-5-frontend`     | React SPA (all views)                            |
| 6     | `phase-6-subapps`      | DDV + exp_checker integration                    |
| 7     | `phase-7-ops`          | Operational readiness, deployment                |

Each phase branches off the previous one, so `main` accumulates the plan and
each branch builds on the last.

## Layout

```
python/lsst/ts/rubintv/   Python backend (FastAPI), packaged as lsst.ts.rubintv
web/                       React + TypeScript SPA (Vite)
design/                    The rebuild plan and design notes
conda/, ups/, Jenkinsfile* lsst-ts conda/EUPS packaging (Jenkins CI)
```

## Development

Backend (uses [uv](https://docs.astral.sh/uv/)):

```sh
uv sync
uv run uvicorn lsst.ts.rubintv.main:app --reload
# or via the installed console script:
uv run run_rubintv
```

Frontend:

```sh
cd web
npm install
npm run dev
```

See the relevant phase section of [the design doc](design/00-overview.md)
for what is in scope at each stage.

## Docs

- [docs/viewer-guide.md](docs/viewer-guide.md) — using the web app: table
  filters and shareable URLs (incl. the `seq_filter` parameter).
- [docs/operator-guide.md](docs/operator-guide.md) — running, configuring, and
  operating the server.
