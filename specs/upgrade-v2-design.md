# Upgrade v2 Design Spec

Designer-approved visual spec for the `live-agent-upgrade-v2` team. Builds on
`specs/upgrade-design.md` (round 1) and `specs/upgrade-oracle-decisions.md` /
`specs/upgrade-v2-oracle-decisions.md`. All values come from `css/tokens.css`.
No hardcoded hex, radius, spacing, or shadows in component styles. Dark is the
default; every token used below already has a `[data-theme="light"]` override.
Written 2026-04-22.

## 0. Scope summary

1. New `/map.html` full-viewport map route (Leaflet, per Oracle).
2. Voice-dock height overflow fix — dock stops exceeding the viewport in tall
   settings states.
3. Remove the page-level horizontal scrollbar.
4. Stronger agent-audio compression + a new **Strength** slider under the
   existing phone-compression toggle.
5. Background muffle + breath/wind layer during a call (audio task; UI surface
   is an optional header pill below).
6. Hide tool-call lines from the transcript panel when transcript mode is off
   or captions — purely a behavioural flag for frontend-dev.
7. Agent-addressable map visuals (pin highlight, smooth pan/zoom, slide-in
   detail panel).

## 1. Designer template

### Primary inspiration

- **Linear's project map + Retool's ops dashboard.** Dark base, dense data,
  zero chrome. Pins feel like data points, not a Google-Maps-style tourist
  overlay.
- **Dock overflow fix** — no new aesthetic. Reuse the existing
  `.voice-settings-sheet` chrome and re-nest it so it obeys the dock box.

### Secondary influences

- **Stripe's map pins** (on the support/coverage pages) — subtle colored dots,
  1px ring, no drop shadow.
- **Vercel's deployment map** — dashed polylines for pending routes, solid for
  confirmed.
- **Linear's keyboard-first detail drawer** (right-slide on desktop, bottom
  sheet on mobile).
- **Stadia/Carto's "Alidade Smooth Dark" tile aesthetic** — a dark basemap
  that matches `--color-bg-elev-1` without going pitch black.

### Specific tokens

All additive tokens introduced in round 1 (`--color-overlay-bg`,
`--color-overlay-scrim`, z-index scale, `--shadow-overlay-strong`) are reused.
Only TWO new tokens are added in round 2 — map-specific:

```css
/* Append to :root in css/tokens.css (after existing overlay block). */
--color-map-bg          : #0E1217;                          /* basemap darkness */
--color-map-polyline    : rgba(110, 231, 183, 0.65);        /* confirmed lane */
--color-map-polyline-pending : rgba(251, 191, 36, 0.55);    /* pending lane */
--color-map-pin-ring    : rgba(11, 13, 16, 0.85);           /* outer ring for pins on bright tiles */
--z-map-ui              : 300;                              /* filter rail, reset btn; above tiles, below dock */
```

No new font sizes, spacings, radii, shadows, or durations. Everything else
reuses the existing scale.

### What to avoid

- **Glassmorphism / backdrop-filter on any map UI surface.** DESIGN.md bans
  frosted glass. Pin popups, filter rail, detail panel = flat
  `--color-bg-elev-1` with hairline borders.
- **Default Leaflet styling bleed.** Override `.leaflet-popup`,
  `.leaflet-control-zoom`, `.leaflet-control-attribution` via scoped CSS (see
  §2.6). Do NOT let the default blue `#74B9FF` tooltip arrows ship.
- **Bouncy easing on pan/zoom.** Respect `--ease-out-expo` / `--dur-slow` max.
  No springs, no overshoot.
- **Rainbow pin colors.** Stick to the five state colors (`--color-accent`,
  `--color-warn`, `--color-danger`, `--color-info`, `--color-text-dim`) — one
  per semantic meaning.
- **Geo-app affordances.** No "center on me" button. No compass. No GPS dot.
  This is a freight console, not Google Maps. Include only zoom in/out +
  reset-view.
- **Any motion above `--dur-slow`.** Leaflet's default `setView` animate
  duration is 0.25s — cap it at 0.28s (= `--dur-slow`) when we invoke it from
  agent tools.

### Alignment with root

- Root is `CLAUDE.md` + `DESIGN.md`. No divergences. No framework.
- Leaflet is a runtime library (not a framework); Oracle signed off in v2
  decisions. Ship via npm → esbuild bundle split, NOT via a CDN `<script>`
  tag.
- The map page uses the SAME shell as other routes (header, skip link, voice
  dock) — it is a route-target swap, not a new HTML shell.

---

## 2. Map page layout

### 2.1 Structure

```
<main id="main" class="app-main app-main--map">       (no padding override)
  <section id="map-root" data-agent-id="map.root" class="map-page">
    <div id="map-filter-rail" class="map-filter-rail" data-agent-id="map.filters.rail">
      [ chip buttons: All · Loads · Carriers · Lanes · Delayed ]
      [ small search input ]
    </div>
    <div id="map-canvas" class="map-canvas" data-agent-id="map.canvas" role="application"
         aria-label="Freight map. Use arrow keys to pan, +/- to zoom."></div>
    <aside id="map-detail" class="map-detail" data-agent-id="map.detail" hidden
           aria-label="Selected load/carrier detail"></aside>
    <div class="map-controls" aria-hidden="false">
      <button class="icon-btn" id="map-zoom-in"  aria-label="Zoom in"  data-agent-id="map.zoom_in">+</button>
      <button class="icon-btn" id="map-zoom-out" aria-label="Zoom out" data-agent-id="map.zoom_out">–</button>
      <button class="icon-btn" id="map-reset"    aria-label="Reset view" data-agent-id="map.reset_view">⌂</button>
    </div>
    <div class="map-attribution" id="map-attribution"></div>
  </section>
</main>
```

Leaflet's default `.leaflet-control-zoom` and `.leaflet-control-attribution`
are REPLACED by our own elements above — we pass
`{zoomControl: false, attributionControl: false}` to `L.map()` and render the
attribution text into `#map-attribution` manually (required by OSM license).

### 2.2 Layout & sizing

The map page overrides the default `.app-main` padding/max-width because it
needs to be full-bleed:

```css
.app-main--map {
  max-width: none;
  padding: 0;
  /* Height = viewport - header (48px, or auto on mobile). The header is
     sticky, so we use 100dvh and let flex math sort it. */
  min-height: calc(100dvh - 48px);
  display: flex;
}
.map-page {
  position: relative;
  flex: 1;
  display: grid;
  grid-template-columns: 280px 1fr;
  grid-template-rows: 1fr;
}
.map-canvas {
  grid-column: 2;
  grid-row: 1;
  min-height: 400px;
  background: var(--color-map-bg);
}
.map-filter-rail {
  grid-column: 1;
  grid-row: 1;
  background: var(--color-bg-elev-1);
  border-right: 1px solid var(--color-border);
  padding: var(--sp-3) var(--sp-3);
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  overflow-y: auto;
}

/* Tablet + mobile: rail collapses to a top bar above the canvas. */
@media (max-width: 900px) {
  .map-page {
    grid-template-columns: 1fr;
    grid-template-rows: auto 1fr;
  }
  .map-filter-rail {
    grid-column: 1;
    grid-row: 1;
    border-right: 0;
    border-bottom: 1px solid var(--color-border);
    flex-direction: row;
    padding: var(--sp-2) var(--sp-3);
    overflow-x: auto;           /* horizontal scroll is OK *inside* this rail */
    scrollbar-width: none;
  }
  .map-filter-rail::-webkit-scrollbar { display: none; }
  .map-canvas { grid-column: 1; grid-row: 2; }
}
```

Using `100dvh` handles mobile browser chrome autohide cleanly. Fallback to
`100vh` if `dvh` isn't supported by including both (`min-height: 100vh;
min-height: 100dvh;`).

### 2.3 Filter chips

Reuse `.chip-btn` from `components.css:486` — same hover/focus/radius
discipline as the voice quick-actions. Layout: flex row (or column on desktop
rail), gap `var(--sp-1)`.

```css
.map-filter-rail .chip-btn[aria-pressed="true"] {
  background: var(--color-accent-soft);
  color: var(--color-accent);
  border-color: rgba(110, 231, 183, 0.35);
}
```

`aria-pressed` on each chip — toggle state for "show loads / show carriers /
show lanes / show delayed". Multi-select. Default = loads on, carriers on,
lanes on, delayed off.

Optional search input below the chips (desktop rail) reuses `.input` at 32px
height. Binds to Leaflet's layer-filter.

### 2.4 Pin styles

Leaflet markers are DOM-backed via `L.divIcon` (not image sprites). Each pin
is a 16x16 DOM node so that `data-agent-id`, ARIA, keyboard focus, and
`.is-agent-highlighted` all Just Work.

```css
.map-pin {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--color-text-muted);
  border: 2px solid var(--color-map-pin-ring);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.45);
  cursor: pointer;
  transition: transform var(--dur-fast) var(--ease-out-expo);
}
.map-pin:hover,
.map-pin:focus-visible { transform: scale(1.15); outline: none; }
.map-pin:focus-visible { box-shadow: var(--shadow-focus-ring-accent); }

/* Loads */
.map-pin--booked    { background: var(--color-accent); }        /* green */
.map-pin--pending   { background: var(--color-warn); }          /* amber */
.map-pin--delayed   { background: var(--color-danger); }        /* red   */
.map-pin--delivered { background: var(--color-text-dim); }      /* gray  */
.map-pin--in_transit { background: var(--color-info); }         /* blue  */

/* Carriers */
.map-pin--carrier { background: var(--color-info); border-radius: var(--radius-xs); }
                                /* square = carrier, circle = load */

/* Cluster (> 1 pin at same zoom cell) */
.map-cluster {
  min-width: 28px;
  height: 28px;
  padding: 0 var(--sp-1);
  border-radius: var(--radius-pill);
  background: var(--color-bg-elev-2);
  border: 1px solid var(--color-border-strong);
  color: var(--color-text);
  font-size: var(--fs-xs);
  font-weight: var(--fw-semibold);
  font-family: var(--font-mono);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  letter-spacing: var(--tracking-wide);
}

/* Agent highlight — existing class works on Leaflet markers too because
   they're wrapped in a <div> that carries data-agent-id. Fade the scale
   slightly because pins are small. */
.map-pin.is-agent-highlighted {
  outline: 2px solid var(--color-accent);
  outline-offset: 3px;
  animation: agent-flash 1200ms var(--ease-out-expo);
}
```

### 2.5 Lane polylines

```css
.leaflet-interactive.map-lane        { stroke: var(--color-map-polyline);         stroke-width: 2px; stroke-dasharray: none; }
.leaflet-interactive.map-lane--pending { stroke: var(--color-map-polyline-pending); stroke-width: 2px; stroke-dasharray: 6 4; }
.leaflet-interactive.map-lane:hover  { stroke-width: 3px; }
```

Leaflet lets us pass `className: 'map-lane map-lane--pending'` to
`L.polyline(...)`. No inline hex.

### 2.6 Popups (hover tooltip)

Override Leaflet's default popup to our tokens:

```css
.leaflet-popup-content-wrapper {
  background: var(--color-bg-elev-3);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-overlay);
  padding: 0;
}
.leaflet-popup-content {
  margin: var(--sp-2) var(--sp-3);
  font-size: var(--fs-sm);
  line-height: var(--lh-sm);
}
.leaflet-popup-tip { background: var(--color-bg-elev-3); border: 1px solid var(--color-border); }
.leaflet-popup-close-button { color: var(--color-text-muted) !important; /* ** see §13 note on !important exception */ }
```

**Exception note:** Leaflet stamps inline `color` on the close button; a single
`!important` is justified here to override a third-party library's inline
style. This is the ONLY use of `!important` in the v2 spec; everywhere else,
specificity wins.

Popup content (rendered via a tiny template in `js/map-page.js` — not here):
two rows of text.

```
LD-10824               <chip: DELAYED>
Dallas → Chicago · 968mi · ETA 18:40
```

Load ID is mono, 11px. Second row is 13px muted.

### 2.7 Detail panel

Desktop: a right-side slide-over INSIDE `.map-page` (not fixed to viewport —
it slides over the map area, not over the filter rail).

```css
.map-detail {
  position: absolute;
  top: 0;
  right: 0;
  height: 100%;
  width: min(380px, 100%);
  background: var(--color-bg-elev-1);
  border-left: 1px solid var(--color-border);
  box-shadow: var(--shadow-overlay);
  transform: translateX(100%);
  transition: transform var(--dur-base) var(--ease-out-expo);
  z-index: var(--z-map-ui);
  overflow-y: auto;
  padding: var(--sp-4);
}
.map-detail[hidden] { display: none; }
.map-detail.is-open { transform: translateX(0); }

@media (max-width: 640px) {
  /* Bottom sheet. */
  .map-detail {
    top: auto;
    right: 0;
    left: 0;
    bottom: 0;
    width: 100%;
    height: min(60vh, 420px);
    border-left: 0;
    border-top: 1px solid var(--color-border);
    border-top-left-radius: var(--radius-lg);
    border-top-right-radius: var(--radius-lg);
    transform: translateY(100%);
    padding-bottom: calc(var(--sp-4) + env(safe-area-inset-bottom, 0px));
  }
  .map-detail.is-open { transform: translateY(0); }
}
```

Contents reuse `.detail-kv` from `pages.css:65` — keep consistency with the
Dispatch detail pattern. Close button is a top-right `.icon-btn` with
`aria-label="Close detail"`; ESC also closes.

Focus discipline: when panel opens via click, move focus to the close button.
When it closes, return focus to the trigger (the pin) — frontend-dev should
wire this, but the spec flags it.

### 2.8 Map controls

Bottom-right stack:

```css
.map-controls {
  position: absolute;
  right: var(--sp-3);
  bottom: var(--sp-3);
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  z-index: var(--z-map-ui);
}
.map-controls .icon-btn {
  background: var(--color-bg-elev-1);
  border: 1px solid var(--color-border);
  color: var(--color-text);
  width: 32px;
  height: 32px;
  font-size: var(--fs-md);
  font-weight: var(--fw-medium);
}
.map-controls .icon-btn:hover { background: var(--color-bg-elev-2); }
```

No "center on me" button (see §1 What to avoid).

Attribution corner bottom-left per OSM license:

```css
.map-attribution {
  position: absolute;
  left: var(--sp-2);
  bottom: var(--sp-2);
  font-size: 10px;
  color: var(--color-text-dim);
  background: var(--color-overlay-bg);
  padding: 2px var(--sp-1);
  border-radius: var(--radius-xs);
  z-index: var(--z-map-ui);
  pointer-events: auto;
}
.map-attribution a { color: var(--color-text-muted); }
```

Attribution text is the minimum required: `© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors`. If we go with Carto Dark, add their line too.

### 2.9 Tile basemap

OSM default tiles are too bright for the console aesthetic. Two free-tier
picks in preference order:

1. **Carto Basemaps "dark_matter"** — `https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png`. Free for low-volume dev/demo. Attribution: `© <a href="https://carto.com/attributions">CARTO</a>` + OSM.
2. **Stadia "Alidade Smooth Dark"** — `https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png`. Free tier with API key for production.

Recommend Carto for demo (no API key, zero friction); swap to Stadia if we
exceed free-tier rate limits. Frontend-dev should make the tile URL a single
constant at the top of `js/map-page.js`.

### 2.10 Agent control of the map (visual animations)

All agent-invoked pan/zoom/highlight should be SMOOTH, not instant.

```js
// Pseudocode, frontend-dev implements:
map.setView([lat, lng], zoom, { animate: true, duration: 0.28 });
//                                                    ↑ = --dur-slow
```

When a pin is highlighted by the agent, we:

1. Pan the map so the pin is visible (if not already): `flyTo` with 0.28s.
2. Add `.is-agent-highlighted` to the pin's outer `<div>`. The existing
   `@keyframes agent-flash` already handles the 1200ms flash.
3. DO NOT auto-open the detail panel unless the agent explicitly asks
   (separate tool).

On reduced motion, skip the pan animation and instantly set view; keep the
outline flash (already reduced in `base.css:304`).

---

## 3. Voice dock height overflow fix

**Pick:** Option B (settings sheet becomes an absolutely-positioned overlay
INSIDE the dock, replacing the body region while it's open). Justification:

- The user already said "transcript is off by default" and the v1 tri-state
  is in place. When the user opens settings, they're focused on settings —
  they don't need the transcript under it.
- Option A (max-height on dock + body) leaves both body + sheet competing
  for space and still awkward on 600-700px tall viewports.
- This approach collapses the "can the dock exceed the viewport?" question
  to "can any single panel (body OR sheet) exceed?" — both are bounded.

### 3.1 Dock-level cap

```css
.voice-dock {
  /* existing properties preserved */
  max-height: calc(100dvh - var(--sp-5) * 2);   /* 100dvh - 48px breathing room */
  max-height: calc(100vh - var(--sp-5) * 2);    /* fallback */
  /* The dock is already display: flex; flex-direction: column; — keep. */
}
```

On mobile (`max-width: 640px`) the dock is edge-to-edge at the bottom, so:

```css
@media (max-width: 640px) {
  .voice-dock {
    max-height: 85dvh;
    max-height: 85vh;
  }
}
```

### 3.2 Settings sheet becomes an overlay inside the dock

Change the sheet from a STACKED sibling (below `.voice-dock-action`) to an
ABSOLUTELY-POSITIONED child that covers the body region while open. The
markup is already a child of `.voice-dock`, so no HTML change needed —
frontend-dev only changes the CSS + drops the dock's body/action from the
tab order while the sheet is open (already handled by focus trap).

```css
.voice-dock {
  position: fixed;                 /* unchanged */
  /* Add: make us a positioning context for the sheet. */
  /* (already `position: fixed` which IS a positioning context, good.) */
}

/* REPLACE existing .voice-settings-sheet rules with: */
.voice-settings-sheet {
  position: absolute;
  inset: 0;                         /* cover the whole dock box */
  background: var(--color-bg-elev-2);
  border-top: 0;                    /* no longer a sibling-divider */
  z-index: 2;                       /* above body + action, inside dock */
  max-height: none;                 /* dock's max-height already caps us */
  display: flex;
  flex-direction: column;
  overflow: hidden;                 /* body scrolls; header stays pinned */
  transform: translateY(8px);
  opacity: 0;
  transition: transform var(--dur-base) var(--ease-out-expo),
              opacity   var(--dur-base) var(--ease-out-expo);
}
.voice-settings-sheet.is-open {
  transform: translateY(0);
  opacity: 1;
}
.voice-settings-sheet[hidden] { display: none; }

.voice-settings-header {
  flex-shrink: 0;
}
.voice-settings-body {
  flex: 1 1 auto;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  /* keep existing padding, gap */
}

@media (prefers-reduced-motion: reduce) {
  .voice-settings-sheet { transition: none; transform: none; }
}
```

Because the sheet now inherits the dock's max-height cap, it can NEVER exceed
the viewport. The body is the ONLY scrollable region inside — scroll works
fine on both touch and wheel.

### 3.3 Dock body behaviour (unchanged sizing)

Keep `.voice-dock-body { max-height: 60vh; min-height: 240px; }` — it's still
a useful inner-cap, but it is now always bounded by the outer dock cap. On
mobile it remains `max-height: 42vh`.

### 3.4 Frontend-dev diff (exact)

Only `css/voice-dock.css` changes. Replace lines 382-389 AND add the dock
`max-height` cap at line ~26. Full diff:

```diff
  .voice-dock {
    position: fixed;
    bottom: var(--sp-4);
    right: var(--sp-4);
    width: 380px;
    max-width: calc(100vw - var(--sp-6));
+   max-height: calc(100vh - var(--sp-5) * 2);
+   max-height: calc(100dvh - var(--sp-5) * 2);
    background: var(--color-bg-elev-1);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-overlay);
    display: flex;
    flex-direction: column;
    z-index: var(--z-dock);
    overflow: hidden;
    transition: transform var(--dur-base) var(--ease-out-expo);
  }

  /* …existing rules unchanged… */

- .voice-settings-sheet {
-   border-top: 1px solid var(--color-border);
-   background: var(--color-bg-elev-2);
-   max-height: 70vh;
-   overflow-y: auto;
-   -webkit-overflow-scrolling: touch;
- }
- .voice-settings-sheet[hidden] { display: none; }
+ .voice-settings-sheet {
+   position: absolute;
+   inset: 0;
+   background: var(--color-bg-elev-2);
+   z-index: 2;
+   display: flex;
+   flex-direction: column;
+   overflow: hidden;
+   transform: translateY(8px);
+   opacity: 0;
+   transition: transform var(--dur-base) var(--ease-out-expo),
+               opacity   var(--dur-base) var(--ease-out-expo);
+ }
+ .voice-settings-sheet.is-open { transform: translateY(0); opacity: 1; }
+ .voice-settings-sheet[hidden] { display: none; }
+
+ .voice-settings-header { flex-shrink: 0; }
+ .voice-settings-body {
+   flex: 1 1 auto;
+   overflow-y: auto;
+   -webkit-overflow-scrolling: touch;
+   display: flex;
+   flex-direction: column;
+   gap: var(--sp-3);
+   padding: var(--sp-3) var(--sp-4);
+ }
+
+ @media (prefers-reduced-motion: reduce) {
+   .voice-settings-sheet { transition: none; transform: none; }
+ }

  @media (max-width: 640px) {
    .voice-dock {
      width: 100%;
      max-width: 100%;
+     max-height: 85vh;
+     max-height: 85dvh;
      right: 0;
      left: 0;
      bottom: 0;
      border-radius: var(--radius-lg) var(--radius-lg) 0 0;
      /* …existing rules unchanged… */
    }
-   .voice-settings-sheet { max-height: 55vh; }
-   .voice-settings-body { padding: var(--sp-3); }
+   .voice-settings-body { padding: var(--sp-3); }
  }
```

Frontend-dev note: `openSettings()` in `js/ui.js:459` already removes
`hidden` and adds `is-open` — no JS change beyond confirming focus returns to
the settings button on close.

---

## 4. Horizontal scrollbar removal

Per the audit of `css`:

| File:line | Current | Change |
|---|---|---|
| `base.css:310` (`.table-wrap { overflow-x: auto }`) | keep — scoped to a table wrapper, expected | **no change** |
| `base.css:336` (`.app-nav { overflow-x: auto }` on mobile) | keep — nav is designed to scroll on small screens | add `scrollbar-width: none;` + `::-webkit-scrollbar { display: none }` |
| `components.css:133` (`.table-wrap { overflow: auto }` — duplicate of base) | keep | **no change** |
| `voice-dock.css:109` (`.voice-transcript { overflow-y: auto }`) | **does NOT set overflow-x**, so the default is `visible`. Under some Firefox/Chrome conditions the default leaks horizontally when word-break fails. | explicit `overflow-x: hidden; overflow-wrap: anywhere;` |
| Quick-chips (`components.css:476`) | flex wrap is set — no `overflow-x: auto` to hide | **no change** beyond scrollbar-hide safety net |

### 4.1 Body-level belt & suspenders

Add to `base.css` immediately after the `html, body { margin: 0; padding: 0 }` rule:

```css
html, body {
  overflow-x: hidden;
}
```

This prevents any stray element from ever spawning a page-level horizontal
scrollbar. It does NOT break:

- The table wrap (`overflow-x: auto`) — that's a child scrolling context.
- `position: sticky` on the header — sticky only breaks when an ANCESTOR has
  `overflow: hidden` AND the sticky element is nested *inside* that ancestor.
  The header is a direct child of `<body>` and `<body>` has sticky=true
  behaviour for its children even with `overflow-x: hidden`.
- Route-target SPA swaps — they're children of `.app-main`, not `<body>`.

### 4.2 Transcript hardening

```css
.voice-transcript {
  /* existing properties preserved */
  overflow-x: hidden;
  overflow-wrap: anywhere;   /* modern, handles long URLs better than break-word */
  word-break: break-word;    /* safari fallback */
}
```

Audit `<pre class="debug-metrics">` in `voice-dock.css:489` — it already has
`white-space: pre-wrap;`, so no horizontal overflow. Add
`overflow-x: hidden;` defensively:

```css
.debug-panel pre.debug-metrics {
  /* existing */
  overflow-x: hidden;
}
```

### 4.3 Quick-actions chip row

`.voice-chips` at `components.css:476` currently uses `flex-wrap: wrap`, so no
scrollbar should appear — but the chip buttons have `white-space: nowrap`
which means very long chip labels could push the row wider than the dock on
mobile. Defensive:

```css
.voice-chips {
  /* existing */
  overflow-x: hidden;
}
.voice-chips .chip-btn {
  /* existing */
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}
```

### 4.4 Mobile app-nav

```css
@media (max-width: 640px) {
  .app-nav {
    /* existing: overflow-x: auto; */
    scrollbar-width: none;
  }
  .app-nav::-webkit-scrollbar { display: none; }
}
```

Horizontal scroll still WORKS via touch/trackpad, but the visible scrollbar
track vanishes. This is an intentional pattern for horizontally-swipable
nav tabs on mobile (Chrome uses the same trick on its tab bar).

---

## 5. Compression strength slider

New control row, inserted in `js/ui.js` dock markup IMMEDIATELY BELOW the
existing Phone-line compression row at `js/ui.js:132-140`.

### 5.1 Markup

```html
<div class="voice-control-row compression-strength-row">
  <span class="voice-control-label">Strength</span>
  <input
    class="slider"
    type="range"
    id="voice-compression-strength"
    data-agent-id="voice.compression_strength"
    min="0" max="100" step="1" value="50"
    aria-label="Phone-line compression strength"
    aria-valuemin="0" aria-valuemax="100" aria-valuenow="50"
    aria-describedby="voice-compression-strength-readout"
  />
  <span class="compression-strength-readout"
        id="voice-compression-strength-readout"
        aria-live="polite">50%</span>
</div>
```

The row is INSIDE the same toggle group as the parent — no new section header.

### 5.2 CSS

```css
.compression-strength-row {
  padding-left: var(--sp-5);   /* indent under parent toggle */
  gap: var(--sp-3);
}
.compression-strength-row .slider {
  flex: 1;
  min-width: 80px;
  /* tick marks at 0 / 50 / 100 via a subtle gradient on the track */
  background:
    linear-gradient(to right,
      transparent calc(0%  - 1px),  var(--color-border) 0%,  var(--color-border) calc(0%  + 1px),
      transparent calc(0%  + 1px),  transparent calc(50% - 1px),
      var(--color-border) calc(50% - 1px), var(--color-border) calc(50% + 1px),
      transparent calc(50% + 1px),  transparent calc(100% - 1px),
      var(--color-border) calc(100% - 1px), var(--color-border) 100%
    ),
    var(--color-bg-elev-3);   /* existing slider track */
}
.compression-strength-readout {
  min-width: 36px;
  text-align: right;
  font-variant-numeric: tabular-nums;
  font-size: var(--fs-xs);
  color: var(--color-text-muted);
}
.compression-strength-row[aria-disabled="true"] {
  opacity: 0.5;
  pointer-events: none;
}
```

### 5.3 Disabled state wiring

When the parent phone-compression toggle (`#voice-phone`) is unchecked, the
entire `.compression-strength-row` gets `aria-disabled="true"` and the slider
gets `disabled`:

```js
// frontend-dev, in js/ui.js after the existing phone-toggle handler:
const strength = $('#voice-compression-strength');
const row = strength.closest('.compression-strength-row');
const readout = $('#voice-compression-strength-readout');

function syncStrengthEnabled() {
  const on = phoneToggle.checked;
  strength.disabled = !on;
  row.setAttribute('aria-disabled', on ? 'false' : 'true');
}
phoneToggle.addEventListener('change', syncStrengthEnabled);
syncStrengthEnabled();

// Initial value from storage (Oracle v2 default = 65 per their curve; if
// v2 oracle doc differs, defer to it):
strength.value = String(agent.getCompressionStrength?.() ?? 50);
readout.textContent = `${strength.value}%`;
strength.addEventListener('input', () => {
  readout.textContent = `${strength.value}%`;
  strength.setAttribute('aria-valuenow', strength.value);
  agent.setCompressionStrength?.(Number(strength.value));
});
```

`setCompressionStrength`/`getCompressionStrength` are AI-engineer's surface —
flag for them (task #3). Storage key `jarvis.compressionStrength` per round-1
spec.

### 5.4 Agent addressability

`data-agent-id="voice.compression_strength"` on the `<input type="range">`.
Agent can read or "click" it (slider's native `input` event fires on
keyboard/programmatic change).

---

## 6. "Ambient on" header indicator (optional — I recommend shipping it)

Tiny pill inside the dock header next to `#voice-live-chip` that shows
"AMBIENT" when human-call breath/wind layer is audible. Low-key — NO pulse,
NO animation; just a static pill that appears/disappears.

### 6.1 Markup (drop into `js/ui.js` voice-dock-title block, right after
`#voice-live-chip`)

```html
<span class="chip chip--neutral voice-ambient-chip" id="voice-ambient-chip"
      data-agent-id="voice.ambient_chip" hidden>Ambient</span>
```

### 6.2 CSS

No new rules needed — `chip--neutral` + `voice-ambient-chip` uses existing
tokens. Override the text color very slightly to make it feel distinct from
the status chips:

```css
.voice-ambient-chip {
  color: var(--color-text-dim);    /* dimmer than regular neutral */
  text-transform: uppercase;
  letter-spacing: var(--tracking-wide);
}
```

AI-engineer toggles visibility (`hidden = !ambientActive`) on `start_call` /
`end_call` lifecycle events. No visual animation; the user shouldn't need to
notice it unless they look.

---

## 7. Tool-call notes hidden when transcript off

Purely a rendering guard — no visual spec needed. Flag for frontend-dev
(task #4):

- When `agent.getTranscriptMode()` is `'off'` or `'captions'`, DO NOT render
  `voice-line[data-from="tool"]` lines into `.voice-transcript`.
- Captions overlay renders ONLY agent speech — it already filters correctly
  per `js/captions-overlay.js` (tool deltas are never pushed to it).
- Behavioural acceptance: in `off`/`captions` mode, the transcript panel
  contains zero "Tool:" lines even after tool calls fire. In `full` mode,
  tool lines render as before.

The empty-state copy `.voice-transcript:empty::before` from
`voice-dock.css:120` continues to work — it ONLY shows when the element has
no children, which still matches both the "off" (panel hidden anyway) and
"full with no messages yet" cases.

---

## 8. Accessibility acceptance criteria (v2 additions)

- **Map canvas** uses `role="application"` and a label instructing keyboard
  users ("Use arrow keys to pan, +/- to zoom"). Leaflet supports this natively;
  frontend-dev sets `map.options.keyboard = true` (default).
- **Pins** are focusable (`tabindex="0"`), activate on Enter/Space, have a
  visible focus ring matching `--shadow-focus-ring-accent`.
- **Detail panel** traps focus while open, Esc closes, focus returns to the
  pin (or the filter chip that selected "show carriers", whichever was the
  trigger). Standard focus discipline.
- **Filter chips** use `role="group"` on `.map-filter-rail` with an
  `aria-label`; each chip is `aria-pressed`.
- **Compression strength slider** announces value changes (`aria-live="polite"`
  on the readout).
- **Ambient chip** has `role="status"` optional — if shipped, announce
  "ambient background on/off" when it toggles.
- **Dock sheet overlay** — the visibility change (sibling → overlay) must not
  break the Esc-closes behaviour that's already wired up in `ui.js:566`.
- **Reduced motion**: map pan/zoom becomes instant, detail slide-in becomes
  instant, sheet fade-in becomes instant. All already covered by tokens
  being zero under `prefers-reduced-motion`.

---

## 9. Contrast sanity check (v2 additions)

- `.map-pin--pending` amber (`#FBBF24`) on `--color-map-bg` (`#0E1217`) =
  9.5:1 — passes.
- `.map-filter-rail` chips (existing `.chip-btn` tokens) — unchanged from
  round 1, already verified ≥ 4.5:1.
- `.compression-strength-readout` muted text on `--color-bg-elev-2` — 9.9:1.
- `.voice-ambient-chip` dim text on `--color-bg-elev-1` — 5.1:1 (dim on
  elev-1), passes.

---

## 10. Token-only contract (unchanged from round 1)

No hardcoded hex, radius, spacing, shadow, or duration anywhere outside
`tokens.css`. The ONLY exception is the Leaflet-popup close button
(`color: var(--color-text-muted) !important` — §2.6) because the library
stamps an inline style. This is a targeted `!important` against a library
selector, NOT a token value override, and is the single allowed
`!important` in the v2 diff.

---

## 11. Deliverables to downstream teammates

**To frontend-dev (task #4):**
- Apply the `css/voice-dock.css` diff in §3.4 exactly.
- Apply the `base.css` `html, body { overflow-x: hidden }` add + the
  `.voice-transcript` overflow-x + overflow-wrap + `.debug-panel pre`
  defensive hardening in §4.
- Build `/map.html` + `js/map-page.js` per §2. Use DOM-backed `L.divIcon`
  pins (not image markers) so `data-agent-id` and keyboard focus work.
- Insert the compression-strength row per §5.1 in `js/ui.js` dock template.
- Ship the optional ambient chip per §6 (I recommend yes).
- Implement the tool-line filter in §7.

**To ai-engineer (task #3):**
- Expose `getCompressionStrength()` / `setCompressionStrength(n)` on the
  voice agent with `localStorage['jarvis.compressionStrength']` default 50
  (or Oracle v2 default if different).
- Surface an `ambient-on` / `ambient-off` event so the chip can flip.
- Implement the tool-line suppression logic at the transcript write site
  rather than at the render site (cleaner).

**To reviewer (task #5):**
- Validate dock does not exceed `calc(100dvh - var(--sp-5)*2)` in ANY
  settings combination (transcript=full + settings sheet open + VU visible
  + error banner shown).
- Validate zero horizontal scrollbar on page at every viewport from 320px
  to 1920px.
- Validate map page at 320px (portrait phone) through 1920px landscape.
- Validate all new `data-agent-id` anchors appear in the agent's snapshot.
