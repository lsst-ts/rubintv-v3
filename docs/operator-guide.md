# RubinTV Operator Guide

How to run, configure, and operate the rebuilt RubinTV server.

## What it is

A single-replica FastAPI app that indexes telescope data products from S3
and serves them to a React SPA over REST + WebSocket. It is **read-only**
against S3; data is written by external pipelines. See
[design/00-overview.md](../design/00-overview.md) for architecture.

## Configuration

All runtime config is environment variables. The app itself reads the
`RUBINTV_`-prefixed ones below (see [.env.example](../.env.example)); the
container entrypoint reads a second, unprefixed set for the sub-app builds it
runs at pod start (next table). The cameras/locations/channels themselves come
from the YAML at `RUBINTV_MODELS_PATH`.

| Variable                      | Default                    | Purpose                                                       |
| ----------------------------- | -------------------------- | ------------------------------------------------------------- |
| `RAPID_ANALYSIS_LOCATION`     | `local`                    | Deployment site name (set by the Rapid Analysis environment; note: **not** `RUBINTV_`-prefixed). |
| `RUBINTV_PATH_PREFIX`         | `/rubintv`                 | URL prefix everything is served under: API, WebSockets, sub-apps, SPA. Leading `/`, no trailing slash; `""` serves at the root. |
| `RUBINTV_MODELS_PATH`         | packaged copy              | Validated cameras/locations/channels config. Unset = the copy shipped in the `lsst.ts.rubintv.models` package; set to override with an on-disk file. |
| `RUBINTV_CACHE_DIR`           | `/scratch`                 | PVC dir for warm-start cache. Missing/unwritable dir (no PVC) disables the cache with one warning. |
| `RUBINTV_REDIS_URL`           | unset                      | Redis for detector/admin live updates. Unset = disabled.     |
| `RUBINTV_POLL_INTERVAL_SECONDS` | `1.0`                    | Current-day S3 poll cadence.                                  |
| `RUBINTV_RECENT_WINDOW_DAYS`  | `30`                       | Cold start scans this many recent observing days per camera before the full back-catalogue sweep. `0` = full sweep only. |
| `RUBINTV_METADATA_PRELOAD_DAYS` | `3`                      | Cold start pre-fetches `metadata.json` for this many recent dates per camera. `0` = on demand only. |
| `RUBINTV_RECONCILE_DRY_RUN`   | `false`                    | Log what reconciliation *would* remove from the index without removing it. Stale entries stay while set. |
| `RUBINTV_SPA_DIST`            | unset                      | Built SPA dir to serve. Unset (dev) = Vite serves the SPA.    |
| `RUBINTV_DDV_PATH`            | unset                      | Built DDV web app dir (Vite `dist`). Unset = `/ddv` not mounted. |
| `RUBINTV_EXP_CHECKER_ENABLED` | `false`                    | Mount the `exp_checker` sub-app at `/exp_checker`. In the image this also makes the entrypoint install it (see below). |
| `RUBINTV_EXP_CHECKER_MODULE`  | `lsst.ts.exp_checker`      | Import path of the exp_checker package (must expose `create_app()` or an `app`). |
| `RUBINTV_ALLOW_ADMIN_WILDCARD` | `false`                   | Let an `admin_for: ["*"]` wildcard grant admin to any authenticated user. Off so a pod booted with the wrong site grants admin to nobody. |
| `RUBINTV_WITNESS_DETECTOR_KEY` | `RUBINTV_CONTROL_WITNESS_DETECTOR` | Redis control key the admin "Witness Detector" box writes to. |
| `RUBINTV_RESET_HEAD_NODE_KEY` | `RUBINTV_CONTROL_RESET_HEAD_NODE` | Redis control key the admin "Reset Head Node" button writes to. |
| `RUBINTV_RESET_HEAD_NODE_VALUE` | `1`                      | Value written to that key to trigger the reset.               |
| `RUBINTV_LOG_LEVEL`           | `INFO`                     | Log level.                                                    |
| `RUBINTV_JSON_LOGS`           | `false` (dev), `true` (img)| JSON logs in production.                                      |

### Container entrypoint

The image's entrypoint, [scripts/start.sh](../scripts/start.sh), builds the
DDV web app and installs exp_checker at container start (so a pod restart
picks up new commits of their repos without an image rebuild), then launches
the app. These variables are read by that script, not by the app, and are
set in the deployment's pod spec. Sub-app failures are non-fatal: the app
comes up without the sub-app and logs why.

| Variable                | Default                                          | Purpose                                                       |
| ----------------------- | ------------------------------------------------ | ------------------------------------------------------------- |
| `DDV_DEPLOY_BRANCH`     | unset                                            | Branch of the DDV repo to build. **Unset = no DDV build**, so `/ddv` is not mounted. Names a branch of `DDV_REPO` (the web app), not of the analysis service. |
| `DDV_REPO`              | `https://github.com/ugyballoons/rubintv-ddv`     | Repository the DDV web app is cloned from. Its charting library, rubin-charts, is a git dependency in the app's lockfile and needs no setting here. |
| `DDV_BASE_HREF`         | `/rubintv/ddv/`                                  | URL path the DDV build is served under (baked into the build). Bookended by `/`; must match `RUBINTV_PATH_PREFIX` + `/ddv/`. |
| `DDV_CLIENT_WS_ADDRESS` | `rubintv/ws/ddv`                                 | WebSocket path baked into the DDV client, relative to the page's host; the client appends `/client`. Must match `RUBINTV_PATH_PREFIX` + `/ws/ddv`. |
| `DDV_BUILD_DIR`         | `/app/ddv-build`                                 | Scratch dir for the clone and build. `RUBINTV_DDV_PATH` (set in the image to `$DDV_BUILD_DIR/ddv/dist`) must point inside it. |
| `DDV_BUILD_TIMEOUT`     | `600`                                            | Seconds allowed for the clone + build before it is abandoned and the app starts without `/ddv`. |
| `EXP_CHECKER_REF`       | `main`                                           | Branch or tag of `lsst-sitcom/rubin_exp_checker` to install when `RUBINTV_EXP_CHECKER_ENABLED` is true. |
| `EXP_CHECKER_DIR`       | `/app/exp-checker-src`                           | Where that clone lands; its `python/` tree is put on `PYTHONPATH`. |
| `RUBINTV_HTTP_PORT`     | `8080`                                           | Port uvicorn listens on. Not `RUBINTV_PORT`: a Kubernetes Service named `rubintv` injects `RUBINTV_PORT=tcp://...` into every pod in the namespace, so that name is deliberately ignored. |

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
