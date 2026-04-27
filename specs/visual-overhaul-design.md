# Visual Overhaul — Design Spec

> Owner: designer · Consumers: frontend-dev, ai-engineer, reviewer
> Tokens source: `css/tokens.css` (M3 Expressive Console)
> All values reference existing custom properties — zero raw hex.

---

## 1. Image Strategy

### 1.1 Placements & Source Photos

| Placement | Subject | Source | Treatment |
|---|---|---|---|
| **Hero band** (index / dispatch) | Aerial semi-trucks on interstate at dusk | Pexels (Quintin Gellar, ID 2199293) | 1600×600 crop, center-weighted. CSS `linear-gradient(to right, var(--color-bg) 0%, transparent 50%, var(--color-bg) 100%)` over image. `mix-blend-mode: luminosity`, `opacity: 0.35`. |
| **Carrier thumb 1** | White Peterbilt 579 day-cab | Unsplash | 480×320 crop, center. |
| **Carrier thumb 2** | Kenworth W990 sleeper, highway | Unsplash | 480×320 crop, center. |
| **Carrier thumb 3** | Freightliner Cascadia reefer | Unsplash | 480×320 crop. |
| **Carrier thumb 4** | Volvo VNL on desert highway | Pexels | 480×320 crop. |
| **Carrier thumb 5** | Flatbed with steel load | Pexels (Tom Fisk) | 480×320 crop. |
| **Carrier thumb 6** | Dry van backing into dock | Pexels | 480×320 crop. |
| **Carrier thumb 7** | Tanker truck at fuel terminal | Unsplash | 480×320 crop. |
| **Carrier thumb 8** | Red Kenworth T680 on wet road | Unsplash | 480×320 crop. |
| **Empty-state** (negotiate page) | Moody loading dock at night | Pexels | 1200×600. Luminosity blend, `opacity: 0.22`. |
| **Map side panel ambient** | Port container yard, blue-hour | Pexels | 240×480 vertical, `cover`. `opacity: 0.08`, `filter: saturate(0.4) blur(2px)`. |

### 1.2 Processing Pipeline — `scripts/fetch-images.mjs`

```js
// Requires: npm i -D sharp
import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const MANIFEST = [
  { url: '<source URL>', dest: 'public/images/hero/interstate-dusk.webp', w: 1600, q: 72 },
  { url: '<source URL>', dest: 'public/images/carriers/peterbilt-579.webp', w: 480, q: 75 },
  // ... one entry per image above
  { url: '<source URL>', dest: 'public/images/ambient/port-yard.webp', w: 240, q: 70 },
];

for (const img of MANIFEST) {
  await mkdir(dirname(img.dest), { recursive: true });
  const buf = await fetch(img.url).then(r => r.arrayBuffer());
  await sharp(Buffer.from(buf))
    .rotate()                // auto-orient
    .resize({ width: img.w, withoutEnlargement: true })
    .removeMetadata()         // strip EXIF
    .webp({ quality: img.q })
    .toFile(img.dest);
}
```

### 1.3 `<picture>` Markup Pattern

```html
<!-- Hero — eager, high priority -->
<picture>
  <source srcset="/public/images/hero/interstate-dusk.webp" type="image/webp" />
  <img src="/public/images/hero/interstate-dusk.webp"
       alt="Semi-trucks on an interstate at dusk"
       width="1600" height="600"
       loading="eager" fetchpriority="high"
       decoding="async" />
</picture>

<!-- Carrier card — lazy -->
<picture>
  <source srcset="/public/images/carriers/peterbilt-579.webp" type="image/webp" />
  <img src="/public/images/carriers/peterbilt-579.webp"
       alt="Peterbilt 579 day-cab"
       width="480" height="320"
       loading="lazy" decoding="async" />
</picture>
```

CSS for hero overlay:

```css
.hero-band {
  position: relative;
  overflow: hidden;
  background: var(--color-bg);
}
.hero-band img {
  width: 100%;
  height: auto;
  object-fit: cover;
  mix-blend-mode: luminosity;
  opacity: 0.35;
}
.hero-band::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(
    to right,
    var(--color-bg) 0%,
    transparent 35%,
    transparent 65%,
    var(--color-bg) 100%
  );
  pointer-events: none;
}
```

---

## 2. Map Navigation Dots — Production Redesign

### 2.1 Marker Concept

Replace the current 28 px circle (`.map-pin`) with a **28×28 directional truck-glyph** SVG. Truck rotates to bearing of travel via `transform: rotate(${heading}deg)`.

**Status color mapping** (uses `--color-state-*` family):

| Carrier status | Token |
|---|---|
| `idle` / `available` | `--color-state-idle` |
| `in_transit` | `--color-state-speaking` |
| `delayed` | `--color-state-error` |
| `loading` / `booked` | `--color-state-tool` |

### 2.2 SVG Source — Truck Chevron (inline in map-widget.js)

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28" fill="none">
  <rect x="8" y="6" width="12" height="16" rx="2" fill="currentColor" opacity="0.9"/>
  <path d="M10 6V3a1 1 0 011-1h6a1 1 0 011 1v3" fill="currentColor" opacity="0.7"/>
  <path d="M14 1l4 4h-8z" fill="currentColor"/>
  <circle cx="10" cy="22" r="1.5" fill="currentColor" opacity="0.5"/>
  <circle cx="18" cy="22" r="1.5" fill="currentColor" opacity="0.5"/>
</svg>
```

### 2.3 CSS Overrides

```css
.map-pin {
  width: 28px;
  height: 28px;
  color: var(--md-sys-color-primary);
  filter: drop-shadow(0 1px 2px rgba(0,0,0,0.3));
  cursor: pointer;
  transition: transform var(--dur-fast) var(--ease-snap);
}
.map-pin svg { display: block; }

.map-pin--idle       { color: var(--color-state-idle); }
.map-pin--in_transit { color: var(--color-state-speaking); }
.map-pin--delayed    { color: var(--color-state-error); }
.map-pin--booked,
.map-pin--loading    { color: var(--color-state-tool); }
.map-pin--delivered  { color: var(--color-text-dim); }

.map-pin:hover { transform: scale(1.15); }
.map-pin:hover::after {
  content: '';
  position: absolute;
  inset: -4px;
  border-radius: 50%;
  border: 2px solid var(--color-border-accent);
  pointer-events: none;
}

.map-pin.is-selected::before {
  content: '';
  position: absolute;
  inset: -6px;
  border-radius: 50%;
  border: 2px solid var(--md-sys-color-primary);
  animation: pin-pulse 1.6s var(--ease-out-expo) infinite;
}
@media (prefers-reduced-motion: reduce) {
  .map-pin.is-selected::before { animation: none; opacity: 0.6; }
}

@keyframes pin-pulse {
  0%   { transform: scale(1);   opacity: 0.8; }
  100% { transform: scale(1.8); opacity: 0; }
}

.map-pin:focus-visible {
  outline: none;
  box-shadow: var(--shadow-focus-ring-accent);
}
```

### 2.4 Cluster Markers

```css
.marker-cluster { background: transparent !important; }
.marker-cluster div {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--md-sys-color-surface-container-high);
  border: 2px solid var(--color-border);
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
  box-shadow: var(--shadow-pin);
}
.marker-cluster--delayed div {
  border-color: var(--color-state-error);
  background: var(--md-sys-color-error-container);
  color: var(--md-sys-color-on-error-container);
}
.marker-cluster--transit div {
  border-color: var(--md-sys-color-primary);
  background: var(--md-sys-color-primary-container);
  color: var(--md-sys-color-on-primary-container);
}
```

---

## 3. FlightRadar-Style Carrier Popup

### 3.1 Layout

Anchored **top-right** of `.map-canvas`, overlaying the map. Not a Leaflet popup.

| Prop | Value |
|---|---|
| Position | `absolute; top: var(--sp-2); right: var(--sp-2); bottom: var(--sp-2)` |
| Width | `360px` (full-width on ≤640 px → bottom sheet) |
| Background | `var(--color-bg-elev-3)` |
| Border | `1px solid var(--color-border)` |
| Radius | `var(--radius-lg)` |
| Shadow | `var(--md-sys-elevation-level-3)` |

### 3.2 HTML Structure

```html
<aside id="carrier-detail-panel" class="carrier-panel" hidden aria-label="Carrier detail">
  <div class="carrier-panel-hero">
    <picture>
      <source srcset="/public/images/carriers/{slug}.webp" type="image/webp" />
      <img src="/public/images/carriers/{slug}.webp"
           alt="{carrier name} truck"
           width="480" height="320"
           loading="lazy" decoding="async"
           class="carrier-panel-img" />
    </picture>
    <span class="chip carrier-panel-status">{status chip}</span>
    <button class="carrier-panel-close icon-btn" type="button"
            aria-label="Close carrier detail">&times;</button>
  </div>

  <div class="carrier-panel-body">
    <h2 class="carrier-panel-name">{name}</h2>
    <p class="carrier-panel-ids">
      <span class="mono">{mc}</span> · DOT <span class="mono">{dot}</span>
    </p>

    <section class="carrier-panel-section">
      <h3 class="carrier-panel-section-title">Equipment</h3>
      <div class="carrier-panel-chips"><!-- chips --></div>
    </section>

    <section class="carrier-panel-section">
      <h3 class="carrier-panel-section-title">Current Load</h3>
      <p class="carrier-panel-route">
        <span>{origin}</span>
        <svg class="route-chevron" width="16" height="16"><!-- → --></svg>
        <span>{destination}</span>
      </p>
      <dl class="carrier-panel-kv">
        <dt>ETA</dt><dd>{eta}</dd>
        <dt>Speed</dt><dd>{speed} mph</dd>
        <dt>Heading</dt><dd>{heading}°</dd>
      </dl>
    </section>

    <section class="carrier-panel-section">
      <h3 class="carrier-panel-section-title">Driver</h3>
      <dl class="carrier-panel-kv">
        <dt>Name</dt><dd>{driver_name}</dd>
        <dt>HOS remaining</dt><dd>{hos_hours}h</dd>
      </dl>
    </section>
  </div>

  <div class="carrier-panel-actions">
    <button class="btn btn--sm btn--outlined" data-action="call-driver">Call driver</button>
    <button class="btn btn--sm btn--primary" data-action="assign-load">Assign load</button>
    <button class="btn btn--sm btn--ghost" data-action="track">Track</button>
  </div>
</aside>
```

### 3.3 CSS

```css
.carrier-panel {
  position: absolute;
  top: var(--sp-2);
  right: var(--sp-2);
  bottom: var(--sp-2);
  width: 360px;
  background: var(--color-bg-elev-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--md-sys-elevation-level-3);
  z-index: var(--z-map-ui);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transform: translateX(calc(100% + var(--sp-4)));
  opacity: 0;
  transition:
    transform 180ms var(--ease-out-expo),
    opacity 180ms var(--ease-out-expo);
}
.carrier-panel[hidden] { display: none; }
.carrier-panel.is-open { transform: translateX(0); opacity: 1; }

.carrier-panel-hero { position: relative; aspect-ratio: 16 / 9; overflow: hidden; flex-shrink: 0; }
.carrier-panel-img { width: 100%; height: 100%; object-fit: cover; }
.carrier-panel-status { position: absolute; top: var(--sp-2); left: var(--sp-2); }
.carrier-panel-close {
  position: absolute; top: var(--sp-2); right: var(--sp-2);
  background: var(--color-overlay-bg);
  border-radius: var(--radius-pill);
  width: 32px; height: 32px;
}
.carrier-panel-body { flex: 1 1 auto; overflow-y: auto; padding: var(--sp-4); }
.carrier-panel-name {
  font-family: var(--font-sans); font-size: var(--fs-lg);
  font-weight: var(--fw-semibold); color: var(--color-text);
  margin: 0 0 var(--sp-1) 0;
}
.carrier-panel-ids {
  font-family: var(--font-mono); font-size: var(--fs-xs);
  color: var(--color-text-muted); margin: 0 0 var(--sp-4) 0;
}
.carrier-panel-section { padding: var(--sp-3) 0; border-top: 1px solid var(--color-border); }
.carrier-panel-section-title {
  font-family: var(--font-mono); font-size: 11px;
  font-weight: var(--fw-semibold); letter-spacing: var(--tracking-caps);
  text-transform: uppercase; color: var(--color-text-muted);
  margin: 0 0 var(--sp-2) 0;
}
.carrier-panel-chips { display: flex; flex-wrap: wrap; gap: var(--sp-1); }
.carrier-panel-route {
  display: flex; align-items: center; gap: var(--sp-2);
  font-size: var(--fs-sm); color: var(--color-text); margin: 0 0 var(--sp-2) 0;
}
.carrier-panel-kv {
  display: grid; grid-template-columns: 96px 1fr;
  gap: var(--sp-1) var(--sp-3); font-size: var(--fs-sm);
}
.carrier-panel-kv dt {
  color: var(--color-text-muted); font-size: var(--fs-xs);
  font-weight: var(--fw-medium);
}
.carrier-panel-kv dd { margin: 0; color: var(--color-text); }
.carrier-panel-actions {
  flex-shrink: 0; display: flex; gap: var(--sp-2);
  padding: var(--sp-3) var(--sp-4);
  border-top: 1px solid var(--color-border);
}

@media (max-width: 640px) {
  .carrier-panel {
    top: auto; left: 0; right: 0; bottom: 0;
    width: 100%; max-height: 70dvh;
    border-radius: var(--radius-lg) var(--radius-lg) 0 0;
    transform: translateY(100%);
  }
  .carrier-panel.is-open { transform: translateY(0); }
}
```

### 3.4 Missing Data Fields in `carriers.json`

Add per carrier: `dot`, `status` (idle | in_transit | delayed | loading), `driver` (`{ name, hosRemaining }`), `currentLoad` (load ID ref or null), `heading` (degrees), `speed` (mph), `imageSlug` (filename stem for WebP lookup).

---

## 4. Agent Settings Menu — Production Polish

### 4.1 Persona Tile Grid

Replace the segmented-pill `.persona-seg` with a tile grid.

```css
.persona-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: var(--sp-2);
  padding: 0 var(--sp-4);
}
.persona-tile {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-1);
  padding: var(--sp-3) var(--sp-2);
  background: var(--md-sys-color-surface-container);
  border: 2px solid var(--color-border);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition:
    border-color var(--dur-fast) var(--ease-snap),
    background var(--dur-fast) var(--ease-snap);
}
.persona-tile:hover {
  background: var(--md-sys-color-surface-container-high);
  border-color: var(--color-border-strong);
}
.persona-tile:focus-visible {
  outline: none;
  box-shadow: var(--shadow-focus-ring-accent);
}
.persona-tile[aria-pressed="true"] {
  border-color: var(--md-sys-color-primary);
  background: var(--md-sys-color-primary-container);
}
.persona-tile[aria-pressed="true"]::after {
  content: '✓';
  position: absolute;
  top: var(--sp-1); right: var(--sp-1);
  width: 20px; height: 20px;
  border-radius: 50%;
  background: var(--md-sys-color-primary);
  color: var(--md-sys-color-on-primary);
  font-size: 12px; font-weight: var(--fw-semibold);
  display: flex; align-items: center; justify-content: center;
  line-height: 1;
}
.persona-tile-label {
  font-family: var(--font-sans); font-size: var(--fs-sm);
  font-weight: var(--fw-medium); color: var(--color-text);
}
.persona-tile-desc {
  font-size: var(--fs-xs); color: var(--color-text-muted); text-align: center;
}
```

**JS contract:** On click, set `aria-pressed="true"` on the clicked tile, set `aria-pressed="false"` on ALL siblings. Single source of truth for selected state — CSS does the rest. No `.is-active` class needed. **No `aria-checked`.**

### 4.2 Voice Section (NEW)

```css
.voice-tile-row {
  display: flex; gap: var(--sp-2);
  padding: 0 var(--sp-4);
  overflow-x: auto;
  scroll-snap-type: x mandatory;
  -webkit-overflow-scrolling: touch;
}
.voice-tile {
  flex: 0 0 120px;
  scroll-snap-align: start;
  display: flex; flex-direction: column;
  align-items: center; gap: var(--sp-1);
  padding: var(--sp-3) var(--sp-2);
  background: var(--md-sys-color-surface-container);
  border: 2px solid var(--color-border);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: border-color var(--dur-fast) var(--ease-snap);
}
.voice-tile[aria-pressed="true"] {
  border-color: var(--md-sys-color-primary);
  background: var(--md-sys-color-primary-container);
}
.voice-tile-play {
  width: 28px; height: 28px;
  border-radius: 50%;
  background: var(--color-accent-wash);
  border: 1px solid var(--color-border);
  color: var(--md-sys-color-primary);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer;
}
.voice-tile-play:hover { background: var(--md-sys-color-primary-container); }
.voice-tile-name {
  font-size: var(--fs-xs); font-weight: var(--fw-medium); color: var(--color-text);
}
.voice-tile[disabled],
.voice-tile-row[data-call-active="true"] .voice-tile {
  opacity: 0.5; cursor: not-allowed;
}
```

### 4.3 Section Headers

```css
.voice-settings-section-title {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: var(--fw-semibold);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
  color: var(--color-text-muted);
  padding: var(--sp-1) var(--sp-4) var(--sp-3);
  margin: 0;
}
```

### 4.4 Save / Cancel Footer

```html
<div class="voice-settings-footer">
  <button class="btn btn--ghost btn--sm" type="button">Cancel</button>
  <button class="btn btn--primary btn--sm" type="button">Save</button>
</div>
```

```css
.voice-settings-footer {
  flex-shrink: 0;
  display: flex; justify-content: flex-end; gap: var(--sp-2);
  padding: var(--sp-3) var(--sp-4);
  border-top: 1px solid var(--color-border);
}
```

---

## Files to Touch (frontend-dev hand-off)

| File | Changes |
|---|---|
| `scripts/fetch-images.mjs` | **NEW** — image download + sharp pipeline |
| `package.json` | Add `sharp` as devDependency |
| `public/images/{hero,carriers,ambient}/` | **NEW dirs** — WebP assets |
| `css/map.css` | Replace `.map-pin` with truck-chevron + status classes; cluster overrides |
| `css/map.css` (or new section) | `.carrier-panel` styles |
| `js/map-widget.js` | Inline SVG chevron `divIcon`; `is-selected` toggle; carrier panel open/close + ESC + focus return |
| `data/carriers.json` | Add `dot`, `status`, `driver`, `heading`, `speed`, `imageSlug` |
| `css/voice-dock.css` | Replace `.persona-seg` with `.persona-grid` + `.persona-tile`; add voice tile row + footer; mono section title |
| `js/ui.js` `buildPersonaButtons()` | Emit tile-grid markup; enforce single-select via `aria-pressed`; remove `aria-checked` |
| `partials/map.html` | Add `<aside id="carrier-detail-panel">` inside `.map-page` |
| `index.html` | Add `<picture>` hero band |

**Do NOT touch:** `css/tokens.css`, `css/base.css`, `css/components.css` (no new tokens — everything uses existing M3 properties).
