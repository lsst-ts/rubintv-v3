# Review guide: DM-55435 (the V3 rebuild, one PR)

This PR lands the whole rebuild — 349 commits on `tickets/DM-55435` —
as a single reviewed merge into `develop`. This guide groups those
commits so the branch can be read theme-by-theme instead of
chronologically. Groups are a reading order, not merge units: many
later commits revisit files introduced earlier, so the diff of a group
is not always self-contained.

**Reviewers, start with Part V (groups 32–33).** Those commits fix
critical bugs found by two rounds of adversarial review of the finished
branch, plus the production OOM fix. They are small, self-contained, each
carries regression tests, and every commit message states the failure and
the fix — so they are the fastest-to-review and highest-value part of this
PR. Because `main`/`develop` are stubs (the whole project lands in this one
merge), these fixes could not be split into a separate earlier PR: the code
they fix exists only inside this branch. They are folded in here
deliberately, not by oversight. Part VI is the design polish and deployment
hardening that followed, as the app ran on phalanx.

Groups 10–25 are carried over from the retired stacked-PR plan
(`docs/pr-plan.md`, deleted in `5c42eb9`; this document preserves its
final content). Commits are listed oldest-first within each group.

Regenerate the raw list with:
`git log --oneline --reverse develop..tickets/DM-55435`

---

## Part I — Foundation and backend

### 1. Foundation (phases 1–7)
One squashed commit per build phase; each is large but self-contained.
- `8ca3c03` Phase 1: project foundation
- `e74c09c` Phase 2: data layer
- `79b344f` Phase 3: REST API
- `8acbc21` Phase 4: real-time
- `4b48e5b` Phase 5: frontend SPA
- `f9d09c6` Phase 6: sub-apps
- `a179a71` Phase 7: operational readiness
- `7c45dec` Point local location at USDF embargo bucket and resolve
  models_path relative to repo root
- `b23d651` Fix WS reconnect race on remount and proxy WS origin
- `b593ceb` Bump vitest to ^3.2.4

### 2. Real deployment configuration
The config model grown to the real deployment shape, plus the real
camera/site catalogue.
- `f7c87cf` Expand config models and loader for the real deployment shape
- `14be5b9` Surface new camera/location fields through the REST API
- `7dd3cd4` Port the real RubinTV YAML: full camera catalogue, real
  sites, real buckets
- `02d4202` Point tests at the new 'test' site, add coverage for site
  filter and metadata inheritance

### 3. S3 polling performance and robustness
Driven by benchmarking against the real USDF endpoint.
- `4c1d64b` Log per-scan event counts in the poll engine
- `73e39a1` Survive a race where two coroutines pop the same metadata lock
- `1d75d8d` Yield to the event loop periodically while applying a large
  poll batch
- `611cdb1` Warm up the S3 client pool at startup and split the poller's
  client
- `af56da2` Scan locations in parallel and make the poll cycle observable
- `282391c` Add a standalone S3 polling benchmark for the USDF host

### 4. HTTP caching
- `e3d4e67` Serve metadata with ETags and 304 handling
- `7b2e412` Gzip large HTTP responses

### 5. Streamed metadata and progressive loading
Large-day metadata streamed to the browser instead of blocking the grid.
- `8296c36` Persist cache slices incrementally as history is scanned
- `5b731b8` Stream date metadata to clients over the WebSocket
- `5c0d44f` Show a banner while historical data is still loading
- `0c94bb9` Consume streamed metadata progressively in the camera table
- `b7264ff` Fix metadataProgress query warning when no chunks have arrived
- `d3aeab2` Add debug logging across the metadata broadcast flow
- `c120fa5` Show all metadata columns; probe the metadata fetch timing
- `35b4304` Stream metadata incrementally off S3 with ijson
- `5edced8` Render streamed metadata progressively with a live row count
- `3ae6394` Lock ijson in uv.lock
- `c9402b9` Scan recent history first and surface per-camera load progress
- `a7b0d19` Render the camera grid without waiting on metadata
- `e023a75` Fix metadata progress indicator never appearing

### 6. Live views and channel serving
- `46a57bd` Render All Sky as a live view and resolve proxy objects by
  convention
- `38ab600` Resolve channel objects by seq prefix and suggest a download
  filename
- `1158b28` Add live "current" channel view that follows the latest
  exposure

### 7. Camera-table features (pre-design)
- `6267af9` Add a copy-link button to the camera table
- `a020146` Add per-row viewer/quicklook/copy-row links and metadata
  download to the table
- `6cfae39` Disable metadata download until metadata is fully loaded

### 8. Status, Admin, night reports and ops endpoints
- `acd6915` Surface disk-cache and warm/cold-start state in status API
  and UI
- `9b40568` Build out Cluster Status and global Admin pages
- `49bd43a` Backfill deep-linked dates on demand; reset poller state on
  flush
- `c08c27f` Warm recent metadata into the cache after each camera's
  recent scan
- `f3bc7cb` Set a reflective browser tab title per page
- `2b17f93` Serve night-report plots, type text items, backfill deep links
- `8f72292` Preserve whitespace in multiline night-report text
- `2da1691` Add pod-local heartbeat endpoint for RA service liveness
  (removed again in group 42 — nothing in Rapid Analysis ever reported
  to it; skim rather than review)
- `ba28985` Prune stale warm-start dates on full historical sweep

### 9. Test quality
- `9fceb75` Add always-on test coverage reporting
- `c1d1178` Fix all mypy errors and extend test coverage to 97%

---

## Part II — The design port

### 10. Design foundation: tokens, theme, hand-off
Everything visual depends on these.
- `a0955cb` Stage RubinTV design hand-off from Claude Design
- `783a750` Port design tokens + theme switcher from Claude Design
- `3f634f2` Refresh design hand-off; sync theme-toggle to latest design

### 11. App shell + per-view design ports
The shell (sidebar/tabs) plus the first pass restyling each view.
- `7288262` Port app shell: collapsible sidebar + camera tabs (step 2)
- `72f8eee` Port channel view: browser + restyled exposure viewer (step 3)
- `302c944` Channels view: latest-frame card grid per channel
- `18b1d02` Make historical-scan banner a compact pill above the live
  indicator
- `fc64c93` Port CameraTable to the design: angled headers, chips,
  density (step 4)
- `e1cfcd2` Restyle Detectors + Status to the design (step 5)
- `7f20d7f` Restyle AllSky to the design's feed layout (step 6)
- `02fd13b` Port NightReport to the design's folder-tabbed layout (step 7)

### 12. Column picker
Column-picker behaviour and the fixed-width fixes it surfaced.
- `d30c03e` Tidy CameraTable empty state when a date has no data
- `e69e3a0` Dismiss the column picker on outside click or Escape
- `fae41ec` Remove column-picker open lag by keeping its rows mounted
- `232d8df` Fix column-picker open lag at the source: memoize + isolate
  the table
- `a969b12` Add the column-picker header (title/count/search/all-none-
  reset) + real defaults
- `5ada0b9` Fix stretched channel columns with fixed per-column widths
- `4bc058a` Keep column widths fixed when few columns are visible
- `2938ea1` Add toolbar/button icons and fix the 404 rubin-mark asset

### 13. Date picker + heatmap
An iterative arc (several commits rewrite earlier ones); review the end
state rather than each step.
- `3464126` Implement the two-month calendar date picker
- `f393efc` Replace date picker with a year-heatmap overview + calendar
  counts
- `5eeaaaf` Date picker: two-month + heatmap views with a fixed tint ramp
- `aab7bc8` Date picker: calendar orientation for the heatmap + max seq
  in month cells
- `a5b4449` Date picker: drop per-seq dots, 6-across heatmap, binary All
  Sky heatmap
- `48f127a` Heatmap: alternating year stripes + day-selects / month-jumps
  split
- `928daec` Heatmap: whole mini-month is the month-jump target;
  distinguish day vs seq

### 14. Table cells, headers, action columns
- `9cfebc6` Show channel titles in the camera table header, not ref names
- `2e62aad` Blank action-column headers + per-cell colour-class from
  _<col> indicators
- `02b84df` Add per-cell colour-flag styles from the original app's
  palette
- `d2362cb` Replace table action-column text with icons
- `a1e98bd` Narrow action columns + check-mark copy confirmation
- `eb273b5` Render object/array metadata cells as a foldout modal
- `7b1dda7` Simplify table density to two sizes with larger, lighter
  headers

### 15. Table filtering + header controls
- `5965549` Implement the table metadata filter from the design
- `797be84` Move Columns + Filter controls between Copy link and Download
  metadata
- `55b1ae6` Open the Columns popover down-and-right, not leftward
- `ca364d4` Add prev/next-day stepper buttons around the date picker
- `acf4d5c` Add UTC clock + per-camera time-since-last clock to the table
  header

### 16. Seq.No URL filter
Another iterative arc landing on the `?seq_filter` catch-all + its docs.
- `5c5dafe` Support a URL seq range (?seqMin/?seqMax) as removable filter
  chips
- `2b622a7` Make all Seq.No filter operators work, not just the URL range
- `d2eb6cf` Add ?seqNum= URL param for a single-seq filter; mirror it in
  the URL
- `2c0b3ac` Replace seq URL params with one catch-all ?seq_filter for all
  operators
- `d5d78e4` Make seq_filter URL-readable: spelled tokens, no
  percent-encoding
- `2f93679` Document the seq_filter URL parameter in a new viewer guide

### 17. Loading state fix + S3 connectivity indicators
- `ec7a6ac` Fix empty-table loading state and add S3 connectivity
  indicators (bundles two concerns in one atomic commit: the empty-table
  loading fix and the S3 indicators)
- `2d0f6ea` Move the live pill to Status, scope the S3 pill, rename the
  site env var (also relocates the WebSocket/live indicator to the
  Status page — overlaps group 19's liveness cues; kept here since it
  edits the same ConnectionStatus/S3Status components)

### 18. Header, nav and chrome polish
Small independent UI fixes to the shell chrome; low review risk.
- `de6a2d3` Remove appearance controls from the main-page gutter
- `2dbca79` Add vector Rubin mark and tidy the header status row
- `ba71c34` Highlight Channels tab on channel pages, drop doubled live dot
- `676ff9a` Pad the topbar bottom on pages without a tabs row
- `f32e9a8` Add tooltip explaining the live indicator's states
- `d25b952` Make breadcrumbs read as breadcrumbs with › separators
- `0f8ea6a` Give RubinMark intrinsic size to prevent logo flash on refresh

### 19. Liveness cues across views
Everything that signals "is this the live observing day / is this fresh".
- `7919ae5` Dim channel cards that lag the night's seq frontier
- `38c8d44` Show whether Channels cards are the live observing day
- `9147926` Tint the table date chip by observing-day state
- `106a2d0` Pass isCurrentDayObs to the All Sky date chip
- `ac7ed49` Show camera dots as stale when no data for the current day
- `4611d5a` Reflect S3 unreachable in the historical-refresh pill

### 20. All Sky, Mosaic and live-view cameras
- `8a88f25` Drop Table/Channels tabs for live-view cameras
- `cf7601a` Let All Sky frames fill the stage
- `68f5f33` Shrink All Sky frames to the image on short pages
- `751dbf5` Autoplay and loop the All Sky movie
- `bb4c3f6` Make Mosaic a live, embeddable view; drop obsolete has_mosaic
  flag

### 21. Camera table: virtualization, sorting, config-locked columns
- `20db80d` Virtualize camera table rows and clip overhanging headers
- `86564d9` Let cell colour flags show through the newest-row highlight
- `73effc4` Drive locked metadata columns from config
- `84e0e4a` Add ascending/descending sort to orderable table columns
- `282bd32` Pin camera table scroll position during live updates
- `b8a0e58` Floor @tanstack/virtual-core at >=3.16.0 for anchorTo
- `7b34ea9` Cap cell-modal key column so short values aren't shredded

### 22. Channel view enrichment
- `f1f946b` Subscribe the channel browser to live camera updates
- `cde5078` Enrich the single-channel metadata sidebar
- `e1788fd` Link empty channel cards to their last known plot
- `2e9be56` Add a sibling-channel strip and image-load spinner to the
  channel view
- `066dbc2` Show a loading spinner on channel grid cards

### 23. Path prefix, legacy redirects, shell header, site banners
Backend routing parity with V2 deployments plus the header work built on
it.
- `bb774c5` Serve the whole app under a configurable path prefix
- `215a4bf` Redirect legacy deep links to the new SPA routes
- `c2ea0d4` Clarify metadata LRU cap is global, not per-camera
- `755a7a2` Hoist the date picker into the shell header
- `8f3fafc` Add site processing banners and a non-prod header strip

### 24. Sub-apps: DDV websocket bridge + container-start builds
Replaces v2's start-daemon.sh: the DDV client/worker relay, plus a
start.sh entrypoint that builds DDV / installs exp_checker at container
start (kept at container start, as in v2, so pod restarts pick up new
DDV commits without an image rebuild).
- `a0da1b3` Replace v2's start-daemon steps: DDV bridge, image-time
  subapp builds
- `ec65201` Build DDV at container start again, not at image build
- `cf7c2b4` Fix image build and exp_checker install found by a real
  docker run

### 25. Landing pages: location/camera/app logos
Restyles the Home and Location landing pages into the original RubinTV
full-bleed logo buttons: each camera/location logo fills its button as a
background image (jpg photos cover, svg marks contain) with the title
overlaid using the config's text_colour/text_shadow. Home splits into
grouped sections (Processing Locations / Apps / Test-stand Locations,
each hidden when empty), single-location deployments redirect straight
to that location, and the Location page's cluster-status text link
becomes a matching logo button. Bundles the logo images under
`web/public/logos/` and adds logo/text_colour/text_shadow to
CameraSummary + has_cluster_status to LocationSummary (openapi.json +
api-types regenerated in the same commit).
- `35d37ca` Incorporate location/camera/app logos as full-bleed buttons

---

## Part III — Packaging, CI and release

### 26. CI and dependency chores
- `ff7f010` Apply npm audit fix and ignore the Vite cache
- `b638da2` Bump CI actions off the deprecated Node 20 runtime
- `da213b1` Bump setup-uv off the deprecated Node 20 runtime
- `16d1f94` Inject X-Auth-User in the Vite dev proxy for local admin
  access

### 27. Version 3.0.0 + build provenance + image-build CI
Stamps the release: version 3.0.0 everywhere, git sha + commit date on
the Admin page (baked in as Docker build args — the runtime image has no
.git), and the V2-convention image-build CI job (tickets/**, deploy**,
develop, tags → ghcr). The drift-sync commit is mechanical (the
committed openapi.json/api-types had gone stale); review the feature
commit for the real schema change.
- `1f3b7d7` Regenerate the stale openapi.json and api-types
- `99ce8ac` Bump to 3.0.0 and show git provenance on the Admin page

### 28. Package as `lsst.ts.rubintv` for conda/EUPS install parity
Repackages the app the way lsst-ts builds and deploys V2: relocates the
backend to `python/lsst/ts/rubintv/`, adds the conda/EUPS/Jenkins
scaffolding, the `run_rubintv` entry point, and the GHCR image-build CI
job. One CI build job passes both the setuptools_scm `RUBINTV_VERSION`
arg and the `GIT_SHA`/`GIT_DATE` provenance args; the static 3.0.0
version gives way to the tag-derived one (cut a v3.0.0 tag at release);
`scripts/start.sh` stays the entrypoint — carrying the container-start
DDV/exp_checker logic — but launches via the `run_rubintv` console
script.
- `07f3015` Package as lsst.ts.rubintv for conda/EUPS install parity
- `30f1e8c` Fix pre-existing ruff errors in dev scripts
- `6b324b4` Fix pre-existing mypy errors exposed by the new check target
- `7e277fa` Document the tag-driven release procedure in the operator
  guide
- `25fd05a` Adopt the TSSW pre-commit config for Jenkins CI
- `ae86180` Conform doc lines and benchmark lambdas to the TSSW hooks
- `b31dbd7` Make the test suite hermetic to the developer's AWS config
- `bc99d9d` Survive Kubernetes service links and listen on 8080 in the
  container
- `f14e373` Answer the readiness probe at bare / with a redirect into the
  prefix
- `a757abe` Merge branch 'design-port' into conda-parity (brings the
  logos + dev-proxy header work into the packaging lineage)
- `59c9836` Rewrap a merged doc line to the TSSW 79-char doc limit
- `6c2a1a9` Default the cache to /scratch and serve public assets from
  the SPA dist
- `9f86c55` Redirect bare sub-app paths into their mounts; drop the
  header links
- `255bc31` Stop reading RUBINTV_HOST/RUBINTV_PORT; host and port are
  flags only

---

## Part IV — Deployment iteration and consolidation

### 29. Fixes from running the deployed app
Polish and fixes found while iterating on the real phalanx deployment.
- `8d3a21c` Show table floats to 3 decimal places instead of 2
- `69cf5d9` Rewrap the settings comment to the 79-char doc limit
- `6c852d0` Add shift-arrow channel navigation to the single-channel view
- `cd1ef0b` Surface S3 poll-cycle latency and link the header pill to
  Status
- `04b6c15` Regenerate openapi.json/api-types to catch up with landed
  code (mechanical; recipe in the commit message)

### 30. Cluster Status: seed from retained stream entries
Fixes the page sitting blank after an app restart during a quiet period:
the producer's 0.5s loop is change-gated, so we seed each stream from
its `maxlen=2` retained entry (XREVRANGE) before tailing.
- `10c5357` Seed cluster-status streams from last retained entry on
  startup
- `2a663f3` Add toggleable DEBUG trace for cluster-status data flow
- `a1e9f0c` Test that a later cluster-status snapshot fully replaces the
  prior one

### 31. Docs, merges and housekeeping
Safe to skim.
- `24bb403` Document the branch model and main's protection ruleset
- `7439d82` Nudge webhooks for Jenkins CI (no content)
- `b00ef5f` Merge branch 'deploy' into tickets/DM-55435
- `3cf8be5` Merge branch 'redis-detector-seed' into tickets/DM-55435
  (resolution also fixes the seed test's monkeypatch target to the
  `lsst.ts.rubintv` module path and rewraps for W505)
- `5c42eb9` Drop the stacked-PR plan; DM-55435 lands as one reviewed
  merge
- Plan bookkeeping, docs-only (edits to the now-deleted
  `docs/pr-plan.md`): `e768300`, `3277c95`, `13069c6`, `87ce19f`,
  `08596e0`, `0c2e434`, `0dfd491`, `bbd789c`, `bb44b6d`, `1287e8b`,
  `3822906`, `80fe164`, `147f55d`, `900df83`, `8ea8b18`, `9907373`,
  `7adcb03`
- This guide's own revisions, docs-only: `a71d18a`, `24ee2e9`, `017566a`,
  `d673fcd`, `49fe56b`, `f50907b`, `3550b1e`, `43311b7`, `c67ac85`, `5d1caf9`,
  `c6873f2`, `6da0777`, `4dcf193`, `8175288`, `52f266e`, `1997cb8`,
  `175f1e7`, `f5ba744`, `46b1c0a`, `0d35377`, `6290dde`, `24640bc`,
  `1792bd6`, `095e603`, `6697073`, `33bfb1d`, `a724bfb`, `05b23bf`,
  `fc0b960`, `be142d2`, `cbfb3ad`, `b73c2d6`, and the commit that
  noted the preview fix.

---

## Part V — Post-review fixes

### 32. Fixes from a post-implementation adversarial review
An adversarial review of the finished branch (backend concurrency, HTTP/WS
API, security, both frontend layers, build/deploy) surfaced a set of real
bugs — two of them silent and process-wide. Each commit is self-contained
and adds regression tests for what it fixes; review these commits directly
(their diffs are small and standalone, unlike the feature groups above).
Highest-risk items to scrutinise: the WebSocket-pump death and the
`site="local"` admin default in `27d71a4`.

- `27d71a4` Fix backend runtime, security, and API robustness bugs. The
  load-bearing ones:
  - **WS bus pump death**: `prune_dates` published a `StoreChange` whose
    type (`"calendar"`) had no `ServerMessage` counterpart, so `_fan_out`
    raised `ValidationError` and killed the pump task — silently stopping
    *all* live updates process-wide until restart. Renamed the type end to
    end (`calendarUpdate`) and wrapped `_fan_out` in a per-change guard so
    no future mismatch can kill the pump. (Verify: `ServerMessageType` in
    `ws/protocol.py` vs `_CHANGE_TO_TOPIC` in `ws/handler.py`; the pump loop
    in `_pump`.)
  - **Redis readers die on a blip**: both reader loops had no reconnect and
    no error handling, so a Redis restart froze Cluster Status / control
    readback forever with nothing logged. Now supervised with backoff.
  - **`site="local"` grants everyone admin**: the default site maps to the
    real USDF locations with `admin_for: ["*"]`, so a pod that booted with a
    missing/wrong `RAPID_ANALYSIS_LOCATION` granted admin to any
    authenticated user. The wildcard is now fail-closed behind
    `RUBINTV_ALLOW_ADMIN_WILDCARD` (named admins still apply). Also:
    `controls/set` restricted to config-defined keys; night-report link
    URLs scheme-validated (XSS); proxy path segments validated; on-demand
    backfill capped + memoised; `prune_dates` race fixed; blocking cache I/O
    moved off the event loop; `/admin` redirect loop removed; Range→416.
- `9c932ad` Fix frontend data-layer bugs: column prefs no longer leak/corrupt
  across cameras (the route doesn't remount on a param change); corrupt
  localStorage no longer crashes the table; numeric `=`/`between` filters
  compare by value (a leading `-` no longer breaks a range); WS reconnect
  refetches missed data; `staleTimeForDate` uses day_obs space; integers
  render without a spurious `.000`.
- `f2a76f0` Fix frontend UI bugs: DatePicker "today" tracks the live
  observing day (was frozen at mount); selectable day cells are keyboard-
  operable; the newest-row highlight tracks max seq not visual row 0; image
  cards re-arm on a live frame swap; the Channel viewer resets its latch on
  rollover and no longer dead-ends on a missing seq; AllSky/Mosaic guard
  partial configs; stacked overlays close one Escape at a time.
- `1c20fe2` Use the non-deprecated `HTTP_416_RANGE_NOT_SATISFIABLE`
  constant (silences a Starlette deprecation warning from the Range fix).

Kept separate on purpose: `bcbf552` (ignore the `.vite` prebundled-dependency
cache in eslint) is a generated-cache config tidy, not a bug fix, so it is its
own commit and the fix commits stay pure. A handful of lower-severity review
findings were judged already-safe on closer inspection (SPA traversal guard,
legacy redirect, sort comparator).

### 33. Second review round and the production memory fix
A second adversarial pass once the app was running at USDF, plus the fix
for the pod being OOMKilled after ~4 days. `fea95f3` and `ba63985` are an
arc: the first tracked backing files per index slot so a rename could not
erase a live seq; the second replaced that whole approach (and the poller's
retained listings that were eating ~4GB) with a presence-only index and
set-difference reconciliation. Review `ba63985`'s end state — the store,
`S3Poller` and `ScanScope` — rather than the pair.
- `fea95f3` Track backing files per index slot so renames can't erase
  live data (superseded by `ba63985`)
- `ba63985` Index presence, not object identity, to stop unbounded memory
  growth. The OOM fix: `S3Poller` is stateless, `EventStore.reconcile`
  prunes by set difference within a `ScanScope`, and the cache slice
  format is v3.
- `7ee75ab` Fix thread-safety and lifecycle hazards around the event loop:
  sync endpoints that iterated poller-mutated dicts on the threadpool are
  now async; a failed historical sweep retries on a 60s backoff instead of
  sleeping 12h and reporting "loaded"; per-location scan workers barrier
  before a failure propagates.
- `17195f7` Harden input validation, admin writes, and operator-facing
  config: `valid_date` requires a real calendar date (each impossible date
  used to buy an S3 listing); per-location control writes share the
  site-wide key allow-list; night-report links reject protocol-relative
  URLs; `RUBINTV_LOG_LEVEL=trace` no longer crashes startup.
- `6d78f52` Fix SPA state-hygiene bugs: refcounted WS subscriptions (one
  consumer's unsubscribe killed another's live updates); the streamed
  metadata slot resets when a REST fetch lands (no ghost rows); stable
  escape-stack ordering in `useDismiss`; AllSky keeps `headerless` across
  date changes.
- `8f6422c` Keep the ws pump's except line in a form black and ruff both
  accept (formatter tie-break, no behaviour change)
- `352e424` Read per-day entries as {seq, ext}, as the API now sends them
  (the frontend half of `ba63985`; moved here from `tickets/DM-56222`)
- `340ce55` Regenerate openapi.json and api-types to catch up with landed
  code (mechanical)

---

## Part VI — Design polish and deployment hardening

Smaller UI and operational commits made while the app ran on phalanx.
Most are independent; the arcs worth reviewing by end state are called
out.

### 34. Shell, header and chrome, second pass
- `71331d0` Replace app-shell sidebar with NavMenu drawer and launcher
  home
- `7368414` Turn channel-head links into icons; serve images inline
- `172a5cc` Move env warning into the topbar strip; align status pills
- `b09547d` Align processing banner with title; slant it as a
  parallelogram
- `244b617` Enlarge the topbar date picker without growing the topbar
- `2b161a9` Remove topbar-main on app pages
- `e7ab116` Seat the topbar date picker in line with the tabs
- `388c6de` Seat the date stepper in the title row, not the tab bar
  (supersedes `e7ab116`: the date is page scope, so it sits after the
  camera name; the tab row is view switching only)
- `3f9409e` Pin sort arrow to bottom of angled headers so it survives
  truncation
- `e043b70` Add favicon
- `3088b59` Add a Simon Krughoff memorial to the home page
- `0751ea0` Tint the memorial plaque in the mark's own teal

### 35. Location and Channels cards
- `9396183` Hide Previously Used Channels group on USDF Summit
- `4343548` Border stale Channels cards in the indicative orange
- `dd0bdc4` Represent each camera card by its primary channel's latest
  image
- `49a8149` Share the Channels grid's image-loading logic on location
  cards
- `0c0efcf` Distinguish no-data cameras from stale ones on location cards
- `49547f8` Remember the camera Table/Channels tab across cameras
- `e5fa4e7` Store Table as the wanted tab when a date is applied
- `58ddb90` Label the seq on channel cards and drop the duplicated channel
  label
- `40385e5` Word the channel-card lag pill as "N behind", not a negative
  number
- `c33ff61` Show event-page metadata floats to 3dp like the table
  (formatCell moves from CameraDataTable into lib/metaCells; its test
  moves with it)

### 36. Camera table and column picker, second pass
`32e9549` → `22cdffb` → `481035f` is an arc (pick order, then drag to
reorder, then the picker split into Select / Reorder views); review the
final `ColumnOrderList` and `useColumnPrefs`.
- `c8c8b77` Guard CameraTable against a camera payload missing channels
- `265d393` Tighten the compact table's horizontal spacing
- `45fd1b2` Stripe alternate metadata columns for readability
- `32e9549` Order table columns by the sequence they're picked
- `22cdffb` Let users drag table columns into a custom order
- `481035f` Split the column picker into Select / Reorder views
- `98a9574` Show filtered row count, edit filters in place, drop object
  columns
- `6fc2481` Fix camera table column widths so they don't jump while
  scrolling
- `264367e` Show the time-since clock in days and hours after three days
- `19e3ba9` Point the lsstcam quicklook link at fov-quicklook's current
  visit-id format
- `b952ec3` Show the image-viewer link only at summit and base
- `b5b6fb8` Flow the column picker's names down columns, not across rows
- `b985ecd` Scroll truncated column names into view on hover in the picker
  (`ScrollingTitle`, in both the Select grid and the Reorder list)
- `eba60db` Let the column picker drag wider until every name fits:
  custom corner grips (`useColumnPickerWidth`) cap the width at the
  longest name or `main.app-content`'s edge; the grid now holds at most
  three columns so extra width widens names

### 37. Channel viewer zoom and keyboard
- `1641994` Click-to-zoom the single-channel image (fill/fit toggle)
- `7363e06` Persist the fit/fill zoom across image changes
- `07206dd` Stop arrow-key nav from selecting text
- `f16379d` Disable image zoom when it already fits vertically

### 38. Status, Cluster Status and Admin pages
- `651bd3b` Tidy the Scan Status page into per-location cards
- `aed5de7` Give WebSocket and S3 status their own sections
- `2a1f3c4` Consolidate scan notices and location cards into one section
- `90880ef` Grid the Cluster Status rows so panels align and share width
- `c35f938` Gate Cluster Status restart on admin; align + Esc the confirm
- `580978b` Fix confirm/cancel alignment and overflow in narrow cards
- `4b624be` Disable all Redis-writing admin actions when Redis is off (one
  `redisDown` flag gates every write consistently; flush-historical stays
  enabled since it clears the disk cache, not Redis)
- `9b0e699` Reword Redis-off warning now that writes are blocked, not
  failed
- `d4c2e83` Show full version only on deployed builds; sha+date locally

### 39. Route validation and the 404 page
- `a48d0b7` Validate route params and add a 404 page: the bare `/rubintv`
  (no trailing slash) rendered a blank page because the router's basename
  kept Vite's slash; unknown locations/cameras now resolve against the
  fetched config through a `RouteGuard` instead of rendering a half-built
  shell.

### 40. Deployment config, DDV and operations
Facts learned from the real phalanx/USDF deployment, each small.
- `3555f21` Normalise RAPID_ANALYSIS_LOCATION codes to internal site names
  (the RA env sets BTS/TTS/SUMMIT/USDF; a USDF pod failed startup with
  "unknown site")
- `e9a96eb` Declare certifi so boto trusts the USDF embargo gateway
- `46c1b88` Operator guide: document the entrypoint variables and the
  missing settings
- `def7716` Render tracebacks in JSON logs
- `31d48bf` Set the S3 endpoints for the base, tucson and summit locations
- `d28337b` Build the Redis URL from the chart's RA_REDIS_* variables
- `99f1643` Fall back to S3_ENDPOINT_URL for locations without an endpoint
- `811cae1` Take the base, tucson and summit S3 endpoints from the
  environment
- `35ab80a` Don't mount DDV from a half-built Flutter bundle
- `db9f323` Keep a DDV worker busy after its client disconnects mid-job
- `20567ba` Build the web DDV (rubintv-ddv) at container start instead of
  the Flutter app (the runtime image carries Node 24 instead of the
  Flutter SDK)
- `fe47422` Serve one image under any prefix and declare dev instances
  explicitly: Vite builds with a relative base and `render_index`
  (`spa.py`) fits `index.html` to `RUBINTV_PATH_PREFIX` as it is served
  (summit dev runs at `/rubintv-dev`); `RUBINTV_INSTANCE_ENV` replaces
  the "-dev"-in-the-URL guess for the dev strip and `{dev}` links

### 41. CI, licensing and tooling
Safe to skim.
- `2cc3672` Let ruff own test_settings formatting (unwrap the parametrize
  line)
- `eee827a` Wrap two W505-flagged comment lines in test_api
- `94f29f2` Address CI: ruff format, stabilize a hook dep, bump CI action
  versions
- `6cca159` Pin setup-uv to v8.3.2 (no floating v8 tag exists)
- `887eb48` Enable the mandatory insert-license pre-commit hook
- `b17284d` Add COPYRIGHT and adopt GPL licence in project file
- `1efac3f` Add run-rubintv skill: launch and drive the dev stack
- `1bc673c` Gitignore a local `.env`

### 42. Protocol tidy-up: unused topics and the heartbeat removal
Dead surface removed once the running app showed what was actually used.
- `775b098` Drop the unused channel topic and the stale poller-diff
  comments (the `channel` topic and `event`/`subscribed` message types
  were never published; comments still described the pre-`ba63985`
  listing diff)
- `bce07e0` Remove the RA heartbeat endpoint and the config service
  registry (undoes group 8's `/internal/heartbeats` and the
  `services:` YAML it was for — Rapid Analysis never reported to it, and
  the Cluster Status page covers worker liveness from Redis)

### 43. Polling: silent re-listings and a two-hour recent refresh
Found by tracing the poll → bus → WebSocket path: because the poller is
stateless (`ba63985`) and `apply` published for every classified event,
every 1s cycle re-published every camera with data today and every
subscribed tab refetched its payload, metadata and calendar each second.
Review `EventStore._insert`/`apply` and `ReconcileResult` in
`data/store.py`, then `_refresh_recent_until` in `data/tasks.py`.
- `40ee3ff` Publish a store change only when the index actually changed:
  inserts report whether they altered the index; `metadata.json` (same
  key, new content) is tracked by the ETag the listing already carries,
  persisted in the cache slice; reconcile also returns surviving dates
  that lost entries so their slices are rewritten.
- `4491599` Re-scan the recent window every two hours between full
  sweeps (`RUBINTV_RECENT_REFRESH_SECONDS`, default 7200). Previously
  recent dates refreshed only with the 12h full sweep, despite the module
  docstring saying otherwise.
- `636f562` Make the recent-refresh tests count passes, not wall-clock time
  (a Jenkins box blew through the 60ms budget in one pass)
- `983f46c` Re-scan each camera's newest data days outside the window every
  pass (`RUBINTV_RECENT_KNOWN_DAYS`, default 5, from the camera's
  calendar), and stop re-warming metadata on the periodic pass
- `d7a9d45` Yield while publishing so a bulk apply can't overflow the bus:
  a cold full sweep publishes thousands of changes in one apply, past
  the 1000-entry bus queue, and the overflow was dropped — tabs on those
  dates never learned they had changed.

### 44. Data-flow instrumentation
Debug-level timing and size for every hop (`http.request`,
`ws.frame.sent`, `poll.current.cycle`, `store.apply`, `poll.scan` with
`keys`/`slices_touched`), the `scripts/flow_summary.py` aggregator, and
the operator-guide recipe. Two behaviour changes ride along: `poll.scan`
is info only when a listing changed the index (it had been one info line
per camera per second since the poller became stateless), and
`WsService.handle` deregisters the connection before awaiting in its
`finally`, so a cancelled handler no longer leaks a registry entry.
- `01ecaf8` Log the timing and size of every hop so the data flow can be
  measured
- `8fceca6` Report streamed responses as such in flow_summary, not as 0
  bytes
- `4861e5a` Satisfy the Jenkins flake8 and mypy hooks on the newest tests
  and script (flake8 counts a line ending in a type-ignore pragma; the
  Jenkins mypy hook covers `scripts/`)
- `88c259a` Read ReconcileResult in check_reconcile, which still expected
  a set — a script break from `40ee3ff` that the looser Jenkins mypy
  config did not catch
- `90ccb29` Mark the late import in check_reconcile for flake8 like its
  neighbours
- `e2a951d` Add a log guide (`docs/log-guide.md`): getting at the logs in
  the cluster, what to grep for by symptom, and a catalogue of all 112
  events. `tests/test_log_guide.py` fails when the code logs an event no
  doc lists, or the catalogue lists one the code no longer logs

### 45. Metadata by the stream alone; calendar on new dates only
What the first capture showed: the REST metadata request duplicated the
WebSocket stream (98% of session bytes) and, sharing the server's
per-date lock, queued 18–28s behind the stream's download on a slow
link; the calendar was refetched on every exposure. Review
`web/src/lib/useMetadata.ts` (the backstop rule), the chunk accounting in
`liveQuery.ts`, the `refresh` action in `ws/handler.py`, and
`calendarUpdate` on a new date in `EventStore.apply`.
- `40d1220` Deliver metadata by the stream alone; refresh the calendar only
  on a new date
- `252a73c` Send a metadata delta on refresh when the client's version
  allows: the cache diffs each version against the one it replaced;
  `refresh` carries `since_etag`; a `metadataDelta` (rows + removed)
  replaces the full re-stream when the versions line up, else it falls
  back to the stream.

### 46. All Sky, second pass
Review `web/src/views/AllSky.tsx` and the All Sky block of
`web/src/index.css`, whose `.allsky-stage--fit` modifier holds the
historical-only sizing (renamed `.media-stage--fit` in group 47, which
shares it).
- `39777e3` Fit the historical All Sky movie to the stage; add caption
  actions: a grid of size-container cells caps the lone past-day movie at
  the stage's height (the current day keeps its full-width, scrolling
  columns); download and open-in-new-tab caption buttons; the live movie
  captioned `#1 → #<seq>`
- `3ddf2ac` Wait for the calendar before drawing All Sky tiles (a link to
  today no longer renders as a past day first and 404s on a "final" movie)

### 47. Per-day channels: a night-by-night movie viewer
A per-day channel (AuxTel's Tonight's Movie) opened from the Channels grid
rendered nothing: the single-channel view only knew seq channels. Review
`web/src/views/PerDayChannel.tsx` with the dispatch at the top of
`Channel.tsx`, the `perDayChannel` branch in `useShellNav.ts` and
`applyDate` in `Layout.tsx` (the shell picker steps a per-day channel's
nights in place), and `EventStore.calendar_per_day_dates`.
- `e1d7f64` List each per-day channel's nights in the calendar
  (`CalendarOut.per_day_dates`; API artifacts regenerated)
- `4ea49b2` Give per-day channels a night-by-night movie viewer: the
  night's movie fitted like All Sky's past day, captioned with the night's
  exposure range (linking to its table) and a download button; `/current`
  follows the channel's newest night; a `perDay` live message refreshes
  the calendar. All Sky's stage classes become neutral `media-*` ones
  (a rename, no style changes) and `DownloadMovieLink` moves to
  `components/`
- `e6267c2` Mark the movie-nights date picker apart from the exposure
  picker: DatePicker's `allSky` prop becomes `movies`, which takes a movie
  violet (`--movie`) and a film icon; a `title` heads the popover in both
  modes ("AuxTel · nights with exposures" / "Tonight's Movie · nights with
  a movie")
- `329edf2` Hold back camera-specific header parts until the config lands:
  while a camera's config is in flight the shell no longer draws a regular
  camera's title, Table tab and date picker (which flashed on All Sky);
  invisible stand-ins keep the title and tabs rows' height (`cameraPending`
  in `useShellNav.ts` and `Layout.tsx`)
- `67f7bff` Link a night's per-day artifact from its table: the per-day
  strip's "movies: final" label becomes a link to that night in the
  viewer, worded from the channel's label ("Movie for 2024-10-23")
- `3a31fe0` Mark the days with a per-night artifact in the table's date
  picker: a movie-violet dog-ear on those days in both views, keyed in the
  heading (`perDay` on DatePicker, `perDayMarks` in `useShellNav.ts`)

### 48. Interrupted media downloads
An S3 read that broke mid-stream logged a traceback and, worse, reached
the browser as a short file that looked whole and was cached as such (the
`BaseHTTPMiddleware` ended the response normally before re-raising).
Review `_iter_body` in `api/proxy.py`, `CorrelationMiddleware` and
`ResponseAborted` in `middleware.py` (the ASGI-level tests in
`tests/test_ops.py` show the response left unfinished), then
`web/src/components/ProxiedMedia.tsx` and the pill in `Layout.tsx`.
- `ac5c75d` Resume a broken proxy stream, and abort one that can't be
  resumed: the rest is fetched with a Range from the break, pinned to the
  ETag (`IfMatch`), up to twice; otherwise `ResponseAborted` leaves the
  response unfinished so the connection is cut. `correlation_middleware`
  becomes the plain-ASGI `CorrelationMiddleware` (same id, header and
  timing log)
- `c2e0773` Show what arrived of a cut-short image and offer a reload:
  `ProxiedImg` refetches a failed image and shows the bytes that arrive;
  `ProxiedVideo` reports a failed movie the server still serves; a
  "Download interrupted · Reload" pill in the topbar. The Vite dev proxy
  now passes a backend abort on instead of holding the connection open
- `4454bf5` Accept either body in the aborted-stream proxy test, which
  failed on Jenkins only: from starlette 1.9 (Jenkins has it; `uv.lock`
  pins 1.1.0) the TestClient streams the body, so an unfinished response
  reads back the bytes sent rather than nothing. `test_ops` still checks
  that the response is left unfinished

### 49. Nightly Summary, second pass
The night report's page (headed Nightly Summary) drew its plots too
small to read, its button and URLs still said "night report", and its
camera tab never appeared. Review `PlotModal` and `PlotPanel` in
`web/src/views/NightReport.tsx`, then the renamed routes in
`routes.tsx`, `api/nightreport.py`, `api/proxy.py` and
`legacy_redirects.py`, then `tabsForCamera` in
`web/src/lib/useShellNav.ts`.
- `59dba2c` Enlarge a Nightly Summary plot on click: each plot opens
  filling the window; a click anywhere but the caption, Escape or the
  close button closes it. It closes on the click, not on pointerdown, so
  on a touch screen a tap outside can't land on (and open) the plot
  underneath
- `1dea769` Call the night report the Nightly Summary wherever users see
  it: the table's button, the page route (`/nightly-summary`), the API
  routes and the OpenAPI tag (API artifacts regenerated). The old app's
  `night_report` links redirect to the new page on the server; this
  app's pre-rename `night-report` URL redirects in the SPA's route table,
  so it also works under the Vite dev server. Internal names, JSON
  fields, camera config keys and the bucket's keys are unchanged
- `b3f10a0` Show the Nightly Summary tab for cameras configured by
  prefix: the tab was gated on `night_report_label`, which no camera
  sets, so auxtel (configured by `night_report_prefix` alone) never got
  it; either field now opens the tab and the label stays an optional
  rename
- `b151804` Show the tab only on nights that have a Nightly Summary: it
  also needs the date payload's `has_night_report`, which the shell
  reads from the query slot the Table and Channels views share (asked
  for only when the camera's config offers a summary). On the summary's
  own page the tab stays, so a deep link to a night without one still
  shows which view it is. The table's toolbar button, shown under the
  same condition, goes as a duplicate

### 50. Coverage pass, a CI coverage report and a gate
Tests for what the suites never ran, on both halves, a coverage report
on every GitHub Actions run, and a gate that fails CI when coverage
drops. Tests and CI apart from dead-code removals: no shipped behaviour
changes. Read `.github/workflows/ci.yml` and the `no_dotenv` fixture in
`tests/conftest.py`; skim the rest.
- `fc56967` CI: publish a coverage report. Each job writes its total
  and the files short of 100% to the run's summary page and uploads the
  HTML report as an artifact (kept 14 days), even when a test fails.
  Backend coverage now counts branches
  (`[tool.coverage.run] branch = true`, so Jenkins and local runs too);
  `web/scripts/coverage-summary.mjs` renders Vitest's json-summary
- `96421c9` Keep the whole suite off the developer's `.env`: a
  session-wide autouse fixture switches Settings' env file off, so the
  suite behaves the same wherever pytest starts. A local `.env` had
  pointed tests at the real cache dir (and, with the guide, at live
  Zephyr)
- Backend tests, branch coverage 94% → 99.4%: `ee02596` the app's
  cache upkeep, metadata preload and root serving; `99f62bf` the
  WebSocket handler's failure and cancellation paths; `5ba239a` config
  edge cases, the settings cache, the CLI and build provenance;
  `9484764` the data layer's failure, abort and bookkeeping paths;
  `be7c6b7` API revalidation, proxy edge cases and relay failures
- `6a33b40` Remove the store's unused `_date_of` helper (its last
  caller went in `ba63985`; `data/source.py` keeps the live copy)
- Frontend tests, statements 89% → 99.7%, branches 86% → 96%,
  functions 77% → 98%: `de289b4` the theme picker, nav menu, cell modal
  and small shared parts; `de8aef6` the socket's reconnects and the
  layout-measuring hooks; `3e83582` the channel viewer's keys and zoom
  and the table's toolbar; `6ae2e2b` the other views' actions,
  fallbacks and failure paths; `cfd41b1` the pickers, filters, media
  recovery and route guard. The stub socket in `src/test-setup.ts`
  gains `liveSockets()`, `dropLiveSocket()` and `pushRawLiveFrame()`
- `d2ae567` Remove dead code the pass turned up: the `api.controls` and
  `api.detectorsConfig` client helpers (the endpoints stay),
  `basePath.logoUrl` (pointed at a `public/logos/` the SPA no longer
  ships) and `ScanResult.dates` with the private `_date_of` behind it
- `1669b1e` Fail CI when coverage drops: backend below 99% (99.5%
  today); frontend below 99% of statements and lines, 97% of functions
  and 94% of branches. Set on the CI command lines only, so partial
  local runs and Jenkins report without failing

### 51. Previews that don't hold up the next page
On USDF dev a slow grid of previews stalled the page a user clicked
through to. The media proxy is sync, so it runs on Starlette's shared
worker-thread pool, and the JSON endpoints' dependencies were sync
too, so a page's data queued behind preview downloads. Review
`api/deps.py` and the test.
- `8e4ced1` Keep page data off the thread pool the image proxy fills:
  the shared dependencies (`get_app_state`, `get_models`,
  `get_location`, `get_camera`, `valid_date`) and the camera detail
  endpoint are async, so page data never needs a worker thread; the
  proxy stays sync. Previews ask for low fetch priority.
  `test_page_data_needs_no_worker_thread` makes the pool unusable and
  checks page data still answers

---

## Notes for the reviewer

- Groups 13 and 16 are iterative arcs where later commits rewrite
  earlier ones — review their end state (the final diff of the touched
  files) rather than commit-by-commit.
- `ec7a6ac` (group 17) bundles two concerns (the empty-table loading
  fix and the S3 indicators) in one atomic commit.
- Commit order across groups 18–25 is thematic, not chronological; a
  group's commits may interleave with other groups' in the raw log.
- The API artifacts (`openapi.json`, `web/src/lib/api-types.ts`) are
  generated. Regen recipe: export `create_app().openapi()` with
  `RUBINTV_PATH_PREFIX=""`, pin `info.version` to `3.0.0`, then
  `npm run gen:api` in `web/`. They are verified in sync at the branch
  tip.
