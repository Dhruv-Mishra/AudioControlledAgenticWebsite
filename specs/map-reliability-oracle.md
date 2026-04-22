# Map Reliability — Oracle Decisions

Written 2026-04-22. Scope: make the /map.html feature action-reliable and teardown-clean for agent-driven flows. Every recommendation below is **decided**, not optional.

---

## 0. Headline decisions

1. **Drop the document-event bridge.** Tool handlers call the widget's public API directly. Events are removed — not dual-supported.
2. **Widget exposes a `ready` Promise** on `window.__mapWidget`. Handlers `await window.__mapWidget.ready` before any call. Ready is only settled once Leaflet is created, tiles started, and markers are registered.
3. **Disable markercluster entirely** for the current dataset (~20 pins). Re-enable only if the dataset grows past 40.
4. **Every widget method returns `{ ok, result?, error?, code? }`.** Tool handlers forward `{ok:false, error}` verbatim — no silent successes.
5. **Single source of teardown authority:** `page-map.js::exit` calls `instance.destroy()` which disposes every listed resource in a checklist below. No resource may be created anywhere else.
6. **Loading skeleton + tile-retry banner are mandatory.** An empty gray `#map-canvas` is a failure-mode leak to the user.

---

## 1. Reliability gap list

Severity legend: **[C]** = Critical (action silently fails or leaks), **[W]** = Warning (user-visible jank), **[S]** = Suggestion.

### [C1] Event race: tool fires before widget mounts
- Today: `ensureMapPage() → router.navigate('/map.html') → await setTimeout(0) → dispatchEvent('map:highlight-load')`. But `createMap()` is `async` and does `injectLeafletCss()` + `loadLeaflet()` + `loadMarkerCluster()` — tens of ms minimum, often 100–300 ms on cold cache. The event fires, the listeners aren't attached yet, the event is **lost forever**.
- Fix: Replace the event bridge with direct API calls gated on `window.__mapWidget.ready` (section 3).
- Files: `js/app.js:65–96`, `js/page-dispatch.js:203–213`, `js/map-widget.js:791–806`.

### [C2] Event race: Dispatch fleet-map lane-row click
- Same flaw. `page-dispatch.js:207` fires the event 50 ms after `router.navigate('/map.html')`. The 50 ms is a superstition; cold-cache Leaflet load exceeds it routinely.
- Fix: Identical to C1 — lane-row handler awaits `window.__mapWidget.ready`.
- File: `js/page-dispatch.js:203–213`.

### [C3] `map_focus` with unknown target silently "succeeds"
- Today: `focusTarget` returns `false` for no-match; `onFocus` event handler ignores the return; `map_focus` handler returns `{ok: true, focused: target}` regardless. Agent says "I centered on Toronto" after doing nothing.
- Fix: Error envelope (section 4). Widget returns `{ok:false, code:'target_not_found', error:'No city, state, or id matched "…".'}`. Handler relays it; agent gets a correct fail signal and can recover.
- File: `js/map-widget.js:645–695`, `js/app.js:65–79`.

### [C4] `map_highlight_load` with unknown id silently "succeeds"
- Same class as C3. `highlightLoad` returns `false`; `onHighlight` listener ignores; handler replies `ok:true`.
- Fix: Widget returns `{ok:false, code:'load_not_found', error:'Load id "…" not in current dataset.'}`. Handler throws it.
- File: `js/map-widget.js:697–705`, `js/app.js:81–87`.

### [C5] `map_show_layer` with unknown layer name silently "succeeds"
- `setLayerVisible` returns `false` for unknown names; handler ignores return.
- Fix: `{ok:false, code:'unknown_layer', error:'Layer "…" not recognised. One of loads|carriers|lanes|delayed.'}`.
- File: `js/map-widget.js:707–730`, `js/app.js:89–96`.

### [C6] Clustering hides `data-agent-id` pins
- When two pins are close, `markercluster` replaces their DOM elements with a single cluster icon. The pin's `data-agent-id="map.pin.LD-10824.pickup"` is no longer present in DOM, so `tool-registry.findByAgentId` returns null and `scanAgentElements` skips it (the underlying element isn't visible or may not even be in DOM). The agent loses addressability the moment the map zooms out.
- Fix: **Disable clustering for this dataset.** Replace `L.markerClusterGroup(...)` with `L.layerGroup()` for `loadLayer`. Remove `loadMarkerCluster(L)` call, drop the `MARKERCLUSTER_URL` script load, delete `MarkerCluster.css`/`MarkerCluster.Default.css` injections. Rationale: ~20 markers is far below the threshold where clustering helps; we already pay reliability cost for zero user benefit.
- Files: `js/map-widget.js:138–152, 253–260, 733–741`, the three CSS links in `injectLeafletCss`.

### [C7] Teardown leaks `document` listeners and the global handle
- Current `destroy()` removes listeners, but on **first `createMap` failure** (e.g., tile server unreachable, Leaflet script 404), the error throws before `api` is constructed → nothing is cleaned up, `window.__mapWidget` might already be set from a prior mount, and `page-map.js::exit` finds `instance === null` so nothing runs.
- Related: `document.addEventListener('keydown', onKeydown)` in `createMap` is removed, but the **listener registration itself happens after the `await`s** — if the caller rejects mid-load, any partial state is orphaned.
- Fix: See teardown checklist (section 8). `createMap` uses a single `cleanup` array pattern: every resource registers its own dispose function immediately, and a `throw` path runs all of them in reverse.
- Files: `js/map-widget.js:203–842`, `js/page-map.js:17–39`.

### [C8] Tile-fetch failures leave the canvas black forever
- No loading indicator while Leaflet loads; no retry on tile 429/500; no attribution fallback. `crossOrigin: true` on `L.tileLayer` doesn't help because OSM doesn't send CORS headers for images — this is actually **wrong today** and should be `crossOrigin: false` or omitted.
- Fix: Add a skeleton overlay inside `#map-canvas` shown until `map.on('load')` + first tile `tileload` fires, then faded out. Add a tile-error banner that appears after >2 s of `tileerror` events with no intervening `tileload`. See section 7.
- File: `js/map-widget.js:235–239`, `partials/map.html:19`, `css/map.css`.

### [W1] Rapid sequential `flyTo` calls
- Agent pattern: `map_focus('TX')` then `map_highlight_load('LD-10824')` within ~200 ms. Leaflet's `flyTo` cancels the in-flight animation and starts a new one; visually jarring. `setView` doesn't animate.
- Fix: The public methods accept an `{ animate }` opt. The widget maintains `this._lastCallAt`; if the new call is within 400 ms, it forces `animate:false` (setView/fitBounds-sans-fly). Apply to `panTo`, `focusLoad`, `focusCarrier`, `focusTarget`. User-initiated calls (zoom buttons, chip clicks) always animate — the debounce only affects agent-driven back-to-backs.
- File: `js/map-widget.js:595–695`.

### [W2] `flyTo` animates even under `prefers-reduced-motion` via agent actions
- `smoothOpts = { animate: !reduced, duration: reduced ? 0 : 0.28 }` is correct at creation time but `prefers-reduced-motion` can change while the page is open. Query at each call site or re-read on `matchMedia` change events.
- Fix: Replace `smoothOpts` constant with `getSmoothOpts()` that reads the live matchMedia value; also register a `change` listener on the MediaQueryList and re-pass map options isn't possible (Leaflet freezes them at create), but the per-call opts pick up the new value.
- File: `js/map-widget.js:597, 602, 614–616, 631, 665, 672, 683, 691, 764–768`.

### [W3] Detail-panel focus behavior inconsistent
- Today: detail is `role="dialog" aria-modal="false"`. Opening it focuses the close button. Esc closes and restores focus. But because `aria-modal="false"`, AT users aren't told they're in a dialog; Tab escapes the panel. The mobile bottom-sheet especially needs clear semantics.
- Fix (no half-measures): Keep `aria-modal="false"`, **remove `role="dialog"`** (it misrepresents when there's no trap), make it `<aside role="complementary" aria-label="Load detail">`. That matches actual behavior: a non-modal side sheet, Esc-dismissible, focus-restoring. No focus trap is needed since the pane has only 2 focusables (close button + scroll content) and shares screen real estate with the map by design.
- File: `partials/map.html:20`, `js/map-widget.js:500–540`.

### [W4] `#map-canvas` has `tabindex="0"` + `role="application"`; Leaflet also makes it keyboard-navigable
- That's fine, but screen-reader `aria-label` should update as the map moves. Today it says "Use arrow keys to pan…" forever. Not critical — keep as-is, do not over-engineer.
- Fix: Add a live region (reuse router's `#route-live-region`) that announces "Focused on Chicago, IL" when the agent drives a fly-to. Call `window.__routeLiveRegion.textContent = 'Focused on …'` inside each focus method.
- File: `js/map-widget.js` focus methods.

### [W5] Carrier "HQ" is a hardcoded table; agent can't find carriers added later
- Accepted: out of scope for this round. Future migration should fold HQ into `data/carriers.json` as a `hq` field.

### [W6] Delayed-only filter rebuilds the whole cluster/layer
- `applyDelayedFilter` calls `loadLayer.clearLayers()` then re-adds. That tears out Leaflet's internal marker state including the `data-agent-id` attribute we assigned (we re-set it on add; the filter path re-adds existing markers without re-tagging).
- Fix: After `loadLayer.addLayer(m)` inside `applyDelayedFilter`, re-apply the `data-agent-id` from registry. Or: call `addLoadMarker` path unconditionally; only toggle visibility via `marker.setOpacity` + `marker.options.interactive`. Simpler: use a flat `layerGroup` (since we're disabling cluster per C6) and just add/remove individual markers while preserving their original element tags.
- File: `js/map-widget.js:732–741`.

### [W7] `setTimeout(r,0)` in `ensureMapPage` is a tell, not a fix
- Remove it entirely once we switch to the ready-Promise API.
- File: `js/app.js:62`.

### [W8] Mobile: filter rail becomes horizontal strip; items list hides
- The CSS at `css/map.css:305–329` disables `.map-filter-list` under 900 px. That means on mobile the only filter UI is chip toggles + search — no list of items. Accepted; list-view toggle still gives a full readable catalogue.
- Fix: Verify the "List view" button is still reachable on mobile; currently its container `.map-list-toggle-wrap` is also `display:none` under 900 px (line 326). **Bug**: no way to flip to list view on mobile.
- File: `css/map.css:323–326`. Remove `.map-list-toggle-wrap` from the mobile-hide list.

### [W9] Search input lacks debounce
- Every keystroke rebuilds the full filter list. ~20 items — fine today, but `renderFilterList` runs a full string-match and DOM rebuild per key. Debounce at 80 ms to be polite; not load-bearing.
- File: `js/map-widget.js:761`.

### [S1] `crossOrigin: true` on tile layer
- OSM doesn't set CORS headers for tile PNGs; `crossOrigin: true` makes the browser attempt a CORS-mode fetch which can fail quietly. Remove the option (the default handles standard image loading).
- File: `js/map-widget.js:238`.

### [S2] Data loader has no fallback
- `loadData()` in `page-map.js` does parallel `fetch` with no try/catch. If `/data/loads.json` 404s at runtime, the error bubbles to `createMap` as `undefined` and crashes in `loads.forEach(addLoadMarker)`.
- Fix: `Promise.all([...]).catch(err => { throw new Error('Could not load map data: ' + err.message); })` → `page-map.js::enter` catches and renders an inline error banner in `#map-root`.
- File: `js/page-map.js:9–15, 17–29`.

### [S3] Duplicate `const cls` shadowing
- `map-widget.js:293` declares `const cls = 'map-pin--…'`; line 334 redeclares `const cls = pending ? 'map-lane…' : 'map-lane'`. Works (different blocks) but is confusing. Rename one.
- File: `js/map-widget.js:293, 334`.

### [S4] No guard against double `createMap` on the same root
- Quick double-navigate to /map.html could race and produce two map instances on the same element.
- Fix: Early in `createMap`, if `canvas._leaflet_id` is set, call `map.remove()` via a lookup and start clean. Or simpler: `page-map.js::enter` checks `if (instance) await exit();` at entry.
- File: `js/page-map.js:17–29`.

---

## 2. Widget API freeze

This is the contract frontend-dev implements verbatim. **No additional methods are exposed.** Everything on the returned `api` object must be on `window.__mapWidget` and all methods return the error envelope shape.

```ts
// Error envelope — one shape across all widget methods and tool handlers.
type MapOk<T> = { ok: true; result: T };
type MapErr = { ok: false; error: string; code: MapErrorCode };
type MapErrorCode =
  | 'target_not_found'     // string target matched no city/state/id
  | 'load_not_found'       // highlightLoad id not in registry
  | 'carrier_not_found'    // focusCarrier id not in registry
  | 'unknown_layer'        // setLayerVisible layer name unrecognised
  | 'bad_input'            // missing/invalid arg (lat NaN, empty string)
  | 'not_ready'            // widget accessed before ready resolved
  | 'tile_error'           // tile provider failed persistently
  | 'destroyed';           // called after destroy()

interface MapWidget {
  // Resolves once Leaflet is up, tiles started, markers registered.
  // Rejects if the first-mount tile fetch fails repeatedly (>2 s, >3 tiles) —
  // callers see a user-visible failure state.
  readonly ready: Promise<void>;

  // Has destroy() been called? When true every method returns
  // { ok:false, code:'destroyed' } without side effects.
  readonly isDestroyed: boolean;

  panTo(lat: number, lng: number, zoom?: number, opts?: { animate?: boolean }):
    MapOk<{ lat: number; lng: number; zoom: number }> | MapErr;

  // target = 'Chicago, IL' | 'TX' | 'LD-10824' | 'C-204' | {lat, lng, zoom?}
  focusTarget(target: string | { lat: number; lng: number; zoom?: number }):
    MapOk<{ matched: 'city' | 'state' | 'load' | 'carrier' | 'coords'; label: string }> | MapErr;

  highlightLoad(loadId: string):
    MapOk<{ load_id: string; pickup?: string; dropoff?: string }> | MapErr;

  focusCarrier(carrierId: string):
    MapOk<{ carrier_id: string; city: string }> | MapErr;

  setLayerVisible(layer: 'loads' | 'carriers' | 'lanes' | 'delayed', on: boolean):
    MapOk<{ layer: string; visible: boolean }> | MapErr;

  // Called by page-map.js::exit. Idempotent. Releases every resource
  // in section 8's checklist.
  destroy(): void;
}
```

### Ready semantics — exact wording

`ready` is a single memoized Promise, resolved in this order:
1. Leaflet UMD loaded (`window.L.map` is a function).
2. `L.map(canvas, …)` created without throwing.
3. Tile layer added to map.
4. All load + carrier markers added, registry fully populated.
5. `setLayerVisible` chips wired, search input bound, zoom/reset bound.
6. The first tile's `tileload` event has fired (or `tileerror` retries exhausted — see section 7).

Only after step 6 does `ready` resolve. Before that, **every method except `destroy` returns `{ ok:false, code:'not_ready' }`.**

**Why step 6?** A method called between step 5 and 6 would succeed silently but the user sees a blank canvas — bad UX. Gating on first-paint closes the race.

**Budget.** Step 6 must complete within 2500 ms on a warm cache. If it exceeds 5000 ms, `ready` rejects with `code:'tile_error'`. Rejection triggers the tile-error banner (section 7).

### Destroy semantics

Calling `destroy()` flips `isDestroyed=true` synchronously. All subsequent method calls return `{ok:false, code:'destroyed'}` immediately without touching Leaflet (which is already torn down). `ready` never resolves after destroy if it hasn't already. Safe to call from anywhere, any number of times.

---

## 3. Migration: event bridge → direct API

**Decision: REPLACE. No dual-support.** Event bridge is removed outright.

### Rationale
- Dual-support doubles the surface area we have to reason about — every bug hunt has to rule out both paths.
- The document events were never part of a public contract — they're an internal wiring that frontend-dev + app.js own end-to-end.
- The ready-Promise pattern is strictly more expressive: it handles "not ready yet" and "method failed" in a single return value; events can only encode "happened" (not "happened successfully").

### Migration steps (exact files)

1. **`js/map-widget.js`:**
   - Remove the `onFocus`, `onHighlight`, `onShowLayer` closures (lines 791–806).
   - Remove `document.addEventListener('map:…')` calls.
   - Remove corresponding `document.removeEventListener` calls in `destroy`.
   - Expand `api` object to match section 2's interface (wrap every method to return the envelope).
   - Add `ready` promise that resolves at the end of `createMap` AFTER step 6.
   - Set `window.__mapWidget = api` before step 6 so app.js can reach it and `await api.ready`.

2. **`js/app.js`** (handlers become, verbatim):
   ```js
   async function ensureMapWidget() {
     if (location.pathname !== '/map.html') {
       await router.navigate('/map.html');
     }
     const w = window.__mapWidget;
     if (!w) throw new Error('Map did not mount.');
     await w.ready;
     return w;
   }

   agent.toolRegistry.registerDomain('map_focus', async (args) => {
     // Validate BEFORE navigating.
     let target;
     if (args && Number.isFinite(Number(args.lat)) && Number.isFinite(Number(args.lng))) {
       target = { lat: Number(args.lat), lng: Number(args.lng), zoom: args.zoom };
     } else if (args && typeof args.target === 'string' && args.target.trim()) {
       target = args.target.trim();
     } else {
       throw new Error('map_focus requires target (string) or lat+lng (numbers).');
     }
     const w = await ensureMapWidget();
     const r = await w.focusTarget(target);
     if (!r.ok) throw new Error(r.error);
     return r.result;
   });

   agent.toolRegistry.registerDomain('map_highlight_load', async (args) => {
     const id = args && typeof args.load_id === 'string' ? args.load_id.trim() : '';
     if (!id) throw new Error('map_highlight_load requires load_id.');
     const w = await ensureMapWidget();
     const r = await w.highlightLoad(id);
     if (!r.ok) throw new Error(r.error);
     return r.result;
   });

   agent.toolRegistry.registerDomain('map_show_layer', async (args) => {
     const layer = args && typeof args.layer === 'string' ? args.layer.toLowerCase().trim() : '';
     const visible = !!(args && args.visible);
     if (!layer) throw new Error('map_show_layer requires layer.');
     const w = await ensureMapWidget();
     const r = await w.setLayerVisible(layer, visible);
     if (!r.ok) throw new Error(r.error);
     return r.result;
   });
   ```
   - Remove `ensureMapPage`'s `setTimeout(r, 0)` — no longer needed.

3. **`js/page-dispatch.js:203–213`** (lane-row click):
   ```js
   const openMap = async () => {
     if (window.__router && typeof window.__router.navigate === 'function') {
       await window.__router.navigate('/map.html');
     } else {
       location.href = '/map.html';
       return;
     }
     const w = window.__mapWidget;
     if (!w) return; // race w/ load error; silent no-op is fine here (user-initiated)
     try { await w.ready; } catch { return; }
     await w.highlightLoad(l.id); // return value ignored — UI-driven, not agent
   };
   ```
   - Remove the `setTimeout(50)` and the `document.dispatchEvent('map:highlight-load')`.
   - Note: user-initiated clicks tolerate "no-op if failed"; agent calls do not.

4. **Backward compat:** None. The event bridge never had any external consumers — all uses are in this codebase and get replaced in one PR.

---

## 4. Error contract enforcement (per method)

Every widget method's envelope:

| Method | `ok:true` payload | `ok:false` code + error string template |
|---|---|---|
| `panTo(lat,lng,zoom?)` | `{lat, lng, zoom}` | `bad_input: "panTo: lat/lng must be finite numbers."` |
| `focusTarget(target)` | `{matched, label}` | `bad_input: "focusTarget: empty target."` / `target_not_found: 'No city, state, or id matched "X". Known cities in current coverage: …(top 5)…'` |
| `highlightLoad(id)` | `{load_id, pickup, dropoff}` | `bad_input: "highlightLoad: empty id."` / `load_not_found: 'Load "X" not in current dataset. (N loads total.)'` |
| `focusCarrier(id)` | `{carrier_id, city}` | `carrier_not_found: 'Carrier "X" not in current dataset.'` |
| `setLayerVisible(layer,on)` | `{layer, visible}` | `unknown_layer: 'Layer "X" not recognised. One of: loads, carriers, lanes, delayed.'` |
| any, post-destroy | — | `destroyed: 'Map has been torn down.'` |
| any, pre-ready | — | `not_ready: 'Map not mounted yet.'` |
| first-mount fails | — | `tile_error: 'Tile provider unreachable after retries.'` |

The **error string is the user-facing phrase** — tool handler throws it as-is and Gemini repeats it (or paraphrases). Keep them short, declarative, and free of internal vocab like "registry".

---

## 5. Clustering decision

**Disable markercluster entirely.** Rationale:
- Dataset size is ~20 markers. Clustering helps at 100+ overlapping markers; at 20 it only hides information.
- Clustering **breaks agent addressability** — a clustered pin's `data-agent-id` disappears from DOM, so `list_elements` doesn't surface it and `findByAgentId` returns null. Critical reliability failure (gap C6).
- Removing the plugin saves ~10 KB gzip + 2 KB CSS + one network round-trip + `loadMarkerCluster()` call.
- If/when the dataset grows past 40, re-enable with a hard requirement that the widget **auto-spiderfies** the cluster containing a requested pin before `highlightLoad` returns (via `cluster.zoomToShowLayer(marker, () => resolve)`). Punt on that until it matters.

**Exact change:** swap `L.markerClusterGroup(...)` at `map-widget.js:253` for `L.layerGroup()`. Delete `loadMarkerCluster` call, `loadMarkerCluster` function, `_markerClusterPromise`, `MARKERCLUSTER_URL`, and the two `MarkerCluster*.css` hrefs in `injectLeafletCss`. Also delete `.map-cluster` styles and `iconCreateFunction`.

---

## 6. Reduced-motion matrix

Audit every animation surface. **Single rule**: all timings are gated by a live `prefersReducedMotion()` check (re-read per call, not cached at mount). CSS transitions + animations are additionally gated by a `@media (prefers-reduced-motion: reduce)` block that zeroes them.

| Site | File / line | Default behavior | Reduced-motion behavior |
|---|---|---|---|
| Map options `zoomAnimation` / `markerZoomAnimation` / `fadeAnimation` | `map-widget.js:229–231` | true | false (set at create; re-mount on media change is acceptable — user-triggered via OS toggle is rare mid-session) |
| `panTo` / `flyTo` smoothness | `map-widget.js:597, 602, 616, 631` | `{animate:true, duration:0.28}` | `{animate:false, duration:0}` — use `map.setView` directly |
| `flyToBounds` | `map-widget.js:614` | animated | `fitBounds` without animation |
| Zoom buttons | `map-widget.js:764–765` | animated | `zoomIn/Out(1, {animate:false})` |
| Reset button | `map-widget.js:766–768` | `flyTo` | `setView` |
| State matches fly-to | `map-widget.js:683` | `flyToBounds` | `fitBounds` |
| Detail panel slide-in | `css/map.css:207, 213, 343, 346` | `transform 0.28s` | `transform: none; transition: none` via `@media (prefers-reduced-motion: reduce)` |
| Detail panel transitionend close | `map-widget.js:525–539` | wait for transitionend | call `done()` immediately (already implemented — keep) |
| Pin hover scale | `css/map.css:105–109` | `transition: transform var(--dur-fast)` | disable transition |
| Pin `flash` animation (`is-agent-highlighted`) | `css/map.css:139–143`, `map-widget.js:638–643` | 1200 ms outline + animation | still flash but via instant outline toggle (no `animation` keyframes); keep `setTimeout(..., 1400)` to clear |
| Popup open/close | Leaflet default | built-in fade | Leaflet's `fadeAnimation:false` covers it |

**CSS addendum** (single block at end of `css/map.css`):

```css
@media (prefers-reduced-motion: reduce) {
  .map-detail { transition: none; transform: none; }
  .map-detail.is-open { transform: none; }
  .map-pin { transition: none; }
  .map-pin.is-agent-highlighted { animation: none; }
}
```

---

## 7. Tile provider retry + fallback

### Loading skeleton

While `ready` is pending, show a skeleton inside `#map-canvas`:
- Absolutely-positioned overlay with `var(--color-bg-elev-1)` background, centered spinner + "Loading map…" text.
- `.map-canvas.is-loading::after` pseudo-element with the text; removed by adding `.is-loaded` class once `ready` resolves.
- Aria: `aria-busy="true"` on `#map-canvas` while loading; removed on ready.

### Tile retry policy

Leaflet's `L.tileLayer` does not retry failed tiles by default. Since we're using OSM (rate-limited on heavy load) and don't control the network:

1. **Listen to `tileerror` events** on the tile layer.
2. On `tileerror`, schedule a single re-fetch for that tile after 800 ms + jitter. Track retry count per-tile; give up after 2 retries.
3. Track `tilesFailed` counter. If it exceeds 5 within a 10 s window → show tile-error banner.

Implementation sketch (in `map-widget.js` after creating the tileLayer):
```js
const tileState = { failed: 0, lastFailAt: 0, retries: new Map() };
tileLayer.on('tileerror', (ev) => {
  const now = Date.now();
  if (now - tileState.lastFailAt > 10_000) tileState.failed = 0;
  tileState.lastFailAt = now;
  tileState.failed++;
  const key = ev.coords ? `${ev.coords.z}/${ev.coords.x}/${ev.coords.y}` : Math.random();
  const tries = tileState.retries.get(key) || 0;
  if (tries < 2) {
    tileState.retries.set(key, tries + 1);
    setTimeout(() => tileLayer.redraw(), 800 + Math.random() * 400);
  }
  if (tileState.failed > 5) showTileErrorBanner();
});
tileLayer.on('tileload', () => { tileState.failed = Math.max(0, tileState.failed - 1); });
```

### Fallback provider

**Decision:** Do NOT auto-swap tile provider on failure. Reason: that trades a reliability problem for an attribution/compliance problem — we'd be silently switching the user to a provider we haven't declared.

Instead, the tile-error banner:
- Inline, above the attribution, with `role="alert"`.
- Text: "Map tiles unavailable. Check your connection. [Retry]"
- Retry button calls `tileLayer.redraw()` and resets `tileState.failed = 0`.
- If `STADIA_API_KEY` is set (env var surfaced via `/api/config`), the banner includes a second button: "[Try fallback]" which recreates the tile layer using the Stadia URL. Keep the infra but don't auto-swap — operator opts in.

**Budget:** Banner shows within 2 s of first tile error (when count > 5) or when `ready` rejects with `tile_error`.

---

## 8. Teardown checklist — exhaustive

Every resource `createMap` creates must have exactly one disposer. All disposers run inside `destroy()` in reverse registration order. `destroy()` is idempotent and `isDestroyed` is set synchronously at entry.

### Resources to dispose

1. **Leaflet map instance** — `map.remove()` (handles DOM teardown, event listeners on the canvas, tile layer, marker layers).
2. **All marker objects + popup DOM** — released by `map.remove()` but explicitly clear `registry.clear()` to release our references.
3. **Layer groups** — `loadLayer`, `carrierLayer`, `laneLayer`. Released by `map.remove()`; no extra action needed but set references to null.
4. **`document` keydown listener** — `document.removeEventListener('keydown', onKeydown)`.
5. **Tile layer error tracking state** — clear `tileState.retries` Map, null out references.
6. **Tile-error retry setTimeouts** — track in an array, clear each with `clearTimeout`.
7. **Pin-flash setTimeouts** — `flash()` creates a 1400ms timer; track them on the widget, clear all on destroy.
8. **Detail-panel `transitionend` listener** — already cleaned up per-close via `once:true`-equivalent (removeEventListener in `done`), but if destroy fires mid-transition the listener may stick. Track pending listeners on the widget; remove in destroy.
9. **ResizeObserver** — `ro.disconnect()`; null out reference. (Current code calls `unobserve` but `disconnect` is idempotent.)
10. **`window.__mapWidget` global** — `if (window.__mapWidget === api) delete window.__mapWidget`.
11. **Ready promise** — if still pending when destroy fires, reject it with `{ok:false, code:'destroyed'}` or let it never settle (callers must handle `isDestroyed`). Prefer **reject**, so `await ready` awakens and branches to error path.
12. **Filter list DOM event listeners** — `filterList.replaceChildren()` on each `renderFilterList` already clears old children; in destroy, call `replaceChildren()` once for cleanliness.
13. **Search input listener** — removed with partial swap when `page-map.js::exit` lets the router wipe `#route-target.innerHTML`. Belt-and-suspenders: null out `searchInput` reference.
14. **Filter-rail chip listeners** — same as above.
15. **Media-query `change` listener** (from W2's fix) — `mql.removeEventListener('change', onMotionChange)`.
16. **`<main class="app-main--map">` flag** — removed in `page-map.js::exit`; keep.
17. **CSS link tags** (`<link data-leaflet-css>`) — **DO NOT remove.** They're cheap and survive across mounts, which is an intentional optimisation. Leaving them is correct.
18. **Vendor script tags** (`<script data-vendor-src>`) — **DO NOT remove.** Same reason — re-mounting the map must not re-download Leaflet.

### page-map.js::exit checklist (verbatim)

```js
export function exit() {
  // Destroy happens even if createMap threw — instance may be {api, destroy}
  // or just a partial object. Be defensive.
  if (instance && typeof instance.destroy === 'function') {
    try { instance.destroy(); } catch (err) { console.error('[page-map] destroy', err); }
  } else if (instance && instance.api && typeof instance.api.destroy === 'function') {
    // legacy shape {api, destroy} vs new shape with api exposing destroy
    try { instance.api.destroy(); } catch {}
  }
  instance = null;
  agentRef = null;
  const main = document.querySelector('.app-main.app-main--map');
  if (main) main.classList.remove('app-main--map');
  // Defensive: wipe the global even if destroy missed it (partial-mount failure).
  if (window.__mapWidget) { try { delete window.__mapWidget; } catch { window.__mapWidget = undefined; } }
}
```

### createMap cleanup pattern (verbatim)

```js
export async function createMap(root, { loads, carriers }) {
  const cleanups = [];
  const track = (fn) => cleanups.push(fn);
  let destroyed = false;
  let readyResolve, readyReject;
  const ready = new Promise((res, rej) => { readyResolve = res; readyReject = rej; });

  const api = {
    get isDestroyed() { return destroyed; },
    ready,
    // methods populated later…
    destroy() {
      if (destroyed) return;
      destroyed = true;
      // Run cleanups in reverse registration order.
      for (let i = cleanups.length - 1; i >= 0; i--) {
        try { cleanups[i](); } catch (err) { console.error('[map-widget] cleanup', err); }
      }
      cleanups.length = 0;
      try { readyReject({ ok: false, code: 'destroyed', error: 'Map torn down.' }); } catch {}
    }
  };

  try {
    injectLeafletCss();
    const L = await loadLeaflet();
    // … DOM lookups, map creation …
    track(() => { try { map.remove(); } catch {} });
    track(() => registry.clear());
    track(() => { document.removeEventListener('keydown', onKeydown); });
    track(() => { ro && ro.disconnect(); });
    track(() => { flashTimers.forEach(clearTimeout); flashTimers.length = 0; });
    track(() => { tileRetryTimers.forEach(clearTimeout); tileRetryTimers.length = 0; });
    track(() => { if (window.__mapWidget === api) delete window.__mapWidget; });
    // … bootstrap markers, wire UI …
    window.__mapWidget = api; // set BEFORE ready resolves; methods early-return not_ready until then
    await firstTileLoaded; // see section 7
    readyResolve();
    return { api, destroy: api.destroy };
  } catch (err) {
    // Partial-mount failure — run everything we registered so far, reject ready.
    api.destroy();
    try { readyReject({ ok: false, code: 'tile_error', error: String(err && err.message || err) }); } catch {}
    throw err;
  }
}
```

This pattern guarantees: every `track(fn)` call registers a disposer that runs on destroy **or** on throw. No resource escapes.

---

## 9. What we are NOT changing this round

- No migration of `data/loads.json` / `data/carriers.json` to include coordinates.
- No new tile provider (Stadia infra stays behind env flag, not auto-swap).
- No vector tiles / MapLibre swap.
- No polyline arrowheads or other visual chrome beyond what's in place.
- No change to the `partials/map.html` structure beyond: (a) the `role="dialog" aria-modal="false"` → `role="complementary"` fix on `#map-detail`, (b) adding `aria-busy` on `#map-canvas`.
- No focus trap on the detail panel (decided W3).
- No auto-spiderfy (decided §5 — clustering is off entirely).

---

## 10. Acceptance criteria for frontend-dev's implementation

Before reviewer sign-off, all of these must pass:

1. **Cold-cache cross-page flow**: Hard-refresh on `/` (Dispatch). In DevTools, throttle to "Slow 3G". Agent fires `map_highlight_load({load_id:'LD-10824'})`. Expected: router navigates to /map.html, loading skeleton shows, ~2–4 s later map paints with LD-10824 popup open. No lost event. No blank canvas.
2. **Unknown target**: `map_focus({target: 'Toronto, ON'})` returns `{ok:false, error:"No city, state, or id matched \"Toronto, ON\". …"}`. Agent relays.
3. **Unknown load**: `map_highlight_load({load_id:'LD-99999'})` returns `{ok:false, error:"Load \"LD-99999\" not in current dataset. (N loads total.)"}`.
4. **Rapid sequence**: `map_focus('TX')` immediately followed by `map_highlight_load('LD-10824')` — first animation is cancelled (or skipped when within 400ms window); no visual thrashing.
5. **Teardown**: Navigate Dispatch → Map → Dispatch → Map → Dispatch (5 times). `window.__mapWidget` is `undefined` after each exit. No duplicate document listeners (check `getEventListeners(document)` in Chrome DevTools). Memory snapshot shows ≤1 Leaflet map instance retained.
6. **Tile error**: In DevTools, block `tile.openstreetmap.org`. Load /map.html. Expected: banner appears within 2 s, "Retry" button. Unblock + click Retry → map paints.
7. **Reduced motion**: OS-level toggle. `map_focus('LA')` jumps instantly (no fly animation). Detail panel opens without slide.
8. **Mobile (≤900 px)**: Filter rail renders as horizontal chip strip; "List view" button visible and reachable (gap W8).
9. **Clustering disabled**: At zoom 4 (continental US view), every pin has its `data-agent-id` present in DOM (`document.querySelectorAll('[data-agent-id^="map.pin."]').length === (loadCount * 2 + carrierCount)`).
10. **Destroyed guard**: Call `window.__mapWidget.highlightLoad('X')` after navigating away. Returns `{ok:false, code:'destroyed'}` (actually will be undefined since the global is deleted — test the pre-delete branch by calling destroy() manually in console and then the method).

---

Summary in one line: **ready-Promise + error envelope + direct API + no clustering + tracked cleanups + tile retry + reduced-motion matrix.** Every decision is binding; frontend-dev does not need to revisit alternatives.
