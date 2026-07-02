# PR plan: splitting `design-port` for review

`design-port` has accumulated ~90 commits ahead of `phase-8-real-config`.
Reviewing them as one PR is impractical, so this file groups them into
reviewable, **stacked** branches: each branch builds on the previous, so they
must be opened and merged in order. The stack order below is dependency order,
not just thematic clustering.

Base branch: `phase-8-real-config`.

How to read each group: the heading is the proposed PR, the bullets are its
commits oldest-first (the order to cherry-pick).

---

## Stack order

### PR 1 — Backend: prune stale warm-start dates
Independent of the design work; could even go first on its own.
- `ba28985` Prune stale warm-start dates on full historical sweep

### PR 2 — Design foundation: tokens, theme, hand-off
Everything visual depends on these, so this is the base of the visual stack.
- `a0955cb` Stage RubinTV design hand-off from Claude Design
- `783a750` Port design tokens + theme switcher from Claude Design
- `3f634f2` Refresh design hand-off; sync theme-toggle to latest design

### PR 3 — App shell + per-view design ports
The shell (sidebar/tabs) plus the first pass restyling each view to the design.
- `7288262` Port app shell: collapsible sidebar + camera tabs (step 2)
- `72f8eee` Port channel view: browser + restyled exposure viewer (step 3)
- `302c944` Channels view: latest-frame card grid per channel
- `18b1d02` Make historical-scan banner a compact pill above the live indicator
- `fc64c93` Port CameraTable to the design: angled headers, chips, density (step 4)
- `e1cfcd2` Restyle Detectors + Status to the design (step 5)
- `7f20d7f` Restyle AllSky to the design's feed layout (step 6)
- `02fd13b` Port NightReport to the design's folder-tabbed layout (step 7)

### PR 4 — Column picker
Column-picker behaviour and the fixed-width fixes it surfaced.
- `d30c03e` Tidy CameraTable empty state when a date has no data
- `e69e3a0` Dismiss the column picker on outside click or Escape
- `fae41ec` Remove column-picker open lag by keeping its rows mounted
- `232d8df` Fix column-picker open lag at the source: memoize + isolate the table
- `a969b12` Add the column-picker header (title/count/search/all-none-reset) + real defaults
- `5ada0b9` Fix stretched channel columns with fixed per-column widths
- `4bc058a` Keep column widths fixed when few columns are visible
- `2938ea1` Add toolbar/button icons and fix the 404 rubin-mark asset

### PR 5 — Date picker + heatmap
An iterative arc (several commits rewrite earlier ones); reads best as one PR.
- `3464126` Implement the two-month calendar date picker
- `f393efc` Replace date picker with a year-heatmap overview + calendar counts
- `5eeaaaf` Date picker: two-month + heatmap views with a fixed tint ramp
- `aab7bc8` Date picker: calendar orientation for the heatmap + max seq in month cells
- `a5b4449` Date picker: drop per-seq dots, 6-across heatmap, binary All Sky heatmap
- `48f127a` Heatmap: alternating year stripes + day-selects / month-jumps split
- `928daec` Heatmap: whole mini-month is the month-jump target; distinguish day vs seq

### PR 6 — Table cells, headers, action columns
Per-cell styling and the action-column icon/confirmation work.
- `9cfebc6` Show channel titles in the camera table header, not ref names
- `2e62aad` Blank action-column headers + per-cell colour-class from _<col> indicators
- `02b84df` Add per-cell colour-flag styles from the original app's palette
- `d2362cb` Replace table action-column text with icons
- `a1e98bd` Narrow action columns + check-mark copy confirmation
- `eb273b5` Render object/array metadata cells as a foldout modal
- `7b1dda7` Simplify table density to two sizes with larger, lighter headers

### PR 7 — Table filtering + header controls
The metadata filter, control layout, steppers, and header clocks.
- `5965549` Implement the table metadata filter from the design
- `797be84` Move Columns + Filter controls between Copy link and Download metadata
- `55b1ae6` Open the Columns popover down-and-right, not leftward
- `ca364d4` Add prev/next-day stepper buttons around the date picker
- `acf4d5c` Add UTC clock + per-camera time-since-last clock to the table header

### PR 8 — Seq.No URL filter
Another iterative arc landing on the `?seq_filter` catch-all + its docs.
- `5c5dafe` Support a URL seq range (?seqMin/?seqMax) as removable filter chips
- `2b622a7` Make all Seq.No filter operators work, not just the URL range
- `d2eb6cf` Add ?seqNum= URL param for a single-seq filter; mirror it in the URL
- `2c0b3ac` Replace seq URL params with one catch-all ?seq_filter for all operators
- `d5d78e4` Make seq_filter URL-readable: spelled tokens, no percent-encoding
- `2f93679` Document the seq_filter URL parameter in a new viewer guide

### PR 9 — Loading state fix + S3 connectivity indicators
- `ec7a6ac` Fix empty-table loading state and add S3 connectivity indicators

### PR 10 — Header, nav and chrome polish
Small independent UI fixes to the shell chrome; low review risk.
- `de6a2d3` Remove appearance controls from the main-page gutter
- `2dbca79` Add vector Rubin mark and tidy the header status row
- `ba71c34` Highlight Channels tab on channel pages, drop doubled live dot
- `676ff9a` Pad the topbar bottom on pages without a tabs row
- `f32e9a8` Add tooltip explaining the live indicator's states
- `d25b952` Make breadcrumbs read as breadcrumbs with › separators
- `0f8ea6a` Give RubinMark intrinsic size to prevent logo flash on refresh

### PR 11 — Liveness cues across views
Everything that signals "is this the live observing day / is this fresh":
- `7919ae5` Dim channel cards that lag the night's seq frontier
- `38c8d44` Show whether Channels cards are the live observing day
- `9147926` Tint the table date chip by observing-day state
- `106a2d0` Pass isCurrentDayObs to the All Sky date chip
- `ac7ed49` Show camera dots as stale when no data for the current day
- `4611d5a` Reflect S3 unreachable in the historical-refresh pill

### PR 12 — All Sky, Mosaic and live-view cameras
- `8a88f25` Drop Table/Channels tabs for live-view cameras
- `cf7601a` Let All Sky frames fill the stage
- `68f5f33` Shrink All Sky frames to the image on short pages
- `751dbf5` Autoplay and loop the All Sky movie
- `bb4c3f6` Make Mosaic a live, embeddable view; drop obsolete has_mosaic flag

### PR 13 — Camera table: virtualization, sorting, config-locked columns
- `20db80d` Virtualize camera table rows and clip overhanging headers
- `86564d9` Let cell colour flags show through the newest-row highlight
- `e705206` Drive locked metadata columns from config
- `ae2e081` Add ascending/descending sort to orderable table columns
- `632b22c` Pin camera table scroll position during live updates
- `b7b6194` Floor @tanstack/virtual-core at >=3.16.0 for anchorTo
- `74a39d4` Cap cell-modal key column so short values aren't shredded

### PR 14 — Channel view enrichment
- `e58d0b3` Subscribe the channel browser to live camera updates
- `8f87ab4` Enrich the single-channel metadata sidebar
- `e775c6d` Link empty channel cards to their last known plot
- `1a822fc` Add a sibling-channel strip and image-load spinner to the channel view
- `e6fe3a2` Show a loading spinner on channel grid cards

### PR 15 — Path prefix, legacy redirects, shell header, site banners
Backend routing parity with V2 deployments plus the header work built on it.
- `afd4a43` Serve the whole app under a configurable path prefix
- `a2e7985` Redirect legacy deep links to the new SPA routes
- `444eccc` Clarify metadata LRU cap is global, not per-camera
- `dc3bd98` Hoist the date picker into the shell header
- `2fec1f0` Add site processing banners and a non-prod header strip

### PR 16 — Sub-apps: DDV websocket bridge + container-start builds
Replaces v2's start-daemon.sh: the DDV client/worker relay, plus a start.sh
entrypoint that builds DDV / installs exp_checker at container start (kept
at container start, as in v2, so pod restarts pick up new DDV commits
without an image rebuild).
- `fdbdff1` Replace v2's start-daemon steps: DDV bridge, image-time subapp builds
- `2967d0b` Build DDV at container start again, not at image build

### PR 17 — CI and dependency chores
Could also be folded into whichever PR is open when splitting.
- `ff7f010` Apply npm audit fix and ignore the Vite cache
- `9bcc7b0` Bump CI actions off the deprecated Node 20 runtime
- `6ebbbdd` Bump setup-uv off the deprecated Node 20 runtime

### PR 18 — Package as `lsst.ts.rubintv` for conda/EUPS install parity
Repackages the app the way lsst-ts builds and deploys V2: relocates the backend
to `python/lsst/ts/rubintv/`, adds the conda/EUPS/Jenkins scaffolding, the
`run_rubintv` entry point, and a GHCR image-build CI job. Depends on the whole
app being in place, so it sits last in the stack — currently based on
`design-port`, to retarget to `phase-8-real-config` once PRs 1–17 merge.
Open as a stacked PR on branch `conda-parity` (rename to a `tickets/DM-NNNNN`
branch once a ticket exists — see Notes).
- `6ee0860` Package as lsst.ts.rubintv for conda/EUPS install parity
- `562d0f4` Fix pre-existing ruff errors in dev scripts
- `4f9d104` Fix pre-existing mypy errors exposed by the new check target

---

## Notes for whoever splits these
- The stack must merge in order PR 1 → PR 18; each branch is cut from the tip of
  the previous one (PR 1 from `phase-8-real-config`). PR 18 is the packaging
  layer and depends on the full app, so it merges last.
- Commit order across groups 10–17 is thematic, not chronological, so
  cherry-picks may conflict where themes touched the same files; resolve in
  stack order or fall back to chronological grouping if it gets painful.
- Plan-upkeep commits (`e768300`, `3277c95`, `13069c6`, `12faf36`, and this
  update) are docs-only; fold them into any convenient PR.
- Branch naming: lsst-ts uses `tickets/DM-NNNNN`, and that prefix is what
  triggers the GHCR image-build CI job. Create branches with the ticket name
  up front — do **not** rename later, since renaming a branch closes its PR and
  orphans anything stacked on top. `conda-parity` (PR 18) keeps its descriptive
  name only until a DM ticket exists, at which point cut a fresh
  `tickets/DM-NNNNN` branch + new PR rather than renaming.
- PRs 5 and 8 are iterative arcs where later commits rewrite earlier ones. They
  could be squashed per-PR if reviewers prefer the end state over the history.
- `ec7a6ac` (PR 9) bundles two concerns (the empty-table loading fix and the S3
  indicators). If a reviewer wants them separate it would need splitting at the
  commit level; left together here since it's a single atomic commit.
- This plan is descriptive of the current branch — regenerate the commit lists
  with `git log --oneline --reverse phase-8-real-config..design-port` if more
  work lands before the split.
