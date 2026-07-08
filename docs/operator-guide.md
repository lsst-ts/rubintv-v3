# RubinTV Operator Guide

How to run, configure, and operate the rebuilt RubinTV server.

## What it is

A single-replica FastAPI app that indexes telescope data products from S3
and serves them to a React SPA over REST + WebSocket. It is **read-only**
against S3; data is written by external pipelines. See
[design/00-overview.md](../design/00-overview.md) for architecture.

## Configuration

All runtime config is environment variables, prefixed `RUBINTV_` (see
[.env.example](../.env.example)). The cameras/locations/channels themselves
come from the YAML at `RUBINTV_MODELS_PATH`.

| Variable                      | Default                    | Purpose                                                       |
| ----------------------------- | -------------------------- | ------------------------------------------------------------- |
| `RAPID_ANALYSIS_LOCATION`     | `local`                    | Deployment site name (set by the Rapid Analysis environment; note: **not** `RUBINTV_`-prefixed). |
| `RUBINTV_MODELS_PATH`         | packaged copy              | Validated cameras/locations/channels config. Unset = the copy shipped in the `lsst.ts.rubintv.models` package; set to override with an on-disk file. |
| `RUBINTV_CACHE_DIR`           | `/scratch`                 | PVC dir for warm-start cache. Missing/unwritable dir (no PVC) disables the cache with one warning. |
| `RUBINTV_REDIS_URL`           | unset                      | Redis for detector/admin live updates. Unset = disabled.     |
| `RUBINTV_POLL_INTERVAL_SECONDS` | `1.0`                    | Current-day S3 poll cadence.                                  |
| `RUBINTV_SPA_DIST`            | unset                      | Built SPA dir to serve. Unset (dev) = Vite serves the SPA.    |
| `RUBINTV_DDV_PATH`            | unset                      | DDV Flutter build dir. Unset = `/ddv` not mounted.            |
| `RUBINTV_EXP_CHECKER_ENABLED` | `false`                    | Mount the `exp_checker` sub-app at `/exp_checker`.            |
| `RUBINTV_LOG_LEVEL`           | `INFO`                     | Log level.                                                    |
| `RUBINTV_JSON_LOGS`           | `false` (dev), `true` (img)| JSON logs in production.                                      |

## Health & readiness

- `GET /api/health/live` — process is up (liveness probe).
- `GET /api/health/ready` — 200 once the **first current-day poll** has
  completed; 503 before that. Use as the k8s readiness probe so traffic is
  not routed to an empty store.
- `GET /api/health/status` — `{ ready, historical_loading }`.
  `historical_loading` is true until the first full back-catalogue scan
  finishes; the SPA shows a non-blocking "still loading" affordance.

## Startup behaviour (cache warming)

- **With a PVC** (mounted at `RUBINTV_CACHE_DIR`, default `/scratch`): the store loads cached per-date
  slices on startup and serves immediately, then reconciles against S3 in
  the background. The cache is **never** trusted as truth — every load is
  reconciled by a real scan. Corrupt or version-mismatched slices are
  skipped and rebuilt.
- **Without a PVC**: a full S3 scan runs at startup. Config and live data
  are served right away; history streams in as it loads.

A PVC write failure mid-run is non-fatal — caching is best-effort.

## Redis (optional)

If `RUBINTV_REDIS_URL` is unset or the server is unreachable, detector
status and admin control-readback live updates are disabled with a logged
warning. The rest of the app serves S3 data normally — there is no silent,
total degradation. Keyspace notifications must be enabled on the Redis
server for `*_READBACK` updates (`notify-keyspace-events KEA`).

## Graceful shutdown

On SIGTERM the app stops Redis readers, closes WebSocket connections,
cancels background pollers, flushes the cache to the PVC (if present), and
closes S3 clients. `kubectl rollout` drains cleanly.

## Admin access

Control writes (`POST /api/locations/{loc}/admin/controls`) require the
caller to be in the location's `admin_users` list, identified by the
reverse-proxy header `X-Auth-User`. The app is embargoed and not publicly
reachable; there is no other auth layer.

## Running

Dev:

```sh
uv run uvicorn lsst.ts.rubintv.main:app --reload    # backend on :8000
cd web && npm run dev                        # SPA on :5173, proxies /api,/ws
```

Production (container serves API + SPA from one process):

```sh
docker build -t rubintv .
docker run -p 8080:8080 -e RAPID_ANALYSIS_LOCATION=summit rubintv   # container listens on 8080
```

## Branch model

Work flows through three long-lived branches, matching the TSSW
convention:

- `tickets/DM-NNNNN` — one branch per unit of work, cut from `develop`.
  Opens a PR into `develop` for review.
- `develop` — the integration branch. Ticket PRs merge here after review;
  this is where features accumulate between releases.
- `main` — the release branch and the repo default. `develop` merges into
  `main` via a reviewed PR, and the merge commit is tagged (see Releasing
  below) to cut a production version.

`main` is protected by a GitHub *ruleset* (Settings → Rules → Rulesets),
not the file-based config in the repo. The ruleset requires a PR with at
least one approval, blocks force-pushes and deletion, and lets admins
bypass in a break-glass situation. GitHub is the source of truth for the
active rules; the `.claude/branch-protection-ruleset.json` payload is only
the one-time input used to create it, so treat the live ruleset — not that
file — as authoritative if the two ever disagree. Applying or changing the
default branch and the ruleset both require repo **admin**; `maintain`
(which most contributors have) cannot.

## Releasing

The git tag is the single source of truth for the version — no files are
edited to cut a release:

```sh
git tag -a v3.1.0 -m "RubinTV 3.1.0"
git push origin v3.1.0
```

Everything else follows from the tag automatically:

- setuptools_scm derives the package version (`3.1.0`) from it and writes
  `_version.py`, which is what `__version__` (and the Admin page) report.
- The tag push triggers CI's image build, which passes the computed version
  plus the commit sha/date as build args; the image lands at
  `ghcr.io/lsst-ts/rubintv-v3:v3.1.0` (the docker tag is the git ref name).
- Untagged commits self-describe as dev versions (`3.1.1.dev5+g<sha>`), so
  ticket-branch images are always distinguishable from releases.

Tags must be `vX.Y.Z` on a commit reachable from the deployed branch. The
`web/package.json` version is vestigial (nothing reads it); sync it if tidiness
demands, but nothing breaks when it drifts.

## Observability

Structured logs (JSON in prod) carry a per-request `request_id` (honours an
inbound `X-Request-ID` from the proxy, else generated, echoed on the
response). Key log events: `startup.*`, `poll.ready`, `poll.historical.idle`,
`day.rollover`, `ws.connect`/`ws.disconnect`, `redis.*`, `cache.*`,
`subapp.*`, `spa.*`.

## Migration / cutover

Run old and new side by side against the same buckets. Diff the API/table
output (`/api/.../dates/{date}`, `/calendar`) for a set of dates and cameras
before cutover; investigate any divergence with the producer team since S3
is authoritative.

## API docs

Interactive OpenAPI docs at `/docs`; the schema is at `/openapi.json` (also
committed at the repo root and consumed by the frontend type generator,
`cd web && npm run gen:api`).
