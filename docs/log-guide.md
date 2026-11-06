# RubinTV log guide

What RubinTV writes to its log, and what to look for when something seems
wrong. For settings, health endpoints and deployment, see the
[operator guide](operator-guide.md).

Every line the app logs is an *event*: a dotted name such as
`poll.current.error` plus fields. The names are unique, so searching for one,
or for a prefix such as `poll.current`, finds exactly those lines. The
[catalogue](#catalogue) at the end lists every event; a test
(`tests/test_log_guide.py`) fails when the code logs an event this guide
doesn't list, or when the catalogue lists one the code no longer logs.

## Getting at the logs

In the cluster the app runs in the `rubintv-frontend` Deployment. Its pod
has an init container, so name the app's container:

```bash
logs() { kubectl -n rubintv logs deploy/rubintv-frontend -c frontend "$@"; }

logs --since=1h | grep -F poll.current      # one event, or one area
logs -f | grep -F ws.                       # follow live
logs --previous                             # the run before the last restart
```

**Format.** The image logs JSON (`RUBINTV_JSON_LOGS=true`), one object per
line, with `event`, `level` and `timestamp` (ISO 8601, UTC) plus the
event's own fields. Lines logged while serving an HTTP request also carry
its `request_id`, the same value returned in the response's `X-Request-ID`
header. An `error` line from a caught exception carries the traceback in
`exception`.

uvicorn's own lines are plain text, not JSON: its startup messages and an
access-log line per request (`"GET /rubintv/api/... HTTP/1.1" 200`). So
when using `jq`, read raw lines and skip the ones that aren't JSON:

```bash
# Warnings and errors only
logs --since=1h | jq -cR 'fromjson? | select(.level == "warning" or .level == "error")'
# The loudest events: a quick way to see what a pod has been doing
logs --since=24h | jq -rR 'fromjson? | .event' | sort | uniq -c | sort -rn | head -20
# Everything logged for one request
logs --since=1h | jq -cR 'fromjson? | select(.request_id == "<id>")'
# Each error with its traceback
logs --since=1h | jq -rR 'fromjson? | select(.exception) | .timestamp, .event, .exception'
```

**Locally** the app logs in colour, one event per line, with the fields
after the name, e.g.
`2026-11-05T12:55:50.123456Z [warning  ] cache.disabled  dir=/scratch/v3 error=...`.
Set `RUBINTV_JSON_LOGS=1` to get the cluster's format.

**Levels.** `RUBINTV_LOG_LEVEL` sets the threshold, `INFO` by default.

| Level | Meaning |
|---|---|
| `debug` | Per-request, per-frame and per-cycle detail; off by default and too much for a busy pod. See "Watching the data flow" in the operator guide. |
| `info` | Normal operation: startup steps, sweeps completing, clients connecting. |
| `warning` | Something degraded or was refused; the app carries on. Worth reading. |
| `error` | An operation failed; usually with a traceback. The loop or request that failed is retried or abandoned, never the whole app. |

## When something looks wrong

**The pod restarts or never becomes ready.** Startup logs `startup.begin`,
`s3.pool.ready`, `cache.loaded` (or `cache.disabled`), then
`startup.complete`; readiness only flips at `poll.ready`, after the first
current-day poll. Read `logs --previous` for the last event before a crash.
`config.admin_wildcard_disabled` and `logging.level.unknown` point at a
misconfigured setting.

**No new images appear, or the page says S3 is unreachable.**
`poll.current.error` (with a traceback) means the current-day poll can't
list the bucket; it retries every cycle. `poll.current.slow` means a cycle
took over 5 s, an early sign of a degrading link. When all is well,
`poll.current.heartbeat` appears about once a minute with the keys listed
and the cycle time; if it stops appearing, the poll loop isn't running.

**Past dates are missing, or the "loading history" notice stays up.** The
history sweep logs `poll.recent.start` / `poll.recent.done` (the last
`RUBINTV_RECENT_WINDOW_DAYS`), then `poll.historical.start` /
`poll.historical.done`, then `poll.historical.idle` once, when the notice
clears. `poll.historical.error` means the sweep failed and will retry in a
minute. A date opened on demand logs `poll.scan.error` if its listing
fails.

**Dates or images disappeared.** `store.reconcile.stale` and
`store.reconcile.date_dropped` record entries and whole dates dropped
because a re-listing no longer found them in the bucket.
`admin.flush_historical` records an admin clearing the cache and index.

**A metadata table is empty or incomplete.** Look for
`metadata.fetch.failed` (the file couldn't be read from S3),
`ws.metadata.stream.error` and `ws.metadata.delta.error`.

**Images don't load, or stop part way.** `proxy.miss` is an image
requested that isn't in the bucket; `proxy.stream.broken` is a download that
failed mid-way and couldn't be resumed (`proxy.stream.resume` is one that
was).

**Live updates lag or stop for some viewers.** `ws.client.slow` means a
browser couldn't keep up and messages to it were dropped;
`bus.subscriber.slow` means the same inside the app.
`ws.pump.fan_out.error` means a change failed to reach subscribers.
`ws.connect` and `ws.disconnect` give the connection count as `total`.

**Cluster status or controls are stale.** `redis.disabled` or
`redis.unavailable` at startup means no Redis: those panels stay empty.
`redis.reader.error` followed by `redis.reader.reconnect` is a reader that
died and is being restarted. `redis.config_set.failed` means control values
can't be read back live.

**The night report is missing parts.** `nightreport.fetch.skip` and the
`nr_text.*` events name the items that were skipped and why.

**DDV doesn't load or hangs.** `subapp.skip` and `subapp.mount.failed`
say why DDV wasn't served. With it served, `ddv.worker.connected` shows the
analysis worker is attached; `ddv.job.dropped` and `ddv.worker.lost_job`
are requests that were lost.

**Who did what.** Every admin action logs an `admin.*` event with the
`user` who made it.

## Catalogue

Grouped by area. Where an event is logged at two levels, both are given.

### Startup, shutdown and configuration

| Event | Level | Meaning |
|---|---|---|
| `startup.begin` | info | The app is starting; `site` and `version`. |
| `startup.complete` | info | Startup finished; the polls are running. |
| `shutdown.begin` | info | The app is shutting down. |
| `shutdown.complete` | info | Shutdown finished; the cache was written. |
| `config.admin_wildcard_disabled` | warning | The site's `admin_for` contains `*` but `RUBINTV_ALLOW_ADMIN_WILDCARD` isn't set, so the wildcard is ignored. Usually a pod started with the wrong `RUBINTV_SITE`. |
| `logging.level.unknown` | warning | `RUBINTV_LOG_LEVEL` isn't a level name; logging at `INFO` instead. |
| `http.request` | debug | One HTTP request: `method`, `path`, `status`, `duration_ms` (to the response headers) and `bytes`. |

### S3 clients

| Event | Level | Meaning |
|---|---|---|
| `s3.client.created` | info | An S3 client for a `location` and `role` (`default` or `poller`) and its `endpoint`. |
| `s3.pool.ready` | info | Every location's clients are ready. |
| `s3.client.closed` | info | A client closed at shutdown. |

### Current-day polling

The current day's prefixes are listed every `RUBINTV_POLL_INTERVAL_SECONDS`
(1 s by default).

| Event | Level | Meaning |
|---|---|---|
| `poll.current.start` | info | The current-day poll started; the `day` and the `prefixes` it lists. |
| `poll.current.heartbeat` | info | About once a minute while polling: `keys_last_cycle` and `cycle_seconds`. Its absence means the loop isn't running. |
| `poll.current.cycle` | debug | Every cycle: `keys` listed and `cycle_seconds`. |
| `poll.current.slow` | warning | A cycle took longer than 5 s (`cycle_seconds`); logged on entering the slow state. The page shows an "S3 slow" notice. |
| `poll.current.error` | error | A cycle failed, nearly always S3 unreachable; traceback attached. The page shows "S3 unreachable" and the poll retries every cycle. |
| `poll.ready` | info | The first current-day poll finished; the pod reports ready from here. |
| `day.rollover` | info | The observing day changed at 12:00 UTC (`from_`, `to`). |

### History

Startup lists the last `RUBINTV_RECENT_WINDOW_DAYS` first, so recent dates
are browsable within seconds, then sweeps the whole bucket. The full sweep
repeats every 12 hours, and the recent window is re-listed every
`RUBINTV_RECENT_REFRESH_SECONDS` (2 hours) in between.

| Event | Level | Meaning |
|---|---|---|
| `poll.recent.start` | info | Listing the recent window: `cameras`, `days`. |
| `poll.recent.plan` | debug | How many of the window's days are already known. |
| `poll.recent.done` | info | The recent window is listed; `events` found. |
| `poll.recent.refresh` | info | A periodic re-listing of the recent window finished. |
| `poll.recent.error` | error | A periodic re-listing failed; retried at the next one. |
| `poll.historical.start` | info | The full sweep started. |
| `poll.historical.done` | info | The full sweep finished; `events` found. |
| `poll.historical.idle` | info | History is complete for the first time since startup or a rescan; the "loading history" notice clears. |
| `poll.historical.error` | error | The sweep failed; traceback attached. Retried after 60 s, and the loading notice stays up meanwhile. |
| `poll.historical.rescan` | info | A rescan was requested (by an admin flush) and starts now. |
| `poll.scan` | info / debug | One listing: `scope` (`day`, `recent`, `historical` or `on-demand`), `location`, `prefix`, `keys` and `slices_touched`. `info` when it changed the index, `debug` when it changed nothing. |
| `poll.scan.error` | error | Listing a date opened on demand failed. |
| `poll.scan.empty_cached` | debug | A date opened on demand is already known to be empty, so it isn't listed again. |
| `poll.scan.location_error` | error | More than one location failed in the same sweep: the first failure gets the traceback, each other one gets this line. |
| `poll.metadata.warm.error` | error | Preloading a camera's metadata failed. Harmless: it loads when first viewed. |
| `metadata.preloaded` | info | After the recent window is listed, a camera's newest `dates` (up to `RUBINTV_METADATA_PRELOAD_DAYS`) have their metadata loaded, so the first table view is fast. |

### Index and reconciliation

| Event | Level | Meaning |
|---|---|---|
| `store.apply` | debug | A listing applied to the index: `events` seen and `changes` made. Many events and no changes is a re-listing that found nothing new. |
| `store.reconcile.stale` | info | A re-listing no longer found some of a date's entries in the bucket; they're dropped (`entries`, with a summary per kind). Logged before the drop. |
| `store.reconcile.date_dropped` | info | Every entry for a date is gone, so the date leaves the calendar. |
| `store.reconcile.dry_run_enabled` | warning | `RUBINTV_RECONCILE_DRY_RUN` is on: entries deleted from the bucket are reported but stay listed. |

### Disk cache

The index is cached under `RUBINTV_CACHE_DIR` (the `/scratch` PVC by
default) so a restart is warm.

| Event | Level | Meaning |
|---|---|---|
| `cache.loaded` | info | A warm start: `location_cameras` and `date_slices` read from the cache. |
| `cache.disabled` | info / warning | No cache, so every start is cold. A `warning` (with the `error`) means the directory couldn't be created; an `info` line follows it, and is the only line when no directory is configured. |
| `cache.load.skip` | warning | A cache file couldn't be read and was skipped; its dates come from the next listing. |
| `cache.written` | info | The cache was written after a full sweep. |
| `cache.write.failed` | warning | Writing one cache file failed (disk full, say); the app carries on. |
| `cache.delete.failed` | warning | Removing one cache file failed. |
| `cache.cleared` | info | An admin flush deleted the cache's `files`. |
| `cache.clear.failed` | warning | One file couldn't be deleted during a flush. |

### Metadata

| Event | Level | Meaning |
|---|---|---|
| `metadata.fetch.failed` | warning | A metadata file (`location`, `camera`, `date`) couldn't be read from S3 or parsed; the table stays empty until the next fetch or WebSocket update fills it. |

### Image proxy

| Event | Level | Meaning |
|---|---|---|
| `proxy.miss` | info | A requested image wasn't found, by its expected name or by listing its `prefix`; answered 404. |
| `proxy.nr_plot.miss` | info | A requested night-report plot wasn't in the bucket; answered 404. |
| `proxy.stream.resume` | info | A download broke mid-way and was resumed from `offset`. |
| `proxy.stream.broken` | warning | A download broke mid-way and couldn't be resumed (too many retries, or the object changed since it began); the browser's download is cut short. |

### WebSocket

| Event | Level | Meaning |
|---|---|---|
| `ws.connect` | info | A browser connected; `total` connections. |
| `ws.disconnect` | info | A browser disconnected; `total`, and the connection's `frames_sent` and `bytes_sent`. |
| `ws.client.slow` | warning | A browser's send queue was full, so a message to it was dropped. A slow or stalled client. |
| `ws.pump.fan_out.error` | error | A change couldn't be sent to subscribers; the pump carries on with the next. |
| `ws.frame.recv` | debug | A request from a browser: `subscribe`, `unsubscribe` or `refresh`. |
| `ws.frame.sent` | debug | A frame sent: `type`, `bytes`. |
| `ws.metadata.stream.start` | debug | Streaming a date's metadata to a browser. |
| `ws.metadata.stream.skip` | debug | A camera subscription without a date, so no metadata to stream. |
| `ws.metadata.chunk.enqueued` | debug | One chunk of a metadata stream queued. |
| `ws.metadata.complete` | debug | A metadata stream finished: `chunks`, `rows`. |
| `ws.metadata.stream.error` | error | A metadata stream failed; the connection stays up. |
| `ws.metadata.delta` | debug | A browser that already had a date's metadata was sent only what changed. |
| `ws.metadata.delta.error` | error | Working out the changes failed; the full stream is sent instead. |
| `bus.subscriber.slow` | warning | An internal subscriber's queue was full, so a change was dropped for it. |

### Redis (cluster status and controls)

Redis is optional. Without it the cluster-status panels stay empty and
admin controls answer 503.

| Event | Level | Meaning |
|---|---|---|
| `redis.connected` | info | Connected to Redis at `url`. |
| `redis.disabled` | warning | No Redis configured (`RUBINTV_REDIS_URL` or `RA_REDIS_HOST`). |
| `redis.unavailable` | warning | Redis is configured but didn't answer at startup; carrying on without it. |
| `redis.config_set.failed` | warning | Keyspace notifications couldn't be turned on (a managed Redis may forbid it), so control values aren't read back live. |
| `redis.reader.error` | error | A reader (`readback` or `detectors`) failed; traceback attached. |
| `redis.reader.reconnect` | warning | That reader restarts after `backoff_seconds`. |
| `redis.detector.seed_failed` | warning | Reading a detector status stream's latest entry at startup failed; it fills in with the next live entry. |
| `redis.detector.bad_payload` | warning | A detector status entry wasn't valid JSON and was ignored. |
| `redis.set` | info | A control value was written (`key`). |
| `redis.flushdb` | warning | The whole Redis database was flushed by an admin. |
| `redis.detector.seed_start` | debug | Seeding detector status from the latest stream entries. Set `DEBUG` to trace cluster status end to end. |
| `redis.detector.seed_entry` | debug | One stream's latest entry read. |
| `redis.detector.seed_empty` | debug | A stream had no entries. |
| `redis.detector.seed_publish` | debug | Seeded status published to browsers. |
| `redis.detector.seed_nothing` | debug | Nothing to seed. |
| `redis.detector.live_entry` | debug | A new entry arrived on a stream. |
| `redis.detector.live_publish` | debug | Updated status published to browsers. |
| `redis.detector.apply` | debug | An entry applied to a detector set (`workers`). |

### Admin actions

Each logs the authenticated `user`.

| Event | Level | Meaning |
|---|---|---|
| `admin.control.set` | info | A site-wide control `key` was set. |
| `admin.control.set_local` | info | A location's control `key` was set. |
| `admin.control.rejected` | warning | A control write for a `key` that isn't allowed was refused (400). |
| `admin.reset_head_node` | warning | A head-node reset was requested. |
| `admin.restart_workers` | warning | A detector `set`'s workers were asked to restart. |
| `admin.flush_historical.request` | warning | A flush of the cache and index was requested. |
| `admin.flush_historical` | warning | The flush happened (`slices_removed`); a full rescan follows. |
| `admin.flush_redis.request` | warning | A flush of the whole Redis database was requested. |

### Night report

| Event | Level | Meaning |
|---|---|---|
| `nightreport.fetch.skip` | warning | A night-report text file (`key`) couldn't be read or parsed and was left out. |
| `nr_text.invalid_item` | warning | A text item failed validation and was left out; `errors` says why. |
| `nr_text.shape_date_mismatch` | warning | A report's file is in the old (object) or new (list) format but its date says it should be the other; it's read anyway. |
| `nr_text.skip_old_item` | warning | An old-format item of a kind that can't be converted was left out. |
| `nr_text.unsupported_top_level` | warning | A report file is neither a list nor an object (`kind`), so it has no items. |

### Frontend and sub-apps

| Event | Level | Meaning |
|---|---|---|
| `spa.mounted` | info | The web app is served from `dir` under `prefix`, as instance `env`. |
| `spa.skip` | info | No web-app build; the API is served alone. Normal in local development. |
| `spa.index_without_head` | warning | The build's `index.html` has no `</head>`, so the deployment settings couldn't be added and the web app won't route. A broken build. |
| `subapp.mounted` | info | A sub-app (`ddv` or `exp_checker`) is served at `path`. |
| `subapp.skip` | info / warning | A sub-app isn't served: `info` when it's disabled or not built (normal locally), `warning` when the DDV build is incomplete. |
| `subapp.mount.failed` | warning | A sub-app failed to mount (`error`); the rest of the app is unaffected. |

### DDV broker

DDV's browser clients send jobs that the broker relays to the analysis
worker pod.

| Event | Level | Meaning |
|---|---|---|
| `ddv.worker.connected` | info | A worker connected. Without one, DDV jobs queue. |
| `ddv.worker.disconnected` | info | A worker disconnected. |
| `ddv.worker.lost_job` | warning | A worker disconnected mid-job; that job is lost. |
| `ddv.worker.send_failed` | warning | A job couldn't be sent to a worker, which has gone. |
| `ddv.client.connected` | info | A browser connected. |
| `ddv.client.disconnected` | info | A browser disconnected; its queued jobs are dropped. |
| `ddv.client.send_failed` | info | A result couldn't be sent because the browser had left. |
| `ddv.job.queued` | info | No worker was free, so a job was queued (`depth`). |
| `ddv.job.started` | info | A job was sent to a worker. |
| `ddv.job.unclaimed` | info | A result arrived for a browser that had gone. |
| `ddv.job.dropped` | warning | The queue was full (512 jobs), so the oldest job was dropped. |
</content>
</invoke>
