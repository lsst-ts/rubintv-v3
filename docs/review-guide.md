# Review guide: DM-55435 (the V3 rebuild, one PR)

This PR lands the whole rebuild — ~230 commits on `tickets/DM-55435` —
as a single reviewed merge into `develop`. This guide groups those
commits so the branch can be read theme-by-theme instead of
chronologically. Groups are a reading order, not merge units: many
later commits revisit files introduced earlier, so the diff of a group
is not always self-contained.

**Reviewers, start with Part V (group 32).** The four newest commits fix
critical bugs found by a post-implementation adversarial review. They are
small, self-contained, each carries regression tests, and every commit message
states the failure and the fix — so they are the fastest-to-review and
highest-value part of this PR. Because `main`/`develop` are stubs (the whole
project lands in this one merge), these fixes could not be split into a separate
earlier PR: the code they fix exists only inside this branch. They are folded in
here deliberately, not by oversight.

Groups 10–25 are carried over from the retired stacked-PR plan
(`docs/pr-plan.md`, deleted in `2c87f6b`; this document preserves its
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
- `2e67340` Move the live pill to Status, scope the S3 pill, rename the
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
- `e705206` Drive locked metadata columns from config
- `ae2e081` Add ascending/descending sort to orderable table columns
- `632b22c` Pin camera table scroll position during live updates
- `b7b6194` Floor @tanstack/virtual-core at >=3.16.0 for anchorTo
- `74a39d4` Cap cell-modal key column so short values aren't shredded

### 22. Channel view enrichment
- `e58d0b3` Subscribe the channel browser to live camera updates
- `8f87ab4` Enrich the single-channel metadata sidebar
- `e775c6d` Link empty channel cards to their last known plot
- `1a822fc` Add a sibling-channel strip and image-load spinner to the
  channel view
- `e6fe3a2` Show a loading spinner on channel grid cards

### 23. Path prefix, legacy redirects, shell header, site banners
Backend routing parity with V2 deployments plus the header work built on
it.
- `afd4a43` Serve the whole app under a configurable path prefix
- `a2e7985` Redirect legacy deep links to the new SPA routes
- `444eccc` Clarify metadata LRU cap is global, not per-camera
- `dc3bd98` Hoist the date picker into the shell header
- `2fec1f0` Add site processing banners and a non-prod header strip

### 24. Sub-apps: DDV websocket bridge + container-start builds
Replaces v2's start-daemon.sh: the DDV client/worker relay, plus a
start.sh entrypoint that builds DDV / installs exp_checker at container
start (kept at container start, as in v2, so pod restarts pick up new
DDV commits without an image rebuild).
- `fdbdff1` Replace v2's start-daemon steps: DDV bridge, image-time
  subapp builds
- `2967d0b` Build DDV at container start again, not at image build
- `c27fed0` Fix image build and exp_checker install found by a real
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
- `1f0e133` Incorporate location/camera/app logos as full-bleed buttons

---

## Part III — Packaging, CI and release

### 26. CI and dependency chores
- `ff7f010` Apply npm audit fix and ignore the Vite cache
- `9bcc7b0` Bump CI actions off the deprecated Node 20 runtime
- `6ebbbdd` Bump setup-uv off the deprecated Node 20 runtime
- `d6c757e` Inject X-Auth-User in the Vite dev proxy for local admin
  access

### 27. Version 3.0.0 + build provenance + image-build CI
Stamps the release: version 3.0.0 everywhere, git sha + commit date on
the Admin page (baked in as Docker build args — the runtime image has no
.git), and the V2-convention image-build CI job (tickets/**, deploy**,
develop, tags → ghcr). The drift-sync commit is mechanical (the
committed openapi.json/api-types had gone stale); review the feature
commit for the real schema change.
- `b65de07` Regenerate the stale openapi.json and api-types
- `29f585b` Bump to 3.0.0 and show git provenance on the Admin page

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
- `72ca084` Package as lsst.ts.rubintv for conda/EUPS install parity
- `54537a6` Fix pre-existing ruff errors in dev scripts
- `8014ed5` Fix pre-existing mypy errors exposed by the new check target
- `d3998b4` Document the tag-driven release procedure in the operator
  guide
- `0155e97` Adopt the TSSW pre-commit config for Jenkins CI
- `168493c` Conform doc lines and benchmark lambdas to the TSSW hooks
- `fcb1ae1` Make the test suite hermetic to the developer's AWS config
- `485711c` Survive Kubernetes service links and listen on 8080 in the
  container
- `8ea9cb4` Answer the readiness probe at bare / with a redirect into the
  prefix
- `4f716b9` Merge branch 'design-port' into conda-parity (brings the
  logos + dev-proxy header work into the packaging lineage)
- `121bdc7` Rewrap a merged doc line to the TSSW 79-char doc limit
- `6213513` Default the cache to /scratch and serve public assets from
  the SPA dist
- `a48c8ae` Redirect bare sub-app paths into their mounts; drop the
  header links
- `5e59bce` Stop reading RUBINTV_HOST/RUBINTV_PORT; host and port are
  flags only

---

## Part IV — Deployment iteration and consolidation

### 29. Fixes from running the deployed app
Polish and fixes found while iterating on the real phalanx deployment.
- `8f764d5` Show table floats to 3 decimal places instead of 2
- `0fd38b8` Rewrap the settings comment to the 79-char doc limit
- `310971c` Add shift-arrow channel navigation to the single-channel view
- `28fcefc` Surface S3 poll-cycle latency and link the header pill to
  Status
- `9c4d476` Regenerate openapi.json/api-types to catch up with landed
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
- `5c187f3` Document the branch model and main's protection ruleset
- `fe132cc` Nudge webhooks for Jenkins CI (no content)
- `b723a83` Merge branch 'deploy' into tickets/DM-55435
- `0cd9e5c` Merge branch 'redis-detector-seed' into tickets/DM-55435
  (resolution also fixes the seed test's monkeypatch target to the
  `lsst.ts.rubintv` module path and rewraps for W505)
- `2c87f6b` Drop the stacked-PR plan; DM-55435 lands as one reviewed
  merge
- Plan bookkeeping, docs-only (edits to the now-deleted
  `docs/pr-plan.md`): `e768300`, `3277c95`, `13069c6`, `12faf36`,
  `48ddd62`, `8364a93`, `fba07b6`, `540eebc`, `64cb792`, `7636242`,
  `8e5c46f`, `fab1a92`, `025f747`, `37c97a1`, `6184241`, `32f23cf`,
  `7e88159`

---

## Part V — Post-review fixes

### 32. Fixes from a post-implementation adversarial review
An adversarial review of the finished branch (backend concurrency, HTTP/WS
API, security, both frontend layers, build/deploy) surfaced a set of real
bugs — two of them silent and process-wide. Each commit is self-contained
and adds regression tests for what it fixes; review these commits directly
(their diffs are small and standalone, unlike the feature groups above).
Highest-risk items to scrutinise: the WebSocket-pump death and the
`site="local"` admin default in `3f82ac5`.

- `3f82ac5` Fix backend runtime, security, and API robustness bugs. The
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
- `ac58000` Fix frontend data-layer bugs: column prefs no longer leak/corrupt
  across cameras (the route doesn't remount on a param change); corrupt
  localStorage no longer crashes the table; numeric `=`/`between` filters
  compare by value (a leading `-` no longer breaks a range); WS reconnect
  refetches missed data; `staleTimeForDate` uses day_obs space; integers
  render without a spurious `.000`.
- `f2bd515` Fix frontend UI bugs: DatePicker "today" tracks the live
  observing day (was frozen at mount); selectable day cells are keyboard-
  operable; the newest-row highlight tracks max seq not visual row 0; image
  cards re-arm on a live frame swap; the Channel viewer resets its latch on
  rollover and no longer dead-ends on a missing seq; AllSky/Mosaic guard
  partial configs; stacked overlays close one Escape at a time.
- `58748a8` Use the non-deprecated `HTTP_416_RANGE_NOT_SATISFIABLE`
  constant (silences a Starlette deprecation warning from the Range fix).

Kept separate on purpose: `53d0b46` (ignore the `.vite` prebundled-dependency
cache in eslint) is a generated-cache config tidy, not a bug fix, so it is its
own commit and the fix commits stay pure. A handful of lower-severity review
findings were judged already-safe on closer inspection (SPA traversal guard,
legacy redirect, sort comparator).

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
