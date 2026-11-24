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

uvicorn's own lines are plain text, not JSON: its startup and shutdown
messages, and the traceback of an error no handler caught. Its access log
is switched off; the app logs each request as `http.request` instead. So
when using `jq`, read raw lines and skip the ones that aren't JSON:

```bash
# Warnings and errors only
logs --since=1h | jq -cR 'fromjson? | select(.level == "warning" or .level == "error")'
# The loudest events: a quick way to see what a pod has been doing
logs --since=24h | jq -rR 'fromjson? | .event' | sort | uniq -c | sort -rn | head -20
# Requests that failed, or took over a second to answer
logs --since=1h | jq -cR 'fromjson? | select(.event == "http.request" and (.status >= 400 or .duration_ms > 1000))'
# Who sent the requests for one path, busiest first (a page or a script?)
logs --since=1h | jq -rR 'fromjson? | select(.event == "http.request" and (.path | endswith("/dates/2026-11-09"))) | [.forwarded_for // .client, .user_agent] | @tsv' | sort | uniq -c | sort -rn
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
| `trace` | Everything `debug` logs, plus uvicorn's own protocol tracing: each ASGI message, and websockets' line for every WebSocket frame and keepalive ping. Only for a problem in the WebSocket protocol itself. |
| `debug` | Per-frame and per-cycle detail, and routine requests (the kubelet's probes, the page's status poll); off by default. About a line a second on a quiet pod, much more while clients are connected and data arrives. See "Watching the data flow" in the operator guide. |
| `info` | Normal operation: startup steps, sweeps completing, clients connecting, each HTTP request. |
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
`poll.current.stalled` means a cycle began and hasn't ended a minute later,
so nothing new is being found although the last cycle to finish was fine;
the page says "Poll stalled". The events around it say what the cycle is
waiting on, and `poll.current.resumed` follows if it gets going again.

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

**A metadata table is empty or out of date.** Look for
`metadata.fetch.failed` (the file couldn't be read from S3, or isn't valid
JSON): with `cached: true` the page keeps the last good version, otherwise
its request is answered 503 and it says the metadata is unavailable. The
page loads metadata from `/metadata/{date}/changes`, so those `http.request`
lines show whether it asked, and how long the answer took. A slow answer
is a file being read from S3 for the first time: `metadata.fetch` gives its
size and how long the download and the parse each took, and
`metadata.compress` how long it then took to compress.

**Images don't load, or stop part way.** `proxy.miss` is an image
requested that isn't in the bucket; `proxy.stream.broken` is a download that
failed mid-way and couldn't be resumed (`proxy.stream.resume` is one that
was). The location and Channels cards show thumbnails: `thumbs.miss` and
`thumbs.unreadable` are their equivalents, and `thumbs.built` says how long
each took to fetch and shrink.

**Live updates lag or stop for some viewers.** `ws.client.slow` means a
browser couldn't keep up and messages to it were dropped;
`bus.subscriber.slow` means the same inside the app.
`ws.pump.fan_out.error` means a change failed to reach subscribers.
`ws.connect` and `ws.disconnect` give the connection count as `total`.

**Cluster status or controls are stale.** `redis.disabled` at startup
means no Redis is configured: those panels stay empty. `redis.unavailable`
means Redis is configured but isn't answering; the app keeps trying, and
`redis.connected` is logged when it gets through (the Status page's Redis
line says which holds now). `redis.reader.error` is a reader stopped by
something other than the connection. `redis.keyspace.enabled` after startup
means Redis restarted. `redis.config_set.failed` means control values are
read back by poll alone, up to 10 seconds late.

**The night report is missing parts.** `nightreport.fetch.skip` and the
`nr_text.*` events name the items that were skipped and why.

**DDV doesn't load or hangs.** `subapp.skip` and `subapp.mount.failed`
say why DDV wasn't served. With it served, `ddv.worker.connected` shows the
analysis worker is attached; `ddv.job.dropped` and `ddv.worker.lost_job`
are requests that were lost.

**Who did what.** Every admin action logs an `admin.*` event with the
`user` who made it. A refused one logs `admin.denied`; if every refusal
has `reason: no_user`, no login is reaching the app at all, which points at
the ingress rather than the admin list.

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
| `http.request` | info / debug | One HTTP request: `method`, `path`, `status`, `duration_ms` (to the response headers) and `bytes` (before compression, except for a whole metadata document from `/metadata/{date}/changes`, which is kept compressed), and who sent it: `client` (the peer: in the cluster, the ingress or an in-cluster caller), `forwarded_for` (the `X-Forwarded-For` header, `null` without one) and `user_agent`. The access log; uvicorn's own is switched off. `debug` for routine traffic that succeeded: the kubelet's probes (user agent `kube-probe/`) and `/api/health/status`, which each open camera page polls every 5 s. Anything else, and any response of 400 or above, is `info`. |

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
| `poll.current.cycle` | debug | Every cycle: `keys` listed and `cycle_seconds`. The cycle's own listings get no `poll.scan` line unless they changed something. |
| `poll.current.slow` | warning | A cycle took longer than 5 s (`cycle_seconds`); logged on entering the slow state. The page shows an "S3 slow" notice. |
| `poll.current.error` | error | A cycle failed, nearly always S3 unreachable; traceback attached. The page shows "S3 unreachable" and the poll retries every cycle. |
| `poll.current.stalled` | error | A cycle has been running for over 60 s (`running_seconds`) and hasn't finished, so today's index is no longer following the bucket; `last_poll_age_seconds` is how long since a cycle last succeeded. Logged once per stall, by a watchdog that looks every 10 s. The page shows "Poll stalled". |
| `poll.current.resumed` | info | A stalled cycle ended after `cycle_seconds`, and the poll carries on. |
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
| `poll.scan` | info / debug | One listing: `scope` (`day`, `recent`, `historical` or `on-demand`), `location`, `prefix`, `keys` and `slices_touched`. `info` when it changed the index, `debug` when it changed nothing, except a current-day (`day`) listing, which isn't logged when it changed nothing: there is one per camera every second, and `poll.current.cycle` sums them. |
| `poll.scan.error` | error | Listing a date opened on demand failed. |
| `poll.scan.empty_cached` | debug | A date opened on demand is already known to be empty, so it isn't listed again. |
| `poll.scan.location_error` | error | More than one location failed in the same sweep: the first failure gets the traceback, each other one gets this line. |
| `poll.metadata.warm.error` | error | Preloading a camera's metadata failed. Harmless: it loads when first viewed. |
| `metadata.preloaded` | info | After the recent window is listed, a camera's newest `dates` (up to `RUBINTV_METADATA_PRELOAD_DAYS`) have their metadata loaded, so the first table view is fast. |

### Index and reconciliation

| Event | Level | Meaning |
|---|---|---|
| `store.apply` | debug | A listing that changed the index: `events` seen and `changes` published. A listing that changed nothing isn't logged. |
| `store.reconcile.stale` | info | A re-listing no longer found some of a date's entries in the bucket; they're dropped (`entries`, with a summary per kind). Logged before the drop. |
| `store.reconcile.date_dropped` | info | Every entry for a date is gone, so the date leaves the calendar. |
| `store.reconcile.dry_run_enabled` | warning | `RUBINTV_RECONCILE_DRY_RUN` is on: entries deleted from the bucket are reported but stay listed. |

### Disk cache

The index is cached under `RUBINTV_CACHE_DIR` (the `/scratch` PVC by
default) so a restart is warm. A cache that can't be read or written, or a
volume that has stopped answering, also shows on the Status page ("Cache
unreadable", "Cache not writable", "Cache not responding").

| Event | Level | Meaning |
|---|---|---|
| `cache.loaded` | info | A warm start: `location_cameras` and `date_slices` read from the cache. |
| `cache.disabled` | info / warning | No cache, so every start is cold. A `warning` (with the `error`) means the directory couldn't be created; an `info` line follows it, and is the only line when no directory is configured. |
| `cache.load.skip` | warning | A cache file couldn't be read and was skipped; its dates come from the next listing. |
| `cache.written` | info | The cache was written after a full sweep. |
| `cache.write.failed` | warning | Writing one cache file failed (disk full, say); the app carries on. |
| `cache.write.stalled` | warning | The cache volume hasn't taken a write within `waited_seconds` (5 s for the `slices` a scan changed, 60 s for the `rewrite` after a full sweep; `what` says which). Scans stop waiting for it and carry on, so the pages stay live, but the cache falls behind until it finishes: a restart meanwhile would start from an older index. A volume that has hung, not failed, looks like this. |
| `cache.write.resumed` | info | A stalled write finished after `write_seconds`, and what queued behind it is being written. |
| `cache.write.error` | error | A cache write raised something other than a file error; traceback attached. The scan that asked for it carries on. |
| `cache.delete.failed` | warning | Removing one cache file failed. |
| `cache.cleared` | info | An admin flush deleted the cache's `files`. |
| `cache.clear.failed` | warning | One file couldn't be deleted during a flush. |

### Metadata

| Event | Level | Meaning |
|---|---|---|
| `metadata.fetch` | info / debug | A metadata file (`location`, `camera`, `date`) was read from S3 because it is new or was rewritten: its `rows` and `bytes`, the `requests` it took (a file over 4 MiB is read as 2 MiB ranges, several at once), and where the time went: `s3_ms` to download it, `parse_ms` to parse it and work out what changed. `info` when it took a second or more, `debug` otherwise. A file that hasn't changed costs one HEAD and logs nothing. |
| `metadata.compress` | info / debug | A metadata document was gzipped to be sent whole (`location`, `camera`, `date`): `bytes` in, `gzipped_bytes` out, `duration_ms`. Once per version of a file, the first time a page opens that night (or as it is preloaded); later pages are sent the kept copy and nothing is logged. `info` when it took a second or more. |
| `metadata.fetch.failed` | warning | A metadata file (`location`, `camera`, `date`) couldn't be read from S3 or parsed (`error`). With `cached: true` the last good version is served instead; otherwise the request is answered 503. Either way the next request tries again. |

### Image proxy

| Event | Level | Meaning |
|---|---|---|
| `proxy.miss` | info | A requested image wasn't found, by its expected name or by listing its `prefix`; answered 404. |
| `proxy.nr_plot.miss` | info | A requested night-report plot wasn't in the bucket; answered 404. |
| `proxy.stream.resume` | info | A download broke mid-way and was resumed from `offset`. |
| `proxy.stream.broken` | warning | A download broke mid-way and couldn't be resumed (too many retries, or the object changed since it began); the browser's download is cut short. |
| `thumbs.built` | info | A card's thumbnail was made from a frame (`location`, `camera`, `channel`, `date`, `seq`): `bytes` shrunk to `thumb_bytes`, taking `fetch_ms` to get from S3 and `shrink_ms` to resize. Once per frame; later requests are served from memory. |
| `thumbs.miss` | info | A thumbnail was asked for a frame that isn't in the bucket under `prefix`; answered 404. |
| `thumbs.unreadable` | warning | A frame (`key`) couldn't be decoded to make a thumbnail (`error`); the browser is redirected to the full-size frame. |

### WebSocket

| Event | Level | Meaning |
|---|---|---|
| `ws.connect` | info | A browser connected; `total` connections. |
| `ws.disconnect` | info | A browser disconnected; `total`, and the connection's `frames_sent` and `bytes_sent`. |
| `ws.client.slow` | warning | A browser's send queue was full, so a message to it was dropped. A slow or stalled client. |
| `ws.pump.fan_out.error` | error | A change couldn't be sent to subscribers; the pump carries on with the next. |
| `ws.frame.recv` | debug | A request from a browser: `subscribe` or `unsubscribe`. |
| `ws.frame.sent` | debug | A frame sent: `type`, `bytes`. A connection with nothing else to carry is sent a `heartbeat` every 20 s, which is how a page tells a quiet night from a dead socket. |
| `bus.subscriber.slow` | warning | An internal subscriber's queue was full, so a change was dropped for it. |

### Redis (cluster status and controls)

Redis is optional. Without it the cluster-status panels stay empty and
admin controls answer 503. Two readers use it, `readback` (control values)
and `detectors` (cluster status); each connects by itself and, when it
can't read, tries again after 1 s, doubling to 30 s, for as long as the app
runs. A long outage is therefore one `redis.unavailable` per reader, then
one `redis.connected`.

| Event | Level | Meaning |
|---|---|---|
| `redis.connected` | info | Every reader is reading Redis at `url` (any password masked as `***`): at startup, and each time after an outage. |
| `redis.disabled` | warning | No Redis configured (`RUBINTV_REDIS_URL` or `RA_REDIS_HOST`), or the URL isn't one (`error`). Nothing is retried. |
| `redis.unavailable` | warning | Reader `reader` can't reach Redis (`error`), at startup or later. It keeps trying; this is logged once, not at every try, and again only if the failure changes. |
| `redis.keyspace.enabled` | info | Keyspace notifications were off (`was` is what the server held) and have been turned on. Expected once at startup; later it means Redis restarted and lost the setting. |
| `redis.config_set.failed` | warning | Keyspace notifications couldn't be read or turned on (a managed Redis may forbid it), so control values are read back by the 10-second poll alone. Logged once. |
| `redis.reader.error` | error | A reader (`readback` or `detectors`) was stopped by something other than the connection, such as a reply it can't use; traceback attached. It is restarted like any other failure, and logged once. |
| `redis.readback.seed` | info | On each (re)connect, the configured controls' current `*_READBACK` values were read: `found` of `keys` had one, and `readbacks` maps each found key to its value. `found: 0` with controls set means the analysis side isn't writing readbacks. |
| `redis.readback.change` | info | The analysis side wrote a readback: `key` (a `*_READBACK`) now holds `value`. `via` is `event` (a keyspace notification) or `poll` (found by the 10-second read; the notification was lost). A control sent from the Admin page (`admin.control.set`) with no matching change after it was never acknowledged. |
| `redis.readback.gone` | info | A readback `key` the Admin page was showing no longer exists in Redis (deleted, expired, or flushed), so it is no longer shown. |
| `redis.detector.seed_failed` | warning | A detector status stream couldn't be read on connect (its key holds something other than a stream); it is left out until the next connect. |
| `redis.detector.bad_payload` | warning | A detector status entry wasn't a JSON object and was ignored. |
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
| `redis.reader.reconnect` | debug | A reader that failed tries again after `backoff_seconds`. |

### Admin actions

Each logs the authenticated `user` (`admin.denied`: whoever asked).

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
| `admin.denied` | warning | An admin request was refused (403). `reason` is `no_user` (no `X-Auth-Request-User` reached the app; `user` is `null`) or `not_admin` (signed in, but not on the site's `admin_for` list); also the `path`, and the `location` for a per-location control write. |

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
