# Carrier Panel Fix Spec

## 1. Containing block — keep in `.map-page`

Stay as a child of `#map-root.map-page`. Add `isolation: isolate` to `.map-canvas` so Leaflet's internal z-indices (200–1000) are contained.

## 2. Coexistence with `.map-detail` — mutual exclusion

`openCarrierPanel()` calls `closeDetailPanel()` first. `openDetailPanel()` calls `closeCarrierPanel()` first.

## 3. Sizing — compact, top-anchored, internally scrollable

```css
.carrier-panel {
  top: var(--sp-4);
  right: var(--sp-4);
  bottom: auto;                /* DROP */
  width: 352px;
  max-height: min(640px, calc(100% - var(--sp-4) * 2));
}
```

Body already has `flex: 1 1 auto; overflow-y: auto`.

## 4. Z-index

Add `--z-map-panel: 1100` to tokens.css (above Leaflet's 1000). Apply to `.carrier-panel` and `.map-detail`. (Alternative: keep `--z-map-ui` but bump to 1100.) Decision: use a dedicated `--z-map-panel: 1100`.

## 5. Hidden → translate animation fix

Drop `[hidden] { display:none }` rule and the `hidden` attribute. Use `visibility: hidden + pointer-events: none` in the base state, flipped on `.is-open`.

```css
.carrier-panel { display: flex; visibility: hidden; pointer-events: none; }
.carrier-panel.is-open { visibility: visible; pointer-events: auto; }
```

JS: drop `carrierPanel.hidden = false; void offsetWidth;`. Just toggle `.is-open` and `aria-hidden`.

## 6. Image fallback

Remove empty `srcset=""` and `src=""` from markup. Add a placeholder background:

```css
.carrier-panel-hero { background: var(--color-bg-elev-2); }
```

## 7. Mobile bottom sheet — verified

Existing `@media (max-width: 640px)` override stands. `bottom: auto` desktop value is replaced by `bottom: 0` on mobile. `max-height: 70dvh` retained.

## 8. Hand-off — files to touch

| File | Changes |
|---|---|
| `css/tokens.css` | Add `--z-map-panel: 1100;` |
| `css/map.css` | `.map-canvas` add `isolation: isolate`. `.carrier-panel`: new top/right/bottom/width/max-height; switch to `visibility/pointer-events`; bump z-index to `--z-map-panel`. Delete `.carrier-panel[hidden]`. `.carrier-panel-hero` add background. Apply `--z-map-panel` to `.map-detail` too. |
| `partials/map.html` | Remove `hidden` from `#carrier-detail-panel`, add `aria-hidden="true"`. Remove empty `srcset` and `src` attributes. |
| `js/map-widget.js` | `openCarrierPanel`: prepend `closeDetailPanel()` call; remove `hidden`/offsetWidth dance; toggle `aria-hidden` instead. `closeCarrierPanel`: set `aria-hidden=true` instead of `hidden=true`. `openDetailPanel`: prepend `closeCarrierPanel()` call. |
