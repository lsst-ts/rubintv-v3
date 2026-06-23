# PR plan: splitting `design-port` for review

`design-port` has accumulated 45 commits ahead of `phase-8-real-config`.
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

---

## Notes for whoever splits these
- The stack must merge in order PR 1 → PR 9; each branch is cut from the tip of
  the previous one (PR 1 from `phase-8-real-config`).
- PRs 5 and 8 are iterative arcs where later commits rewrite earlier ones. They
  could be squashed per-PR if reviewers prefer the end state over the history.
- `ec7a6ac` (PR 9) bundles two concerns (the empty-table loading fix and the S3
  indicators). If a reviewer wants them separate it would need splitting at the
  commit level; left together here since it's a single atomic commit.
- This plan is descriptive of the current branch — regenerate the commit lists
  with `git log --oneline --reverse phase-8-real-config..design-port` if more
  work lands before the split.
