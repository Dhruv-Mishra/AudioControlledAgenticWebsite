# DESIGN.md — Dhruv FreightOps

Active design system. All tokens are CSS custom properties defined in `css/tokens.css`. No hardcoded hex, radius, or spacing values in component styles.

## Direction — "Yard Operator" v3

The page is a dispatch console for a freight brokerage with a live voice agent. Earlier iterations leaned on Linear / Vercel / Geist defaults; the result read as a generic AI dashboard. v3 corrects course toward an operator aesthetic that could plausibly belong on a yard manager's second monitor at 2 a.m. — engineering paper, signal lamps, mechanical type, with one editorial italic for warmth.

## Typography

| Role | Family | Why this and not the obvious choice |
|---|---|---|
| Sans / display | **Bricolage Grotesque** (variable, opsz 12–96, wght 400–800) | Industrial grotesque with a real optical-size axis — surgical at 13 px row text, cast-iron at 64 px display. Wide apertures and a slightly mechanical 'g' / 'a' read like industrial signage. Avoids the Inter / Geist / Space Grotesk / Manrope cluster every AI-generated dashboard converges on. |
| Mono | **DM Mono** (400, 500) | Tabular monospace with a typewriter-leaning 'a' and slashed zero. Used on MC numbers, load IDs, ETAs, lat/lng. Less default than JetBrains Mono / Geist Mono. |
| Editorial accent | **Instrument Serif** (regular + italic, used sparingly) | Reserved for `.hero-numeral` (rate, mileage, latency) and `.eyebrow` italic above section titles. The cold-grotesque-vs-warm-Didone contrast is the project's editorial signature — it is what stops the page reading like every other Vercel-styled console. |

All three are self-hosted under `/public/fonts/` (latin + latin-ext woff2 subsets) so the production CSP keeps `font-src 'self'`. The two files used on first paint (Bricolage latin, DM Mono 400 latin) are preloaded from `index.html`.

## Color

The M3 Expressive lime/dark palette from v2 is preserved — it works for a dispatch console and the contrast ratios are already validated. Tokens live in `css/tokens.css`. Dark is the default; light is opt-in via `data-theme="light"`.

- **Dominant**: M3 surface ladder (`--md-sys-color-surface*`) painting an inky-green console.
- **Primary accent**: lime (`--md-sys-color-primary`, `#BEF264`) — single hot accent used for active states, the voice-agent listening ring, and pin selection.
- **Tertiary accent**: cool tertiary cyan — wayfinding, info, route lines.
- **Warn / danger**: amber + soft red.

## Atmosphere

Stripped flat in v2; restored deliberately in v3 via `body::before` and `body::after` in `css/base.css`:

1. **Signal-lamp radial washes** — top-right amber-lime, bottom-left cool tertiary, both at low opacity using `color-mix()` against the active palette so theme switching updates them automatically.
2. **Engineering-paper grid** — 32 px hairline grid stamped from a pair of repeating linear gradients, masked to fade out toward the corners. No SVG asset, no extra request.

The atmosphere is fixed-position, sits behind all content (`z-index: -2 / -1`), and is `pointer-events: none` so it never catches input. Light mode tones both layers down ~30%.

## Motion

- Tokens unchanged from v2 (`--dur-fast`, `--dur-base`, `--dur-slow`, M3 emphasized easings).
- **One orchestrated entrance per route mount**: `#route-target > *` fade-and-lift staggered at 20 → 320 ms via `:nth-child` delays. The map page opts out (full-bleed surface owns its own entrance).
- Micro-interactions kept where they already exist (pin pulse, chip hover, dock state). Reduced-motion users get the end state instantly via the global override in `base.css`.

## Imagery

Carrier portraits remain in `public/images/carriers/*.webp`. No new hero photography was sourced for this pass — the dispatch-console aesthetic deliberately pushes data-density over marketing imagery. A future pass can layer freight photography behind empty states (`/dispatch` empty queue, `/carriers` no results) where it would contribute warmth without competing with live data.

## Map UX

The Leaflet map widget had a critical bug — the user could zoom out far enough that the world tiled into a repeating strip — and was otherwise functional but visually bland. v3 fixes the bug and upgrades the basemap, attribution, and lane treatment. Deeper interaction work (custom marker SVG language, marker clustering, mobile bottom-sheet snap-points) remains scoped as a follow-up.

### Basemap

OpenStreetMap raw raster has been swapped for **CARTO Voyager** (light theme) and **CARTO Dark Matter** (dark theme), selected at mount time via `data-theme` on `<html>`. CARTO's free tier permits hot-linking with the attribution `© OpenStreetMap contributors · © CARTO`, which the widget renders into the existing `#map-attribution` chip. The CSP `img-src` allow-list now includes `https://*.basemaps.cartocdn.com` in [`deploy/nginx/jarvis.whoisdhruv.com.conf`](deploy/nginx/jarvis.whoisdhruv.com.conf) and the three Playwright smoke scripts under `scripts/`.

### Lane animation

Active routes use a lime stroke with a 14/10 dasharray and a 1.4 s linear `stroke-dashoffset` animation — the line reads as freight in motion. Pending lanes use the warn token, a 6/6 dash, and a slower 2.2 s loop. `prefers-reduced-motion` freezes both.

### Bug — repeating world strip on zoom out

Fixed in `js/map-widget.js` by combining four Leaflet options that all have to be set together:

1. `tileLayer({ noWrap: true, bounds: WORLD_BOUNDS, ... })` — Leaflet stops requesting tiles outside `[-180, 180]`, which is the actual source of the repeating strip.
2. `L.map({ worldCopyJump: false })` — markers don't teleport across antimeridian copies.
3. `L.map({ maxBounds: WORLD_BOUNDS, maxBoundsViscosity: 1.0 })` — pan rubber-bands hard at the world envelope, so the user physically cannot drag past one world copy.
4. `L.map({ minZoom })` computed dynamically as `ceil(log2(canvasWidth / 256))` and re-applied via the existing `ResizeObserver`. At every viewport width — 360 px phone through 2560 px desktop — the world is at least as wide as the canvas, so it never tiles. If the current zoom drops below the new floor on resize, the widget snaps zoom up to clear the gap.

The `ABSOLUTE_MIN_ZOOM = 2` floor prevents anyone from constructing a container so wide that the math drops below sensible.

## Components

The component spec from v2 (chips, dock, tables, persona toggle, noise selector, status pills) is unchanged. New utilities in v3:

- **`.hero-numeral`** — Instrument Serif italic, tight leading, lining figures. Use for the largest single number on a card (rate, miles, ms latency).
- **`.eyebrow`** — Instrument Serif italic, muted, sentence case. Use above a section title where a label would have read as bureaucratic.

## Accessibility

Unchanged. `prefers-reduced-motion` honored on the new route reveal (via the existing global override). Atmosphere layers are pointer-inert and contrast for body text remains comfortably above WCAG AA (palette unchanged from v2).

## What to avoid

- Generic AI fonts: Inter, Roboto, Arial, system-ui defaults, **Geist**, **Space Grotesk**, Manrope.
- Purple-on-white gradients.
- Animation longer than `--dur-slow` (320 ms).
- Decoration that competes with live data on dense surfaces (table rows, the dock, the map canvas).
- Hardcoded colors / spacing — token everything.

## Alignment with root

Root is CLAUDE.md — vanilla HTML/CSS/JS, mobile-first, 2-space indent, tokens for all design values. No divergences. No framework introduced.
