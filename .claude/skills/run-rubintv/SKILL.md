---
name: run-rubintv
description: Build, run, and drive RubinTV (FastAPI backend + React SPA). Use when asked to start the app, run the dev servers, run the tests, take a screenshot of a page, or verify a change in the running app.
---

RubinTV is a FastAPI backend (`python/lsst/ts/rubintv/`) plus a Vite/React
SPA (`web/`), everything served under the `/rubintv/` URL prefix. Drive it by
starting both dev servers, then screenshotting pages with
`.claude/skills/run-rubintv/driver.mjs` (headless Playwright Chromium).

All paths are relative to the repo root. Verified on macOS with the repo
`.venv` (via uv) and Node 23.

## Prerequisites

- `uv` and `node`/`npm` on PATH.
- **S3 reachability (live data):** the `local` site config polls the real
  USDF buckets. Their endpoints (e.g. `sdfembs3.sdf.slac.stanford.edu` →
  172.24.7.250) are inside SLAC's private 172.24.0.0/16, reachable only over
  the user's sshuttle tunnel, with AWS `rubin-rubintv-*` profiles from
  `~/.aws/credentials`. The tunnel is normally already up (`ssh -fN slacl`
  once — passkey+Duo — then `sshuttle -r slacl 172.24.0.0/16`; the tunnel
  reuses the SSH ControlMaster for ~8h). Check before assuming S3 is broken:

```bash
pgrep -fl sshuttle
```

## Setup

```bash
uv sync
cd web && npm install
```

For the driver (one-time; `--no-save` keeps package.json/lockfile untouched —
playwright is deliberately not a web/ dependency):

```bash
npm --prefix web install --no-save playwright
cd web && npx playwright install chromium
```

## Run (agent path)

Backend first (uvicorn's default port 8000 is what the vite proxy expects;
point `RUBINTV_CACHE_DIR` at the repo `cache/` dir for a warm start, or at a
scratch dir for a cold one):

```bash
RUBINTV_CACHE_DIR=$PWD/cache uv run uvicorn lsst.ts.rubintv.main:app --reload \
  > /tmp/rubintv-backend.log 2>&1 & echo $! > /tmp/rubintv-backend.pid
timeout 30 bash -c 'until curl -sf localhost:8000/rubintv/api/health/status >/dev/null; do sleep 1; done'
```

Frontend (serves the SPA at `http://localhost:5173/rubintv/`, proxying
`/rubintv/api` and `/rubintv/ws` to the backend):

```bash
cd web && npm run dev > /tmp/rubintv-vite.log 2>&1 & echo $! > /tmp/rubintv-vite.pid
timeout 30 bash -c 'until curl -sf http://localhost:5173/rubintv/ >/dev/null; do sleep 1; done'
```

Both dev servers are often **already running** (check
`lsof -iTCP:5173 -sTCP:LISTEN` / `lsof -iTCP:8000 -sTCP:LISTEN` first). To
run a second stack without touching the existing one, give both halves spare
ports — `RUBINTV_BACKEND_PORT` tells the vite proxy where the backend is:

```bash
RUBINTV_CACHE_DIR=/tmp/rubintv-trial-cache uv run uvicorn lsst.ts.rubintv.main:app --port 8010 &
cd web && RUBINTV_BACKEND_PORT=8010 npm run dev -- --port 5175 --strictPort &
```

### Screenshot / drive pages

```bash
node .claude/skills/run-rubintv/driver.mjs status /tmp/status.png
node .claude/skills/run-rubintv/driver.mjs status /tmp/status-dark.png --dark
node .claude/skills/run-rubintv/driver.mjs status /tmp/tall.png --height 2400
node .claude/skills/run-rubintv/driver.mjs "" /tmp/home.png            # home page
node .claude/skills/run-rubintv/driver.mjs status /tmp/s.png --port 5175  # trial stack
```

| option | what it does |
|---|---|
| `[path]` | route under `/rubintv/`, e.g. `status`, `summit-usdf/auxtel`; full URLs pass through |
| `[out.png]` | output file (default `rubintv-shot.png` in cwd) |
| `--port N` | vite port (default 5173) |
| `--dark` | stamps `data-theme="dark"` on `<html>` before the shot |
| `--height N` | viewport height (default 900) — see Gotchas on why not fullPage |
| `--wait SEL` | extra CSS selector to await |

Exit code 2 (with a `CONSOLE ERRORS:` block) means the page logged errors —
read them; the screenshot is still written. **Look at the screenshot**; a
rendered shell can still be showing an error state.

Stop the servers with `kill $(cat /tmp/rubintv-backend.pid /tmp/rubintv-vite.pid)`.

## Run (human path)

Same two commands in two terminals, foregrounded; browse
`http://localhost:5173/rubintv/`. Ctrl-C each.

## Test

```bash
cd web && npx vitest run        # 152 tests, ~15s
uv run pytest -q                # 250 tests, ~55s, writes htmlcov/
```

## Gotchas

- **Everything lives under `/rubintv/`** — `curl localhost:8000/api/...`
  404s ("detail: Not Found"); it's `localhost:8000/rubintv/api/...`, and the
  SPA is `http://localhost:5173/rubintv/` (not `/`).
- **Playwright `fullPage` screenshots can't see below the fold.** The app
  shell is a fixed `100vh` flex column (`.app-root`) with an internal scroll
  container, so `fullPage: true` captures exactly one viewport. Use
  `--height 2400` (tall viewport) to capture long pages.
- **Backend module path**: `lsst.ts.rubintv.main:app` works after `uv sync`
  (editable install). `uv run` prints a harmless warning if a conda env is
  active (`VIRTUAL_ENV=... does not match the project environment`) — ignore
  it; it still uses `.venv`.
- **Admin writes need an auth header.** In deployment Gafaelfawr injects the
  authenticated user; the vite proxy fakes it locally (`X-Auth-User:
  localdev`, override with `RUBINTV_DEV_USER`). Hitting the backend directly
  without the header 403s admin routes.
- **In-cluster only:** never rely on `$RUBINTV_PORT` (Kubernetes service
  links clobber it); the port knob is the `--port` argument /
  `RUBINTV_HTTP_PORT` (see `scripts/start.sh`).
- **DDV/exp_checker sub-apps skip themselves locally** (`subapp.skip` log
  lines at startup) — expected; they only build in the container entrypoint.

## Troubleshooting

- **`Cannot find module '.../web/.claude/skills/...'`**: you invoked the
  driver from `web/` with its repo-root-relative path. The driver runs from
  any cwd — just give node a valid path to it (the commands above assume the
  repo root).
- **`Cannot find package 'playwright'` from driver.mjs**: the un-saved
  install is missing (it vanishes on any fresh `npm install` in `web/`).
  Re-run `npm --prefix web install --no-save playwright`.
- **`Port 5175 is already in use` with `--strictPort`**: a previous trial
  vite is still up — `kill $(cat /tmp/rubintv-vite.pid)` or pick another port.
- **Status page shows "S3 unreachable" / poll cycles failing**: the sshuttle
  tunnel is down. `pgrep -fl sshuttle`; restart it per Prerequisites.
