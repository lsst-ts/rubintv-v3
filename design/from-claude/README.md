# Design hand-off from Claude Design

Source: claude.ai/design project **RubinTV** (`019ddecb-615e-7693-985e-b0aae8f8ffae`),
pulled down to port into the real `web/` app component by component.

These are reference artifacts — **not** wired into the app. The port target is
`web/src/` on the `design-port` branch.

**Refresh 2026-06-17:** re-pulled because the design changed. Only the v2 page
changed; tokens identical. Theme toggle moved out of the top-bar into (a) a pinned
sidebar footer (`.sidebar-foot`, "Appearance" label) when the sidebar is open, and
(b) a **vertical** variant (`.theme-seg.vertical`) in the collapsed-sidebar left
gutter (`.topbar-leftgutter`) under the reopen button. Collapsed brand block is now a
single inline row (logo mark + "RubinTV"). ThemeToggle gained a `vertical` prop. New
ref screenshots: `01-collapsed-camera.png`, `02-collapsed-camera.png`. The ported
ThemeToggle component is correct as-is; this placement lands in the Step-2 shell.

## Design language hierarchy (THREE iterations — most recent wins)

The project evolved through three aesthetics. **`Camera Table - Sidebar v2.html` is
the canonical, most-evolved design** and its inline `:root` (line ~1721) is the real
token set to port. Its own header comment says it *"supersedes the wireframe tokens."*

### 0. v2 camera-table — CANONICAL (light: white + charcoal + teal, Space Grotesk)
- `Camera Table - Sidebar v2.html` (~170KB, all inline) — the full production-grade app:
  collapsible sidebar shell, breadcrumbs, home/location landing pages, channel-within-table
  view, exposure data table (sticky seq col, 5 header styles: angled/vertical/stacked/wrap/
  ellipsis), date picker (classic / two-month / nights variants), column picker, filter
  system + chips, foldout object cells, all-sky feed view.
- **Tokens (port these):** `--paper #ffffff`, `--paper-2 #f5f8f9`, `--paper-3 #ebeff1`,
  `--ink #23282d`, `--ink-2 #4b525a`, `--ink-soft #828b93`, `--line-soft #e3e8ea`,
  `--line-mid #ccd3d7`, `--stroke #23282d`, `--accent #0a8d93` (teal links/focus),
  `--accent-bright #00bbc6` (cyan live/dots), `--accent-soft #ddf1f2`, `--accent-line #8ad6da`,
  `--warn #d97a2f`, `--good #1f9d63`, `--hand 'IBM Plex Sans'`,
  `--display 'Space Grotesk'`, `--mono 'IBM Plex Mono'`, `--sans 'IBM Plex Sans'`,
  plus `--shadow-card` / `--shadow-pop`.
- The base `styles.css` (`.btn`/`.tag`/`.chip`/`.s-*` etc.) is still used, but this page's
  inline `<style>` overrides its `:root` and restyles `.btn`/`.tag` for the light theme.

### 1. Hi-fi "Summit" design (navy + IBM Plex Serif) — superseded, channels only
- `channels-styles.css` — the design system: dark navy (`--bg #0F1424`), cream text,
  warm "sun" accent (`--sun #E6B065`), IBM Plex Serif/Sans/Mono. Component classes:
  `.ch-topbar`, `.ch-brand` (sun logo + memorial), `.ch-hero`, `.ch-tabs`, `.placeholder`,
  `.tag`/`.tag-active`/`.tag-standby`/`.tag-live`, `.section-h`, `.toolbar`, `.tb-btn`.
- `channels-chrome.jsx` — `CHTopBar` (top nav + brand + Simon Krughoff memorial) and
  `CHCameraHero` (camera title, status pill, day-obs/UTC/since-last clocks, tab bar).
- `channels-layouts.jsx` — four Channels-tab explorations:
  - **A** Latest-frame grid (matches reference) · **B** Featured viewer + rail ·
    **C** Grouped sidebar list + viewer · **D** Contact sheet.
- `channels-data.js` — `RUBIN_CAMERA` + `RUBIN_CHANNELS` (9 channels) + groups. Sourced
  from the app's `config/models_data.yaml`.
- `Channels Tab.html` — the harness that renders A–D as artboards.

### 2. Sketch/wireframe design (paper + Kalam hand-font) — exploratory
- `styles.css` — hand-drawn wireframe kit (`--paper`, `--ink`, `--hand: Kalam`). Lower
  fidelity; the navy design supersedes it. Useful only for layout ideas.
- `camera-table.jsx` — 4 camera-table variations (A refined / B sidebar / C stream / D split).
- `detectors.jsx` — 4 cluster-status variations (mosaics, health tiles, focal plane, ops dash).
- `allsky.jsx` — 4 All-Sky variations (two-up, hero+timeline, calendar, conditions).
- `real-columns.js` — real metadata column schema (~150 keys) from `ra_performance_*.json`.
  Staged copy is truncated to a representative subset.

## Claude Design tooling — IGNORE for port
- `design-canvas.jsx`, `tweaks-panel.jsx` — the Figma-ish canvas + edit-mode tweaks panel
  that the HTML harnesses use to display artboards. This is claude.ai/design's own
  scaffolding, not part of the RubinTV design. Do not port.

## Not staged here (read on demand from the project)
- `screenshots/*.png` — visual references. Read directly via the design project when
  porting a given view (channels-tab.png is the key one for the navy design).
- `assets/*.png` — rubin logos (`rubin-logo-dark.png`, `rubin-logo.png`, `rubin-mark.png`).
- `uploads/*` — the user's source material (incl. `models/models_data.yaml`).

## Map to real app views (`web/src/views/`)
| Design artifact            | Real view                          |
|----------------------------|------------------------------------|
| channels-layouts (A–D)     | `Channel.tsx`                      |
| channels-chrome            | `Layout.tsx` (header/nav/memorial) |
| camera-table (A–D)         | `CameraTable.tsx`                  |
| detectors (A–D)            | `Detectors.tsx` / `Status.tsx`     |
| allsky (A–D)               | `AllSky.tsx`                       |
| (night report)             | `NightReport.tsx`                  |
