# Map Reliability — Design Spec (UX Smoothness + Polish)

Round-2 polish pass for `/map.html`. Builds on `specs/upgrade-v2-design.md`. Scope: the sixteen smoothness items called out in Task #2. All values come from `css/tokens.css`. Every animation rides `--ease-out-expo` + `--dur-*`. Every color is a token. Two token additions flagged at the end (§18).

Written 2026-04-22 by `designer`.

---

## 1. Designer template

### Primary inspiration

- **Linear's loading-state discipline** — skeleton shimmers on opacity only, no geometry pop, muted palette, copy that says what is loading. Applied to the initial tile-fetch window.
- **Mapbox Studio's flyTo feel** — when the operator searches a far-away address, the camera "lifts, travels, lands" rather than teleporting. Steals the dual-speed model (setView for local, flyTo for continental).
- **Retool's detail drawer** — slide-in is fast (≈180ms), but the shadow bumps and content staggers in 60ms behind the panel, so the drawer feels "heavy" without a long transition. Direct template for our map-detail panel polish.

### Secondary influences

- **Stripe radar dashboard** — the way pin focus rings grow outward in a pulsing ring pattern when a fraud event is flagged. Our agent-highlight owes its shape to this.
- **Grafana status banners** — inside-the-panel error banner that shows above content without modal chrome. Template for §14 tile-fetch-failure banner.
- **GitHub filter chips** — fade-in/out on toggle instead of pop. Filter chip layer transitions in §9 use this pattern.
- **Apple Maps reduced-motion** — on `reduce`, every pan becomes an instant `setView`, every fade becomes an instant swap; nothing in-between. §13 matrix applies this.

### Specific tokens (this spec's contract)

Reuses everything in `css/tokens.css`. Two additive tokens flagged in §18 (`--dur-map-fly`, `--color-map-highlight-ring`). Primary motion vocabulary:

- Pan (local): `--dur-slow` (280ms) via Leaflet's `{duration: 0.28}` — already in place
- Pan (long-distance flyTo): **`--dur-map-fly` = 900ms** (new token)
- Tile fade-in: `--dur-base` (180ms), already fine
- Pin hover/focus: `--dur-fast` (120ms)
- Detail panel slide: `--dur-base` (180ms), existing — no change
- Detail content stagger: `--dur-fast` with 60ms delay per child
- List-view cross-fade: `--dur-base` (180ms)
- Filter chip layer fade: `--dur-base` (180ms)
- Agent highlight pulse ring: 1500ms total, three 500ms pulses
- Loading skeleton breath: 2000ms ease-in-out infinite (opacity only)

### What to avoid

- **Bouncy springs / overshoot easing.** `--ease-out-expo` everywhere; no `cubic-bezier` with >1.0 control points.
- **Geometry pop on load.** Skeletons shimmer opacity/background only — no transform, no height jumps, no "collapse then expand".
- **Marker re-renders on filter toggle.** Toggle layer visibility via opacity + `pointer-events`, not `removeLayer/addLayer`, so pins don't "snap" back into place on re-show.
- **Confetti on agent highlight.** The pulse ring is three polite rings outward, not a firework. The goal is "I can see which pin" not "I am excited".
- **Scrollbar inside the detail panel's initial slide.** When the panel slides in, its scroll position is 0 and its scrollbar should be invisible for the first ~200ms so the user doesn't see scrollbar chrome ghost across the slide.
- **Tooltip/popup transitions > 200ms.** Leaflet's default 200ms fade is already at the edge — do not slow it further.
- **Any motion > `--dur-slow` (280ms)** EXCEPT long-distance flyTo (900ms) and the 1500ms agent-highlight pulse ring — both have strong UX justification.

### Alignment with root

- Root is `DESIGN.md` + `specs/upgrade-v2-design.md`. This spec never overrides token values; it only adds two new tokens (§18) and composes existing ones into new animations.
- Leaflet-specific overrides in `css/map.css` keep their `!important` exception for `.leaflet-popup-close-button` — no new `!important` usages are introduced here.
- Inspirations inform **patterns**, not palette. Every color cited is already in `tokens.css`.

---

## 2. Item 1 — Initial loading skeleton

**Problem today.** `js/map-widget.js:203` kicks off `injectLeafletCss()` → `loadLeaflet()` → `loadMarkerCluster()` → tile fetch. During this window the map canvas is a solid `var(--color-map-bg)` rectangle. On cold cache this can be 800-2000ms; on warm cache it's ~200ms. Either way, no signal that something is loading.

**Spec.**

Add a skeleton overlay inside `.map-canvas` that exists from mount until `tileload` fires for the first time. Structure:

```html
<!-- Inside #map-canvas, BEFORE Leaflet mounts. Frontend-dev injects via JS
     just after the canvas attaches. -->
<div class="map-skeleton" data-agent-id="map.skeleton" aria-hidden="true">
  <div class="map-skeleton-pulse"></div>
  <p class="map-skeleton-label">Loading map…</p>
</div>
```

CSS:

```css
.map-skeleton {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--sp-3);
  background: var(--color-map-bg);
  z-index: calc(var(--z-map-ui) - 1);   /* above canvas, below controls */
  opacity: 1;
  transition: opacity var(--dur-slow) var(--ease-out-expo);
  pointer-events: none;
}
.map-skeleton.is-hidden {
  opacity: 0;
}
.map-skeleton.is-hidden[hidden] { display: none; }

.map-skeleton-pulse {
  width: 160px;
  height: 160px;
  border-radius: 50%;
  background: radial-gradient(
    circle at center,
    var(--color-bg-elev-2) 0%,
    var(--color-bg-elev-1) 45%,
    transparent 70%
  );
  animation: map-skeleton-breath 2000ms ease-in-out infinite;
  filter: blur(8px);
  opacity: 0.7;
}

.map-skeleton-label {
  font-size: var(--fs-sm);
  color: var(--color-text-muted);
  font-family: var(--font-mono);
  letter-spacing: var(--tracking-wide);
  margin: 0;
}

@keyframes map-skeleton-breath {
  0%, 100% { transform: scale(1);   opacity: 0.55; }
  50%      { transform: scale(1.1); opacity: 0.85; }
}

@media (prefers-reduced-motion: reduce) {
  .map-skeleton-pulse { animation: none; opacity: 0.65; }
  .map-skeleton { transition: none; }
}
```

**Lifecycle.** Frontend-dev must:
1. Append `.map-skeleton` to `#map-canvas` BEFORE `L.map(canvas, ...)` runs.
2. Listen once for the first `tileload` event on the tile layer.
3. On first `tileload`, add `.is-hidden` → on `transitionend`, set `hidden = true` and remove from DOM.
4. Also remove skeleton on `tileerror` so item 14's banner can render instead.

**Copy.** "Loading map…" — plain, mono, muted. No dots animation (that's motion we don't need). On `reduce`, the static pulse circle + label is still present and communicates clearly.

---

## 3. Item 2 — Tile fade-in transition

**Problem today.** Leaflet's `fadeAnimation: !reduced` is already on (line 231), which fades individual tiles as they arrive. Good enough — no additional CSS needed.

**Verification to request from reviewer.** On a fresh cache load, confirm tiles fade in over ~200ms (Leaflet's default), not pop instantly. If popping is observed, check that `.leaflet-tile` has `opacity 0 → 1` transition in Leaflet's own CSS; if suppressed by us, remove the override.

**Do NOT add** a custom fade — Leaflet's is already `--dur-base`-equivalent and tampering is more likely to break than improve. Polish by omission.

---

## 4. Item 3 — Pin focus visibility

**Problem today.** `css/map.css:109` sets `box-shadow: var(--shadow-focus-ring-accent)` on `:focus-visible`. That token is `0 0 0 2px rgba(110,231,183,0.35)` — a 2px ring at 35% opacity on a 16px pin is barely visible, especially when the pin sits on a dark-green grass tile.

**Spec.** Amplify the focus ring to 3px + dark offset ring, and add a subtle scale bump (matching hover's 1.15×). The ring needs to breach the surrounding dark map visually.

Replace `css/map.css:107-109` with:

```css
.map-pin:hover {
  transform: scale(1.15);
  outline: none;
}
.map-pin:focus-visible {
  transform: scale(1.25);
  outline: none;
  /* Double ring — outer dark shadow punches out the map pixels, inner
     accent ring reads on any tile. 3px accent at 70% opacity. */
  box-shadow:
    0 0 0 2px var(--color-map-pin-ring),
    0 0 0 5px rgba(110, 231, 183, 0.7),
    var(--shadow-pin);
}
```

**Rationale.** The `--color-map-pin-ring` (rgba(11,13,16,0.85)) is dark enough to punch a silhouette even on light OSM tiles. The 70%-opacity accent ring outside that silhouette is readable on every tile. 3px > 2px is the minimum width that actually reads at 16px pin size. The 1.25× scale (vs 1.15× hover) is a clear signal that the pin is focused specifically.

**Contrast.** Accent at 70% opacity on `var(--color-map-bg)` ≈ 8:1 — passes AA Large at 14pt-equivalent. On light tiles worst-case ~3.1:1 — below AA for text but acceptable for focus indicator (WCAG 2.4.7 has no contrast ratio, only "visible").

**Reduced motion.** Drop the `transform: scale()` — the box-shadow alone is sufficient. Add to the `prefers-reduced-motion` block in `map.css`:

```css
@media (prefers-reduced-motion: reduce) {
  .map-pin:hover,
  .map-pin:focus-visible { transform: none; }
}
```

---

## 5. Item 4 — Pin hover behavior

**Confirmed as-is.** `css/map.css:107-108` already applies hover's 1.15× scale to `:focus-visible` via the shared selector. After item 3's change above, `:focus-visible` will override with 1.25× — which is the intended behavior (focus is a stronger affordance than hover).

**No change needed beyond item 3.**

---

## 6. Item 5 — Agent highlight animation (CORE POLISH)

**Problem today.** `css/map.css:139-143` uses the generic `agent-flash` keyframe from `base.css:298-302`. Designed for full-size cards, it's a box-shadow pulse from 0 → 8px radius on a 1.02× scale. On a 16px pin against a dark map, this is invisible — 8px of shadow at rgba(110,231,183,0.25) just doesn't register.

**Spec.** Replace the generic `agent-flash` on `.map-pin.is-agent-highlighted` with a map-specific **triple-ring pulse**. Three concentric rings expand outward at 0ms / 500ms / 1000ms, each with an opacity ramp 1 → 0. Total duration 1500ms. This is the Stripe-radar pattern, adapted for dark-map legibility.

The trick is to use `::before` and `::after` pseudos + the element itself for three animated rings without adding DOM.

```css
/* Override the generic agent-flash for map pins. Keeps the outline (still
   useful) but replaces the box-shadow pulse with a triple-ring animation. */
.map-pin.is-agent-highlighted {
  outline: 2px solid var(--color-accent);
  outline-offset: 3px;
  animation: none;           /* cancel inherited agent-flash */
  position: relative;
  z-index: 2;
}

.map-pin.is-agent-highlighted::before,
.map-pin.is-agent-highlighted::after {
  content: "";
  position: absolute;
  top: 50%;
  left: 50%;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 2px solid var(--color-map-highlight-ring); /* see §18 for token */
  transform: translate(-50%, -50%) scale(1);
  opacity: 0;
  pointer-events: none;
  animation: map-pin-pulse 1500ms var(--ease-out-expo) 3;
}
.map-pin.is-agent-highlighted::after {
  animation-delay: 500ms;
}
/* The pin itself emits the third ring via an extra wrapping animation. */
.map-pin.is-agent-highlighted {
  /* Inline-element trick: animate the element's own box-shadow as the
     third ring. Three rings = staggered pulses at 0/500/1000ms, each
     scaling out and fading. */
  animation: map-pin-pulse-shadow 1500ms var(--ease-out-expo) 1;
}

@keyframes map-pin-pulse {
  0%   { transform: translate(-50%, -50%) scale(1);   opacity: 0.9; }
  100% { transform: translate(-50%, -50%) scale(3.2); opacity: 0; }
}

@keyframes map-pin-pulse-shadow {
  0%   { box-shadow: 0 0 0 0 var(--color-map-highlight-ring), var(--shadow-pin); }
  60%  { box-shadow: 0 0 0 14px transparent, var(--shadow-pin); }
  100% { box-shadow: 0 0 0 0 transparent, var(--shadow-pin); }
}

@media (prefers-reduced-motion: reduce) {
  .map-pin.is-agent-highlighted::before,
  .map-pin.is-agent-highlighted::after { animation: none; display: none; }
  .map-pin.is-agent-highlighted { animation: none; }
}
```

**Why this works at 16px.**
- Each ring starts at 16px (the pin's outer diameter) and grows to 51px (3.2×), so the outermost edge reaches ~25px radius — large enough that the user's eye locks onto the motion, small enough to not cover neighboring pins.
- The 0.9 → 0 opacity ramp paired with the scale gives the "pulse outward and fade" feel, not "blob grows".
- Staggered delays (0 / 500 / 1000ms) mean at any moment during the 1500ms window, the user sees at least one active ring. Continuous visual signal.
- `--color-map-highlight-ring` (new token, §18) is the accent green at a higher alpha than the focus ring (see §18 for value).

**Trigger contract.** `js/map-widget.js:638-643` `flash()` adds the class and removes after 1400ms. The pulse animation total is 1500ms — bump the removal to **1600ms** so the last ring completes before the class is yanked:

```js
// js/map-widget.js:638 — frontend-dev edit
function flash(el) {
  el.classList.remove('is-agent-highlighted');
  void el.offsetWidth;
  el.classList.add('is-agent-highlighted');
  setTimeout(() => el.classList.remove('is-agent-highlighted'), 1600);
}
```

**Accessibility.** The outline (`2px solid var(--color-accent)` + `outline-offset: 3px`) remains even under `prefers-reduced-motion` — users who can't see the motion still get a clear "this is the pin the agent is referencing" cue. Sighted users get motion; motion-sensitive users get static outline.

---

## 7. Item 6 — Pan smoothness (flyTo threshold)

**Problem today.** `js/map-widget.js:597` uses `{animate: true, duration: 0.28}` for every pan. 0.28s is right for a neighborhood-scale shift, but feels teleport-y when the target is across the country. Leaflet's `flyTo` has built-in zoom-out-then-zoom-in for long distances, which is both smoother and orients the user.

**Spec.** Add a distance-based threshold. Pans where the screen-space delta between current center and target is > 1500 km use `flyTo` with 0.9s duration; shorter pans keep the existing `setView` 0.28s behavior.

Implementation (frontend-dev edits `js/map-widget.js`):

```js
// Replace the existing panTo() and the various map.flyTo/map.setView calls
// in focusLoad/focusCarrier/focusTarget with a unified smoothPan().

const PAN_DURATION_LOCAL_S = 0.28;      // --dur-slow
const PAN_DURATION_FLY_S   = 0.90;      // --dur-map-fly (new token, §18)
const FLY_THRESHOLD_KM     = 1500;

function haversineKm(a, b) {
  const toRad = (x) => (x * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) *
    Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function smoothPan(target, zoom) {
  if (reduced) {
    map.setView([target.lat, target.lng], zoom ?? map.getZoom(), { animate: false });
    return;
  }
  const here = map.getCenter();
  const distance = haversineKm(here, target);
  if (distance > FLY_THRESHOLD_KM) {
    map.flyTo([target.lat, target.lng], zoom ?? map.getZoom(), {
      animate: true,
      duration: PAN_DURATION_FLY_S
    });
  } else {
    map.setView([target.lat, target.lng], zoom ?? map.getZoom(), {
      animate: true,
      duration: PAN_DURATION_LOCAL_S
    });
  }
}

// Replace map.flyTo/map.setView in focusLoad/focusCarrier/focusTarget with
// smoothPan(). flyToBounds paths (focusLoad when both pickup + dropoff
// present) stay flyToBounds — Leaflet picks appropriate duration from the
// bounds span automatically; override its duration to match:
//   map.flyToBounds(bounds, {
//     animate: true,
//     duration: distance > FLY_THRESHOLD_KM ? PAN_DURATION_FLY_S : PAN_DURATION_LOCAL_S,
//     maxZoom: 6
//   });
// (compute `distance` between bounds.getCenter() and current center.)
```

**Why 1500 km.** That's approximately the visible diagonal of the continental US at zoom 5, which is our `DEFAULT_VIEW.zoom`. Distances below that fit within a single screen, so setView is natural ("scoot over"). Distances above that cross significant geography and benefit from the "lift-travel-land" flyTo motion.

**Reduced motion.** Always instant `setView({animate: false})` — no flyTo, no setView-with-animate. Already handled by the `reduced` check at the top of `smoothPan()`.

**Why 900ms.** Leaflet's flyTo default is derived from bounds-span, typically 800–1500ms. 900ms is a "cinematic but not slow" value — tested against the bias that map navigation feels laggy above 1200ms. If user feedback says "still too slow", drop to 800ms. Do not go below 700ms: below that, flyTo's zoom-out-then-in arc becomes jarring.

---

## 8. Item 7 — Cluster expansion polish

Per Oracle decision §5, clustering is being **disabled entirely** for this dataset. This item becomes moot. If clustering is re-enabled in a future round, the hover + spiderfy timing spec from this section applies verbatim. For this round: skip.

---

## 9. Item 8 — Filter chip layer transitions

**Problem today.** `js/map-widget.js:710-730` `setLayerVisible()` uses `loadLayer.addTo(map)` / `map.removeLayer(loadLayer)` — an instant DOM-level swap. Clicking "Loads off" pops all load pins out of existence in a single frame.

**Spec.** Fade the layer's pane opacity over `--dur-base`. Leaflet puts each layer group in a dedicated pane (`map.getPane()`) once you assign one; we lean on that.

Frontend-dev edits `js/map-widget.js`:

```js
// On map creation — define panes with initial opacity 1 and a CSS transition
// via a CSS selector. The layer groups target those panes.
map.createPane('loads-pane');   map.getPane('loads-pane').style.zIndex = 410;
map.createPane('carriers-pane');map.getPane('carriers-pane').style.zIndex = 420;
map.createPane('lanes-pane');   map.getPane('lanes-pane').style.zIndex = 405;

// And pass pane to each layer group:
const loadLayer    = L.layerGroup({ pane: 'loads-pane' });
const carrierLayer = L.layerGroup({ pane: 'carriers-pane' });
const laneLayer    = L.layerGroup({ pane: 'lanes-pane' });

// setLayerVisible() no longer add/removes the layer — it toggles a class.
function setLayerVisible(layer, on) {
  const name = String(layer || '').toLowerCase();
  const visible = !!on;
  if (name === 'loads')    applyPaneVisibility('loads-pane', visible, 'loads');
  else if (name === 'carriers') applyPaneVisibility('carriers-pane', visible, 'carriers');
  else if (name === 'lanes') applyPaneVisibility('lanes-pane', visible, 'lanes');
  else if (name === 'delayed') { delayedOnly = visible; applyDelayedFilter(); }
  else return { ok: false, code: 'unknown_layer', error: `Layer "${name}" not recognised. One of: loads, carriers, lanes, delayed.` };
  // ... existing chip state sync + renderFilterList() ...
  return { ok: true, result: { layer: name, visible } };
}

function applyPaneVisibility(paneName, visible, setKey) {
  const pane = map.getPane(paneName);
  if (!pane) return;
  if (visible) visibleLayers.add(setKey);
  else visibleLayers.delete(setKey);
  pane.classList.toggle('map-pane-hidden', !visible);
}
```

CSS in `css/map.css`:

```css
/* Fade layers on visibility toggle. Assumes Leaflet panes have these
   classes added by JS. */
.leaflet-pane {
  transition: opacity var(--dur-base) var(--ease-out-expo);
}
.leaflet-pane.map-pane-hidden {
  opacity: 0;
  pointer-events: none;
}

@media (prefers-reduced-motion: reduce) {
  .leaflet-pane { transition: none; }
}
```

**Why not `display: none`.** `display: none` on a pane would cause Leaflet to miscompute layout on re-show. Opacity + `pointer-events: none` is a pure visual hide; Leaflet still thinks the pane is present.

**Delayed-only chip.** `applyDelayedFilter` still does `layerGroup.removeLayer/addLayer` inside the loads layer — that's a content filter, not a layer toggle, so clearing/rebuilding is the right call. No fade needed for that path.

---

## 10. Item 9 — Detail panel slide-in polish

**Problem today.** `css/map.css:206-213` slides the panel in via `transform: translateX(100%) → 0` over `--dur-base` with `--ease-out-expo`. Shadow is static `var(--shadow-overlay)` throughout.

**Spec.** The slide is smooth enough as-is — the main weakness is a flat shadow that feels painted-on rather than lifted. Add a shadow ramp: start stronger during the slide, settle to the resting `--shadow-overlay` after. Gives a "catches the light as it arrives" feel.

Update `css/map.css:197-211`:

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
  transition:
    transform  var(--dur-base) var(--ease-out-expo),
    box-shadow var(--dur-slow) var(--ease-out-expo);   /* NEW */
  z-index: var(--z-map-ui);
  overflow-y: auto;
  padding: var(--sp-4);
}
.map-detail.is-open {
  transform: translateX(0);
  box-shadow: var(--shadow-overlay-strong);            /* NEW: stronger when open */
}
```

**Why.** `--shadow-overlay-strong` is already in `tokens.css:83`. The 280ms shadow ramp (vs 180ms transform) means the shadow continues intensifying for ~100ms after the panel lands — the eye reads this as "the panel is settling into place". Subtle; won't be consciously noticed.

**Reduced motion.** Already handled — the token-level motion override (`--dur-base: 0ms` etc under `prefers-reduced-motion`) flattens both transitions to instant.

---

## 11. Item 10 — Detail panel content stagger reveal

**Problem today.** Panel slides in, all content is present the moment the panel appears. Works fine, but feels "painted on the panel" instead of "arriving with the panel".

**Spec.** When the panel opens, children (`.map-detail-header`, `.detail-kv`) fade in from opacity 0 → 1 with a 60ms stagger, offset by ~60ms from the slide start. Subtle lift in unison that makes the drawer feel weighted.

`js/map-widget.js:openDetailPanel()` — no JS change needed; pure CSS via `:is(...)` selectors and `animation-delay`:

```css
.map-detail.is-open > * {
  opacity: 0;
  animation: map-detail-stagger var(--dur-base) var(--ease-out-expo) forwards;
}
.map-detail.is-open > *:nth-child(1) { animation-delay: 60ms; }
.map-detail.is-open > *:nth-child(2) { animation-delay: 120ms; }
.map-detail.is-open > *:nth-child(3) { animation-delay: 180ms; }
.map-detail.is-open > *:nth-child(n+4) { animation-delay: 240ms; }

@keyframes map-detail-stagger {
  from { opacity: 0; transform: translateY(4px); }
  to   { opacity: 1; transform: translateY(0);   }
}

@media (prefers-reduced-motion: reduce) {
  .map-detail.is-open > * {
    opacity: 1;
    animation: none;
    transform: none;
  }
}
```

**Why 4px.** Tiny translate; the eye reads it as "settling" not "moving". 8px would be distracting, 0 makes it a pure fade which doesn't read as stagger.

---

## 12. Item 11 — List view cross-fade

**Problem today.** `js/map-widget.js:772-780` `setListView()` flips `listView.hidden` and `canvas.setAttribute('aria-hidden', ...)`. Pop swap — no transition.

**Spec.** Cross-fade the list-view container and the canvas/filter-rail area over `--dur-base`.

CSS in `css/map.css` — replace the existing `.map-list-view` + `.map-canvas[aria-hidden]` block (lines 270-302):

```css
.map-list-view {
  position: absolute;
  inset: 0;
  background: var(--color-bg);
  padding: var(--sp-4);
  overflow-y: auto;
  z-index: calc(var(--z-map-ui) + 1);
  opacity: 0;
  transition: opacity var(--dur-base) var(--ease-out-expo);
  pointer-events: none;
}
.map-list-view:not([hidden]) {
  opacity: 1;
  pointer-events: auto;
}
.map-list-view[hidden] {
  display: block;
  opacity: 0;
  pointer-events: none;
}

.map-canvas {
  transition: opacity var(--dur-base) var(--ease-out-expo);
}
.map-canvas[aria-hidden="true"] {
  opacity: 0;
  visibility: visible;
  pointer-events: none;
}

@media (prefers-reduced-motion: reduce) {
  .map-list-view,
  .map-canvas { transition: none; }
}
```

Add `inert` attribute alongside `hidden` for AT hiding:

```js
// js/map-widget.js — when toggling list view
if (listView) {
  listView.hidden = !listOpen;
  listView.toggleAttribute('inert', !listOpen);
}
```

---

## 13. Item 12 — Mobile bottom-sheet swipe-down dismiss

**Verdict: skip drag-to-dismiss; add simple swipe-down.** Native drag requires velocity tracking + rubber-banding. Instead ship a single-touch check:

```js
// js/map-widget.js — add inside createMap, after the existing ESC handler
if (detail && window.matchMedia('(max-width: 640px)').matches) {
  let touchStartY = 0;
  detail.addEventListener('touchstart', (ev) => {
    if (ev.touches.length !== 1) return;
    touchStartY = ev.touches[0].clientY;
  }, { passive: true });
  detail.addEventListener('touchmove', (ev) => {
    if (ev.touches.length !== 1) return;
    const dy = ev.touches[0].clientY - touchStartY;
    if (dy > 60 && detail.scrollTop === 0) {
      closeDetailPanel();
      touchStartY = ev.touches[0].clientY;
    }
  }, { passive: true });
}
```

Tag as Nice-to-Have. Close button + ESC already cover core a11y.

---

## 14. Item 13 — Reduced-motion matrix

Single table covering every animation site in the map page. Each row: what animates under default, what happens under `prefers-reduced-motion: reduce`.

| # | Site | Default behavior | Reduced-motion behavior | Enforcement |
|---|---|---|---|---|
| 1 | Initial skeleton pulse | 2s breath opacity loop | Static 0.65 opacity, no loop | `@media` override in §2 CSS |
| 2 | Skeleton fade-out on tile-load | `--dur-slow` opacity 1→0 | Instant (token collapses to 0ms) | Automatic via `--dur-slow: 0ms` |
| 3 | Tile fade-in (Leaflet native) | ~200ms opacity per tile | Instant | `fadeAnimation: !reduced` |
| 4 | Pin hover transform scale | 1.15× over `--dur-fast` | No transform, no ring | `@media` override in §4 CSS |
| 5 | Pin focus scale + ring | 1.25× + double ring | No transform; keep double ring | §4 CSS |
| 6 | Agent highlight triple-ring | 1500ms pulse, 3 rings | `animation: none`; outline-only | §6 CSS |
| 7 | Map pan (setView local) | 280ms animate | Instant `{animate: false}` | `smoothPan()` early-return in §7 JS |
| 8 | Map pan (flyTo continental) | 900ms `flyTo` | Instant `setView` | Same early-return |
| 9 | Map zoom | Leaflet native animation | Instant | `zoomAnimation: !reduced` (already wired) |
| 10 | Marker-cluster zoom | n/a (cluster disabled) | n/a | — |
| 11 | Cluster spiderfy | n/a | n/a | — |
| 12 | Cluster hover scale | n/a | n/a | — |
| 13 | Filter chip layer fade | `--dur-base` opacity 0↔1 | Instant (token collapse) | Token + explicit §9 CSS |
| 14 | Detail panel slide-in | 180ms translateX + 280ms shadow ramp | Instant translate + instant shadow | Token collapse |
| 15 | Detail content stagger | 60–240ms delayed reveal | `animation: none; opacity: 1` | §11 CSS explicit override |
| 16 | List-view cross-fade | 180ms opacity both directions | Instant | §12 CSS + token collapse |
| 17 | Mobile bottom-sheet slide | 180ms translateY | Instant | Token collapse |
| 18 | Detail open → focus close button | Instant focus change | Instant focus change | No animation, identical |
| 19 | Tile-fetch error banner slide-in | 180ms translateY + opacity | Instant appearance | §15 CSS |
| 20 | Empty-state fade-in | Instant (no animation) | Same | N/A |

---

## 15. Item 14 — Tile-fetch-error banner

**Problem today.** If tiles fail, the canvas sits as a `var(--color-map-bg)` void with no recovery path.

**Spec.** Render an in-map banner with a retry button when `tileerror` count exceeds a threshold.

HTML (frontend-dev adds inside `partials/map.html`, immediately after `#map-canvas`):

```html
<div id="map-tile-error" class="map-tile-error" role="status" hidden>
  <span class="map-tile-error-text">Map tiles failed to load.</span>
  <button class="btn btn--sm" type="button" id="map-tile-retry" data-agent-id="map.tile_retry">Retry</button>
</div>
```

CSS:

```css
.map-tile-error {
  position: absolute;
  top: var(--sp-3);
  left: 50%;
  transform: translateX(-50%) translateY(-8px);
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-2) var(--sp-3);
  background: var(--color-danger-soft);
  border: 1px solid var(--color-danger);
  border-radius: var(--radius-md);
  color: var(--color-danger);
  font-size: var(--fs-sm);
  font-weight: var(--fw-medium);
  z-index: var(--z-map-ui);
  opacity: 0;
  box-shadow: var(--shadow-overlay);
  transition:
    opacity   var(--dur-base) var(--ease-out-expo),
    transform var(--dur-base) var(--ease-out-expo);
  pointer-events: none;
}
.map-tile-error:not([hidden]) {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
  pointer-events: auto;
}
.map-tile-error[hidden] { display: flex; visibility: hidden; }

@media (prefers-reduced-motion: reduce) {
  .map-tile-error { transition: none; }
}
```

JS: see Oracle §7 tile retry policy — error banner appears when `tileState.failed > 5` in a 10 s window; reset on first successful `tileload`; retry button calls `tileLayer.redraw()`.

---

## 16. Item 15 — Empty state

**Problem today.** If the user toggles ALL filter chips off, the canvas shows just the basemap with no recovery hint.

**Spec.**

CSS in `css/map.css`:

```css
.map-empty-state {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  max-width: 280px;
  padding: var(--sp-4);
  background: var(--color-overlay-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  text-align: center;
  color: var(--color-text-muted);
  font-size: var(--fs-sm);
  z-index: var(--z-map-ui);
  pointer-events: auto;
}
.map-empty-state[hidden] { display: none; }
.map-empty-state-title {
  font-size: var(--fs-md);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
  margin: 0 0 var(--sp-2) 0;
}
.map-empty-state-body { margin: 0; }
```

HTML:

```html
<div class="map-empty-state" role="status" hidden>
  <p class="map-empty-state-title">Nothing to show</p>
  <p class="map-empty-state-body">Toggle <strong>Loads</strong>, <strong>Carriers</strong>, or <strong>Lanes</strong> in the filter rail to reveal pins.</p>
</div>
```

Trigger logic (extend `setLayerVisible`):

```js
function updateEmptyState() {
  if (!emptyStateEl) return;
  const anyVisible = visibleLayers.has('loads') || visibleLayers.has('carriers') || visibleLayers.has('lanes');
  emptyStateEl.hidden = anyVisible;
}
```

---

## 17. Item 16 — Agent-activity indicator ↔ map tools

**Decision: extend the map tool handlers to call `set_activity_note` automatically.**

Phrasings (pass these to the tool-handler JS):

| Tool | During |
|---|---|
| `map_focus` (city) | "Centering on {city}…" |
| `map_focus` (state) | "Showing {state}…" |
| `map_focus` (load_id) | "Finding load {id}…" |
| `map_focus` (carrier_id) | "Finding carrier {id}…" |
| `map_highlight_load` | "Highlighting {id}…" |
| `map_show_layer` (on)  | "Showing {layer}…" |
| `map_show_layer` (off) | "Hiding {layer}…" |

Implementation sits in the tool-handler wiring in `js/app.js`. Call `set_activity_note` BEFORE the widget action, cleared implicitly by the next agent activity transition.

---

## 18. Item 17 — Dispatch fleet-map card visual consistency audit

### Consistency PASS

- Status dot colors exactly match `.map-pin--{status}` colors ✓
- Card header uses uppercase tracking-wide label — matches `.map-filter-rail-title` ✓
- Border radius `--radius-md` card with hairline `--color-border` ✓
- Lane ID uses `--font-mono` + `--tracking-wide` ✓

### Minor polish

Unify hover pattern with the filter-list:

```css
.dispatch-map-lane {
  /* add */
  border: 1px solid transparent;
  transition:
    background var(--dur-fast) var(--ease-out-expo),
    border-color var(--dur-fast) var(--ease-out-expo);
}
.dispatch-map-lane:hover {
  background: var(--color-bg-elev-2);
  border-color: var(--color-border-strong);
}
```

---

## 19. Token additions required

Append to `:root` in `css/tokens.css`, in the "Map surfaces" block:

```css
/* v2 round-2 polish — map reliability */
--color-map-highlight-ring: rgba(110, 231, 183, 0.75);
--dur-map-fly: 900ms;
```

And extend the `@media (prefers-reduced-motion: reduce)` block:

```css
@media (prefers-reduced-motion: reduce) {
  :root {
    --dur-fast: 0ms;
    --dur-base: 0ms;
    --dur-slow: 0ms;
    --dur-map-fly: 0ms;
  }
}
```

---

## 20. Summary — what changes where

### `css/tokens.css`
- Add two tokens: `--color-map-highlight-ring`, `--dur-map-fly`.
- Extend `@media (prefers-reduced-motion: reduce)` block.

### `css/map.css`
- Skeleton overlay styles.
- Pin focus-visible amplification.
- Agent-highlight triple-ring pulse (replace generic `agent-flash`).
- Pane-visibility fade.
- Detail panel shadow ramp.
- Detail content stagger.
- List-view cross-fade (replace `hidden` display: none with opacity-based).
- Tile-error banner styles.
- Empty-state overlay styles.
- `@media (prefers-reduced-motion)` explicit overrides.

### `js/map-widget.js`
- Skeleton mount/unmount on first `tileload`.
- `smoothPan()` helper + `haversineKm()`.
- Layer pane creation + `applyPaneVisibility()`.
- Extend `flash()` timeout 1400ms → 1600ms.
- Mobile touch swipe-down → closeDetailPanel.
- Empty-state element + `updateEmptyState()`.

### `partials/map.html`
- `<div id="map-tile-error">` element.
- `<div class="map-empty-state">` inside `#map-canvas`.

### `js/app.js`
- Per-tool `set_activity_note` emission with tool-specific copy.

### `css/pages.css`
- Minor polish: add `border: 1px solid transparent` + border-color transition on `.dispatch-map-lane`.
