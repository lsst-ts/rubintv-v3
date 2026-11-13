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
| `RUBINTV_PATH_PREFIX`         | `/rubintv`                 | URL prefix everything is served under: API, WebSockets, sub-apps, SPA. One image serves any prefix (the SPA is told its prefix as `index.html` is served), so set it per deployment, e.g. `/rubintv-dev` for summit dev. Normalised to a leading `/` and no trailing slash; `""` serves at the root. |
| `RUBINTV_INSTANCE_ENV`        | `prod`                     | `prod` or `dev`. `dev` shows the "Development instance" strip and points `{dev}` link templates at the `-dev` services. Set it on every dev deployment: nothing else tells a dev instance from prod (summit dev runs the same site on the same host). Local, CI and test sites are flagged by `RAPID_ANALYSIS_LOCATION` regardless. |
| `RUBINTV_MODELS_PATH`         | packaged copy              | Validated cameras/locations/channels config. Unset = the copy shipped in the `lsst.ts.rubintv.models` package; set to override with an on-disk file. |
| `S3_ENDPOINT_URL`             | unset                      | Fallback S3 endpoint for a location with no `endpoint_url` in the models YAML (**not** `RUBINTV_`-prefixed; the name the Phalanx chart sets). A location's own endpoint wins. |
| `RUBINTV_CACHE_DIR`           | `/scratch`                 | PVC dir for warm-start cache. Missing/unwritable dir (no PVC) disables the cache with one warning. |
| `RUBINTV_REDIS_URL`           | unset                      | Redis for detector/admin live updates. Unset = built from `RA_REDIS_HOST` if that is set, else disabled. |
| `RA_REDIS_HOST` / `RA_REDIS_PASSWORD` / `RA_REDIS_PORT` | unset / unset / `6379` | Rapid Analysis Redis as the Phalanx chart supplies it (**not** `RUBINTV_`-prefixed; password from a secret). Used only when `RUBINTV_REDIS_URL` is unset. |
| `RUBINTV_POLL_INTERVAL_SECONDS` | `1.0`                    | Current-day S3 poll cadence.                                  |
| `RUBINTV_RECENT_WINDOW_DAYS`  | `30`                       | Cold start scans this many recent observing days per camera before the full back-catalogue sweep. `0` = full sweep only. |
| `RUBINTV_RECENT_REFRESH_SECONDS` | `7200`                  | Re-scan the recent window this often between full sweeps (recent dates are mutable). `0` = only with the 12h full sweep. |
| `RUBINTV_RECENT_KNOWN_DAYS`   | `5`                        | Each recent pass also re-scans this many of a camera's newest dates *with data* outside the window (from its calendar), so rarely-observing cameras stay fresh. `0` = window only. |
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
| `RUBINTV_CONSDB_URL`          | unset                      | ConsDB query endpoint. In-cluster: `http://consdb-pq.consdb:8080/consdb/query` (no auth). **Unset = the observing guide is disabled** and hidden from the nav. |
| `RUBINTV_CONSDB_TOKEN_FILE`   | unset                      | File holding an RSP bearer token (`read:image` scope) for `RUBINTV_CONSDB_URL`. Only for an endpoint behind Gafaelfawr, i.e. local dev (see [Running the guide locally](#running-the-guide-locally)); in-cluster leave unset. A missing or empty file is logged and treated as no token. |
| `RUBINTV_GUIDE_INSTRUMENTS`   | `["lsstcam"]`              | JSON list of ConsDB instruments (`cdb_<name>` schemas) the guide builds blocks for. |
| `RUBINTV_GUIDE_SINCE`         | `2025-04-01`               | Earliest day_obs the guide sweeps.                            |
| `RUBINTV_GUIDE_POLL_INTERVAL_SECONDS` | `60`               | How often the guide asks ConsDB for exposures newer than its last. |
| `RUBINTV_GUIDE_MAX_GAP_MINUTES` | `15`                     | Longest pause between exposures of one program that keeps them in one block. |
| `RUBINTV_GUIDE_PAGE_SIZE`     | `50000`                    | Rows per ConsDB query during the sweep.                       |
| `RUBINTV_ZEPHYR_TOKEN_FILE`   | unset                      | Zephyr Scale API token file. Set = block descriptions refresh from the `BLOCK` project daily; unset = the snapshot bundled in the package is served. |
| `RUBINTV_ZEPHYR_URL`          | `https://api.zephyrscale.smartbear.com/v2` | Zephyr Scale Cloud API root.                  |
| `RUBINTV_ZEPHYR_PROJECT_KEY`  | `BLOCK`                    | Jira project holding the BLOCK-T test cases (Zephyr) and the plain BLOCK issues (Jira). |
| `RUBINTV_JIRA_TOKEN_FILE`     | unset                      | Jira credential file: base64 of `email:api-token`, the form of nightlydigest's `jira-api-token` secret, which deployments copy. Set = plain `BLOCK-123` programs are named by their Jira issue summaries, refreshed daily. |
| `RUBINTV_JIRA_URL`            | `https://rubinobs.atlassian.net` | Jira Cloud site.                                         |
| `RUBINTV_BLOCK_NAMES_REFRESH_SECONDS` | `86400`            | Zephyr and Jira refresh cadence.                              |
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
| `DDV_BASE_HREF`         | `RUBINTV_PATH_PREFIX` + `/ddv/`                  | URL path the DDV build is served under (baked into the build). Bookended by `/`. The default follows the app's prefix; override only if DDV is served elsewhere. |
| `DDV_CLIENT_WS_ADDRESS` | `RUBINTV_PATH_PREFIX` + `/ws/ddv`, no leading `/` | WebSocket path baked into the DDV client, relative to the page's host; the client appends `/client`. The default follows the app's prefix. |
| `DDV_BUILD_DIR`         | `/app/ddv-build`                                 | Scratch dir for the clone and build. `RUBINTV_DDV_PATH` (set in the image to `$DDV_BUILD_DIR/ddv/dist`) must point inside it. |
| `DDV_BUILD_TIMEOUT`     | `600`                                            | Seconds allowed for the clone + build before it is abandoned and the app starts without `/ddv`. |
| `EXP_CHECKER_REF`       | `main`                                           | Branch or tag of `lsst-sitcom/rubin_exp_checker` to install when `RUBINTV_EXP_CHECKER_ENABLED` is true. |
| `EXP_CHECKER_DIR`       | `/app/exp-checker-src`                           | Where that clone lands; its `python/` tree is put on `PYTHONPATH`. |
| `RUBINTV_HTTP_PORT`     | `8080`                                           | Port uvicorn listens on. Not `RUBINTV_PORT`: a Kubernetes Service named `rubintv` injects `RUBINTV_PORT=tcp://...` into every pod in the namespace, so that name is deliberately ignored. |

## Observing guide (ConsDB)

`/guide` is a port of the RubinTV Guide timeline: every science program's
run of exposures drawn as a block per observing night. It needs
`RUBINTV_CONSDB_URL`. On startup the app sweeps `cdb_<instrument>.exposure`
from `RUBINTV_GUIDE_SINCE` in `RUBINTV_GUIDE_PAGE_SIZE` pages (the page
shows "Sweeping ConsDB…" until it catches up), then polls for newer
exposures every `RUBINTV_GUIDE_POLL_INTERVAL_SECONDS`. The grouped blocks
are persisted under `RUBINTV_CACHE_DIR/guide/` so a restart is warm (a
cache in an older release's format is skipped, logging
`guide.cache.skipped`, and swept afresh; a directory that can't be created
there, such as the default `/scratch` on a pod without the PVC, means no
cache, after a single `guide.cache.disabled` warning); a ConsDB outage keeps
serving the last blocks with a warning pill.

The ConsDB pods accept in-cluster traffic from any namespace, so the
in-cluster URL needs no secret. The block descriptions come from two
places, because science programs are recorded under two kinds of key in
the `BLOCK` Jira project. `BLOCK-T123` is a Zephyr Scale test case, named
from Zephyr; without a Zephyr token the bundled snapshot is used.
Zephyr's test-case list leaves some test cases out (archived ones, it
seems), so the refresh also asks for each missing `BLOCK-T` key on its
own, about 60 extra requests a day. `BLOCK-123` is a Jira issue, named by
its summary from Jira's search API with an Atlassian API token; without
one, the ones observed so far are named from a temporary list in
[blocknames.py](../python/lsst/ts/rubintv/data/blocknames.py)
(`INTERIM_ISSUE_NAMES`) that the first Jira refresh overrides. The two
are different blocks despite the similar numbers (`BLOCK-365` is the
generic survey-imaging block, `BLOCK-T365` a field survey), so neither is
given the other's name.

A few programs belong with a test case recorded under another key, and the
guide draws them with it: mistyped ones (`BLOCK-487` for `BLOCK-T487`, a
fixed list, `KNOWN_TYPOS` in
[blocknames.py](../python/lsst/ts/rubintv/data/blocknames.py)) and Zephyr
test executions recorded as the program (`E13304`, `BLOCK-E8024`). With a
Zephyr token, the service checks the guide's programs every minute for
executions it hasn't seen and looks each up in Zephyr once, logging
`blocknames.executions.resolved` (or `blocknames.executions.failed`, to be
retried on the next check).

The tokens are read once at startup, so restart the pod after replacing a
secret. The first refresh runs straight away and logs
`blocknames.zephyr.connected` or `blocknames.jira.connected` for each
token that works, or `blocknames.refresh.failed` (with `source` and, for
example, `Zephyr HTTP 401`) for one that doesn't; one failing source
doesn't stop the other. The lines name the Jira site and the account the
token acts as (for Zephyr also when it expires). They also give
`token_sha256`, the first 12 hex digits of the token's SHA-256, so you can
confirm the pod loaded the new secret:
`printf %s "$TOKEN" | sha256sum | cut -c1-12`.
`blocknames.zephyr.disabled` or `blocknames.jira.disabled` means that
source has no token at all. `blocknames.jira.credential_unrecognised`
means the Jira file doesn't hold base64 of `email:api-token` (a bare API
token, say), so Jira will refuse it.

### Guide log events

Everything the guide logs; `grep -F guide.` or `grep -F blocknames.` finds
it in the pod's log.

| Event | Level | Meaning |
|---|---|---|
| `guide.enabled` | info | The guide is on: the `consdb_url` and the `instruments` it sweeps. |
| `guide.disabled` | info | No `RUBINTV_CONSDB_URL`, so no guide. |
| `guide.cache.loaded` | info | A warm start for an `instrument`: the `blocks` and `last_exposure_id` read from the cache. |
| `guide.cache.skipped` | info | The cache is from an older release or another `RUBINTV_GUIDE_SINCE`, so the instrument is swept afresh. |
| `guide.cache.load_failed` | error | The cache file couldn't be read (traceback attached); a cold start. |
| `guide.cache.disabled` | warning | The cache directory couldn't be created (`dir`, `error`), so the guide runs without a cache. Logged once. |
| `guide.cache.write_failed` | warning | Writing the cache failed (`path`, `error`); retried after the next poll. |
| `guide.page` | debug | A page of `rows` read from ConsDB. |
| `guide.swept` | info | An `instrument`'s first sweep caught up (`blocks`, `exposures`) and "Sweeping ConsDB…" clears. |
| `guide.consdb.error` | warning | A ConsDB query failed (`error`, e.g. `ConsDB HTTP 401`). The page shows it, keeps serving the last blocks, and the next poll retries. |
| `guide.poll.error` | error | A poll failed unexpectedly (traceback attached); retried at the next interval. |
| `token.unreadable` | warning | A token file (`path`) couldn't be read, so what it gates runs without it: the ConsDB token, the Zephyr token or the Jira credential. |
| `blocknames.zephyr.connected` | info | A Zephyr refresh worked: `count` test cases, and the token's identity. |
| `blocknames.jira.connected` | info | A Jira refresh worked: `count` issues, and the account. |
| `blocknames.zephyr.disabled` | info | No Zephyr token: `BLOCK-T` names come from the bundled snapshot. |
| `blocknames.jira.disabled` | info | No Jira credential: plain `BLOCK-n` names come from `INTERIM_ISSUE_NAMES`. |
| `blocknames.jira.credential_unrecognised` | warning | The Jira credential isn't base64 of `email:api-token`, so Jira will refuse it. |
| `blocknames.refresh.failed` | warning | One source's refresh failed (`source`, `error`). Its names stay as they were; the other source carries on. |
| `blocknames.refresh.empty` | warning | A source answered with no names. Treated as a failure, so the names aren't blanked. |
| `blocknames.refresh.error` | error | A refresh failed unexpectedly (traceback attached); retried at the next refresh. |
| `blocknames.executions.resolved` | info | Test executions newly linked to the test case each ran (`count`, `total`). |
| `blocknames.executions.failed` | warning | Looking up a test execution (`key`) failed; it and the rest wait for the next check, a minute later. |
| `blocknames.executions.error` | error | A round of execution lookups failed unexpectedly (traceback attached); retried a minute later. |

### Running the guide locally

The in-cluster URL only resolves inside Kubernetes. On your own machine,
point the app at the ConsDB endpoint a Rubin Science Platform (RSP)
publishes instead. That endpoint sits behind Gafaelfawr, so it needs a
token:

1. **Get a token.** On the USDF dev RSP, open
   <https://usdf-rsp-dev.slac.stanford.edu/auth/tokens/> and create a token
   with the `read:image` scope, which is the scope the ConsDB ingress
   requires. Save it to a file only you can read, e.g. `~/.lsst/rsp_token`
   with `chmod 600`. A token only works on the RSP that issued it: a
   usdf-rsp-dev token gets a 401 from the production RSP
   (`usdf-rsp.slac.stanford.edu`), and the reverse.

2. **Check the token** before starting the app. This prints the latest
   LSSTCam day_obs the endpoint holds:

   ```sh
   curl -sS -X POST https://usdf-rsp-dev.slac.stanford.edu/consdb/query \
     -H "Authorization: Bearer $(cat ~/.lsst/rsp_token)" \
     -H "Content-Type: application/json" \
     -d '{"query": "SELECT max(day_obs) FROM cdb_lsstcam.exposure"}'
   ```

   A good token returns `{"columns":["max"],"data":[[20261101]]}` or similar.
   A 401 means no token, or a token from a different RSP; a 403 means the
   token lacks the `read:image` scope.

3. **Configure the app.** Put these in `.env` in the directory you start the
   backend from (the repo root; copy [.env.example](../.env.example)), or
   export them in that shell:

   ```sh
   RUBINTV_CONSDB_URL=https://usdf-rsp-dev.slac.stanford.edu/consdb/query
   RUBINTV_CONSDB_TOKEN_FILE=~/.lsst/rsp_token
   RUBINTV_CACHE_DIR=./cache
   ```

   The app expands the `~` itself, so it works in `.env` too.
   `RUBINTV_CACHE_DIR` is optional but keeps the swept blocks (under
   `cache/guide/`) between restarts.

4. **Start the backend** as usual (see [Running](#running)); the startup log
   should not show `guide.disabled`. The first start with an empty cache
   sweeps every exposure since `RUBINTV_GUIDE_SINCE`, a few hundred thousand
   rows for LSSTCam, and `/guide` shows "Sweeping ConsDB…" with a running
   count until it catches up. Later starts load the cache and fetch only
   newer exposures. For a quicker first sweep, set `RUBINTV_GUIDE_SINCE` to
   a recent date.

No VPN or sshuttle tunnel is needed: the RSP is public HTTPS, unlike the
USDF S3 endpoints. The dev RSP's ConsDB is a replica, so it can lag
production; the `max(day_obs)` query above shows how far it goes. To read
production ConsDB instead, use a token from
<https://usdf-rsp.slac.stanford.edu/auth/tokens/> and
`https://usdf-rsp.slac.stanford.edu/consdb/query`.

Block descriptions need none of this, because the bundled snapshot is
served when `RUBINTV_ZEPHYR_TOKEN_FILE` is unset. To refresh them from
Zephyr locally, set it to a file holding a Zephyr Scale API token (from your
Jira profile: Zephyr API Access Tokens). To name the plain `BLOCK-123`
programs too, set `RUBINTV_JIRA_TOKEN_FILE` to a file holding base64 of
your Atlassian email address and an API token (from
<https://id.atlassian.com/manage-profile/security/api-tokens>), joined by
a colon. With them in `$EMAIL` and `$TOKEN`:

```bash
printf %s "$EMAIL:$TOKEN" | base64 > ~/.lsst/jira_credential
chmod 600 ~/.lsst/jira_credential
```

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

If neither `RUBINTV_REDIS_URL` nor `RA_REDIS_HOST` is set, or the server is unreachable, detector
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
`X-Auth-Request-User` header that Gafaelfawr's ingress sets from the login
session. A request without that header is never an admin. The app is
embargoed and not publicly reachable; there is no other auth layer.

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
response). The [log guide](log-guide.md) covers reading them in the cluster,
what to look for when something is wrong, and what every event means.

### Watching the data flow

At `DEBUG` the logs carry the timing and size of every hop, so a local
session can be measured without a profiler:

| Event | Fields | What it measures |
|---|---|---|
| `http.request` | `method`, `path`, `status`, `duration_ms`, `bytes`, `client`, `forwarded_for`, `user_agent` | every REST/proxy request: time to response headers, uncompressed body size (`null` for a chunked stream) |
| `ws.frame.sent` | `type`, `bytes`, `camera`, `date`, `seq` | every WebSocket frame put on the wire |
| `ws.disconnect` | `frames_sent`, `bytes_sent` | a connection's lifetime totals |
| `poll.current.cycle` | `cycle_seconds`, `keys` | each 1s current-day cycle: wall time and keys listed |
| `poll.scan` | `scope`, `prefix`, `keys`, `slices_touched` | each S3 listing; `info` only when it changed the index, `debug` when it was a silent re-listing, except the current-day poll's silent ones, which `poll.current.cycle` sums |
| `store.apply` | `events`, `changes` | how much of a listing was actually new; logged only when something was |

Capture a session and summarise it:

```bash
RUBINTV_JSON_LOGS=1 RUBINTV_LOG_LEVEL=DEBUG uv run uvicorn lsst.ts.rubintv.main:app \
  2>&1 | tee /tmp/rubintv.jsonl
# ... click around the app ...
python scripts/flow_summary.py /tmp/rubintv.jsonl
```

`flow_summary.py` prints p50/p95 request times and bytes per endpoint,
WebSocket bytes per message type, poll cycle times, and the ratio of events
seen to changes published. Ad hoc: `jq -c 'select(.event=="ws.frame.sent")'`.
On the browser side, `localStorage.setItem("rubintv:debug","1")` turns on
the SPA's `[rubintv:*]` console logging, and DevTools' Network tab shows the
same requests and WebSocket frames from the client's end.

## Migration / cutover

Run old and new side by side against the same buckets. Diff the API/table
output (`/api/.../dates/{date}`, `/calendar`) for a set of dates and cameras
before cutover; investigate any divergence with the producer team since S3
is authoritative.

## API docs

Interactive OpenAPI docs at `/docs`; the schema is at `/openapi.json` (also
committed at the repo root and consumed by the frontend type generator,
`cd web && npm run gen:api`).
