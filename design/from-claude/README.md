# Design hand-off from Claude Design

Source: claude.ai/design project **RubinTV** (`019ddecb-615e-7693-985e-b0aae8f8ffae`),
pulled down on 2026-06-16 to port into the real `web/` app component by component.

These are reference artifacts — **not** wired into the app. The port target is
`web/src/` on the `design-port` branch.

## Two distinct design languages

The project contains two aesthetics. **The hi-fi navy design is the one to port** —
it matches the channels-tab reference screenshot the user has been refining.

### 1. Hi-fi "Summit" design (navy + IBM Plex Serif) — PRIMARY
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
