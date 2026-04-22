# Upgrade v2 — Oracle Decisions

Three decisions for the `live-agent-upgrade-v2` team. Written 2026-04-22.

Context: prior round shipped Whisper STT, captions overlay, command palette, activity indicator, quick-chips, filter tools, theme toggle. The user now wants (a) a free full-screen maps page, (b) ambient that never dips during thinking/tool-executing plus a muffle/wind/breath "real human call" layer, (c) a 0–100 compression strength slider replacing the binary toggle. Plus three cross-cutting fixes: hide tool-call notes when transcript is `off`, stop the voice-dock height overflow, kill the horizontal scrollbar.

---

## Decision 1: Maps library + tile provider + data model

### Recommendation

**Leaflet 1.9.4 + OpenStreetMap raster tiles + leaflet.markercluster 1.5.3.** Loaded lazily on `/map.html` only via dynamic `import()` from the SPA router. No vector tiles, no Google, no MapLibre. Pin these exact versions.

- Runtime dep: `leaflet@1.9.4` (ESM import works; ship as its own esbuild chunk).
- Plugin: `leaflet.markercluster@1.5.3` (only used when the marker count grows past ~40 — today ~10 loads + ~10 carriers, so it's headroom, not a hot path).
- Tile provider: **OpenStreetMap standard tiles** (`https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png`). Free, no API key, public policy allows light demo use with attribution. For a deployed site with real traffic, swap to **Stadia Maps** free tier (200k tiles/month, no credit card, key required) — see fallback note below.
- Attribution: MUST render `© OpenStreetMap contributors` in the Leaflet attribution control (Leaflet does this by default when you pass `attribution:` to `L.tileLayer`). Non-negotiable per OSM Tile Usage Policy.
- No polyline-decorator plugin — the straight-line lane polyline between pickup and dropoff is plain `L.polyline` with a dashed pattern in CSS, styled via `--color-accent`. Saves ~8 KB gzip.
- Data model: **Add a city→latlng lookup table in `js/map-widget.js` as a frozen object** (`CITY_COORDS`). Do NOT mutate `data/loads.json` or `data/carriers.json`. The existing pickup/dropoff fields are strings like `"Chicago, IL"` — hash them through the lookup table at render time. Unknown cities fall through to a tiny disclaimer pin at continental-US center with an `aria-label` of "unknown coordinates".

### Rationale

- **Bundle fit.** Leaflet-core is ~42 KB gzip + ~15 KB CSS. Marker-cluster adds ~10 KB gzip + ~2 KB CSS. Total chunk budget ~70 KB gzip, comfortably under the 60 KB soft budget once we treeshake cluster-only-when-needed and our wrapper stays under 5 KB. MapLibre GL baseline is 180+ KB gzip before styles — 3× the budget for no user-visible benefit at this density.
- **Vanilla-JS fit.** Leaflet is a class-based library with no build-time dependencies. Import it, create `L.map(el)`, add layers. Works with the existing esbuild split config without any plugin.
- **Accessibility story.** Leaflet ships `keyboard: true` by default — arrows pan, +/- zoom, Tab moves through markers. We add `role="application"` on the wrapper + an `aria-label="Freight map showing active loads and carriers. Use arrow keys to pan; press + to zoom in, - to zoom out."` + a visible focus ring on markers via `.leaflet-interactive:focus { outline: 2px solid var(--color-accent); outline-offset: 2px; }`.
- **Data ergonomics.** A lookup table is one commit vs. a data migration that touches both JSON files plus anyone else editing them. City names are already canonical in the dataset. ~20 cities covers every load/carrier we have; extending is one line.
- **Tile provider choice.** OSM direct tiles are fine for development and a demo/portfolio deployment; they are NOT fine for production traffic per OSM policy. Default to OSM, document the Stadia swap in one line of config: `const TILE_URL = process.env.STADIA_KEY ? 'https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png?api_key=…' : 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'`. Since the user's `.env` currently has no key, we stay on OSM and add `STADIA_API_KEY` to `.env.example` as an optional flag.

### Rejected alternatives

- **MapLibre GL JS.** Better-looking vector tiles, hardware-accelerated pan. Costs 3× the bundle budget and requires a style JSON (either vendored, ~100 KB more, or fetched from a hosted style — adds a second external dependency). Pretty isn't worth it for a dispatch console that's about data density, not cartography.
- **Google Maps JS API.** Requires billing enabled, free tier is 28k loads/month after which you pay. "Free and well-supported" rules this out.
- **Mapbox GL JS.** Free tier is 50k loads/month but requires a public token shipped to the browser. Private-sector free tiers are policy risk — they change.
- **Extending `data/loads.json` + `data/carriers.json` with coords.** Forces a data migration for every new entry. Cleaner long-term, but the lookup-table path is reversible — we can migrate later without rewriting the widget.
- **Using `leaflet-polylinedecorator` for arrowheads on lanes.** +10 KB for visual chrome. Skip. A dashed line + directional label is enough.

### Implementation notes

**File layout.**
- `partials/map.html` — the map page body. Contains `<div id="map-container" data-agent-id="map.container" class="map-container" role="application" aria-label="..."></div>` + sidebar with filter chips + load/carrier list that reuses the existing `.chip` tokens. No Leaflet markup; Leaflet mounts into `#map-container` at runtime.
- `js/page-map.js` — SPA route module, mirrors `page-dispatch.js` shape. `init(container)` dynamic-imports `./map-widget.js`, calls `createMap(container)`, returns cleanup. Also registers domain tool handlers for `map_focus`, `map_show_loads`, `map_show_carriers`, `map_highlight_load`.
- `js/map-widget.js` — the Leaflet wrapper. Exports `createMap(container, { loads, carriers })`. Owns the Leaflet instance, marker layers, and the city-coord lookup. **At top of file**: `const L = await import('leaflet')`, `await import('leaflet/dist/leaflet.css')` (esbuild handles CSS asset imports — if not, see the CSS-injection fallback below).
- `css/map.css` — map-container sizing + marker styling + Leaflet override layer. All colors via tokens. Overrides `.leaflet-container { background: var(--color-bg); }` so tiles sit on the app surface before loading.

**Server routing.** Add `'/map.html'` to `SPA_ROUTES` (set in `server.js:96`). The shell already handles SPA routing; map.html deep-links work once it's in the set.

**Leaflet CSS injection.** esbuild does not bundle Leaflet's CSS by default for ESM imports. Two options, pick the simpler one:
- **Option A (preferred):** In `js/map-widget.js` before calling `L.map()`, check if `<link data-leaflet-css>` exists; if not, inject `<link rel="stylesheet" href="/leaflet/leaflet.css" data-leaflet-css>` into `<head>`. Ship Leaflet's CSS + marker icon pngs under `public/leaflet/` (already covered by `STATIC_DIRS`). This keeps Leaflet out of the JS chunk and lets the browser cache CSS separately.
- **Option B:** Use esbuild's `--loader:.css=text` + manual `document.head.appendChild(<style>)`. Works but loses browser caching. Only pick this if Option A proves fiddly.

**Tool declarations (append at the END of `STATIC_TOOL_DECLARATIONS` in `api/tools.js`)**:
```js
{
  name: 'map_focus',
  description: 'On the Map page, center the map on a city name, a state, or a load/carrier id. Also accepts {lat, lng}.',
  parameters: { type: 'object', properties: {
    target: { type: 'string', description: 'City (e.g. "Chicago, IL"), state (e.g. "TX"), load_id (LD-10824), or carrier_id (C-204).' },
    lat: { type: 'number' },
    lng: { type: 'number' },
    zoom: { type: 'number', description: 'Optional zoom 3–18. Default is 7 for cities, 5 for states.' }
  }}
},
{
  name: 'map_highlight_load',
  description: 'Flash the pickup and dropoff markers + lane polyline for a load. Opens its popup.',
  parameters: { type: 'object', properties: {
    load_id: { type: 'string' }
  }, required: ['load_id'] }
},
{
  name: 'map_show_layer',
  description: 'Toggle which overlay is visible on the map. Combine multiple by calling this more than once.',
  parameters: { type: 'object', properties: {
    layer: { type: 'string', description: 'One of: loads, carriers, lanes.' },
    visible: { type: 'boolean' }
  }, required: ['layer', 'visible'] }
}
```

**Prompt cache invariant.** These three tools go at the END of the array, AFTER `set_transcript_pref`. This preserves the Gemini prompt cache prefix we're already hitting at >80%. Order matters — do NOT insert in the middle.

**Marker icon story.** Leaflet's default marker pngs work but look generic. Use `L.divIcon` with inline-styled divs for both load (pickup/dropoff) and carrier markers. Load pins use `var(--color-accent)` for in-transit, `var(--color-warn)` for delayed, `var(--color-state-idle)` for pending. Carrier pins use `var(--color-info)` with a 4-point star inside. Keeps the visual language consistent with the dispatch chips and avoids shipping marker pngs entirely.

**Performance budget.**
- Leaflet chunk (leaflet core + marker-cluster + our wrapper): < 75 KB gzip (hard ceiling), < 60 KB soft target.
- Leaflet CSS: ~15 KB gzip; fetched once, cached by browser.
- Tile network cost per map view: ~12–25 tile GETs at initial zoom 5 (continental US), 256×256 each ≈ ~18 KB avg per tile. OSM tile usage policy allows this.
- Eager page load unaffected — map module is not imported until `handleRouteChange({path: '/map.html'})` fires.

**Accessibility.**
- `role="application"` on the container (Leaflet sets some aria but not this).
- Leaflet's built-in `keyboard: true` covers arrow-pan, +/- zoom. Do NOT disable.
- Marker popups: use `bindPopup()` with real HTML text (escaped via `textContent` when injecting load ids/carrier names — do NOT trust data fields for XSS purposes; same rule as LLM output).
- A text-based "list view" toggle is mandatory for screen readers: `<button data-agent-id="map.list_toggle">List view</button>` flips the sidebar into a pure `<ul>` of loads+carriers and hides the map visually (not `display: none` — `aria-hidden="true" + visibility: hidden` so focus trap is predictable).
- `prefers-reduced-motion: reduce` — pass `{ zoomAnimation: !prefersReducedMotion, markerZoomAnimation: !prefersReducedMotion, fadeAnimation: !prefersReducedMotion }` to `L.map()`.

### What NOT to do

- Do NOT ship Leaflet in the main chunk. Dynamic-import only.
- Do NOT migrate `data/loads.json` or `data/carriers.json` in this round.
- Do NOT hit a tile server without attribution. OSM's policy is strict and spot-enforced.
- Do NOT use `leaflet.heat`, `leaflet.draw`, `leaflet-routing-machine`, or any other plugin beyond `markercluster` in this round.
- Do NOT add WebGL vector tile layers. Wrong tool; raster tiles fit perfectly.
- Do NOT auto-geolocate the user. No `navigator.geolocation` call.

---

## Decision 2: Continuous ambient + muffle/wind/breath layer

### Recommendation

Extend `AudioPipeline`'s noise graph with a **layered "human-call ambience" bed** that plays alongside the existing `noiseMode` primary noise (office/phone/static/off). The layer consists of three procedural components — muffle, wind, breath — routed through a dedicated `humanLayerBusGain` → `humanLayerEnvelopeGain` → `ctx.destination` branch, fully independent of both the agent and the primary ambient paths. It runs continuously while `isInCall()` is true, steady-state, never dipping for MODEL_THINKING / MODEL_SPEAKING / TOOL_EXECUTING.

**Continuity invariant (document in code and enforce):**

> **Ambient never dips during an active call.** The single authority is `VoiceAgent._updateAmbient()` at `js/voice-agent.js:1405`. It maps `isInCall() && noiseMode !== 'off'` → `setAmbientOn(true)` AND `setHumanLayerOn(true)`. Both are steady targets; the AudioParam ramps use `setTargetAtTime` with a 40 ms time constant on mid-call re-asserts and ~220 ms on dial-up / ~300 ms on hang-up. No other code path in VoiceAgent touches these setters. The `CALL_ACTIVE_STATES` set at `js/voice-agent.js:105` is the list of states during which ambient MUST be on — if any new mid-call state is added later, it MUST be added there. This invariant is already correct today for the primary ambient; the upgrade extends the same pattern to the human layer.

**Env var:** `HUMAN_CALL_LAYER=true` (default). Setting it to `false` in `.env` makes `VoiceAgent` skip `setHumanLayerOn`, so the layer silently does nothing. Flag surfaces in `/api/config` as `flags.humanCallLayer`. Added at end of `api/server-flags.js` exports to preserve the prompt-cache prefix logic.

### Rationale

- **Constant noise, never gated on speech.** The primary `noiseMode='office'` bed already runs steadily during an active call (verified in `_updateAmbient` — it reads `isInCall()`, not any speech-state). Today's code is correct, but the guarantee is implicit. The upgrade makes it explicit with a single comment + asserting that same pattern for the human layer. No state change in `_setState` can dip ambient mid-call because the fadeMs for wasActive→wasActive transitions is 40 ms and the target is IDENTICAL (the ramp is a no-op). Document this explicitly at `js/voice-agent.js:1405–1416`.
- **No AudioWorklet needed.** Three AudioBufferSource nodes with pre-generated buffers + biquad filters + LFO + setInterval-driven breath scheduler = off-the-shelf Web Audio. Adding a worklet would double the code for no fidelity benefit at these levels.
- **Pre-generated buffers avoid per-frame allocation.** All three buffers are generated once at `ctx` creation and reused. Muffle: 8 s, loops. Wind: 10 s, loops. Breath: 0.3 s one-shot, scheduled.
- **Breath realism matters more than muffle/wind.** The user's phrase "like a real human call" is about the presence of another person. Breath bursts every 4–8 s at -30 dBFS are what sells it. Muffle and wind are texture; breath is the signal.

### Rejected alternatives

- **Record a real call-center loop, ship as .mp3.** Feels like a real human but: (a) adds ~200 KB to the bundle, (b) copyright/licensing minefield, (c) user hears the same 30-second loop on every call within a minute. Procedural synthesis wins on variety.
- **Convolver-based impulse response.** A genuine room IR would sound great but we don't need a reverberated Jarvis — we need background ambience. IR adds latency + CPU for no UX gain.
- **Routing the human layer through the primary `noiseBusGain`.** Breaks the per-mode volume (office = 0.25 gain, while human layer should be independent of that). Keep a separate bus so the `set_noise_volume` tool only affects the selected mode and the human layer has its own subtle headroom.
- **Scheduling breath via `AudioContext.setTargetAtTime` tails.** Cleaner in theory, but main-thread `setTimeout` works fine for an ambient ticker firing every 4–8 s. Not sample-accurate; doesn't need to be. Tab blur is acceptable — the layer is garnish, not load-bearing.
- **Adding the human layer to the existing noiseMode enum (`humanCall`).** Conflates two dimensions: primary noise texture (office/phone/static) vs. human-presence layer. Keep them orthogonal — the user can mix office chatter + breath layer + muffle, which is the whole point.

### Implementation notes

**AudioPipeline changes (ownership: ai-engineer edits `js/audio-pipeline.js`).**

Add to `AudioPipeline` constructor:
```js
this.humanLayerBusGain = null;        // user-settable level, 0..1
this.humanLayerEnvelopeGain = null;   // 0 off, 1 on (ramped)
this.humanLayerVolume = 0.6;          // default bus level — layer is quiet
this.humanLayerOn = false;
this.humanLayer = null;               // { muffle, wind, breathScheduler }
```

In `_buildPlaybackGraph()`, after the existing noise graph is built, add:
```js
this.humanLayerBusGain = ctx.createGain();
this.humanLayerBusGain.gain.value = this.humanLayerVolume;
this.humanLayerEnvelopeGain = ctx.createGain();
this.humanLayerEnvelopeGain.gain.value = 0;
this.humanLayerBusGain.connect(this.humanLayerEnvelopeGain).connect(ctx.destination);
```

Build the three components (called on first `setHumanLayerOn(true)` so they're not wasted when the user never places a call):

1. **Muffle (brown noise, low-passed).**
   - Pre-generate a 10 s brown-noise AudioBuffer at `ctx.sampleRate` (reuse `makeNoiseBuffer(ctx, 10, 'brown')`, already in `audio-pipeline.js:34`).
   - `BufferSource{loop:true}` → `BiquadFilter{type:'lowpass', frequency:200, Q:0.5}` → `Gain{value:0.12}` (≈ -18 dBFS) → `humanLayerBusGain`.
   - Runs continuously while layer is on.

2. **Wind (pink noise, band-passed, LFO-modulated amplitude).**
   - Pre-generate 10 s pink noise (reuse `makeNoiseBuffer(ctx, 10, 'pink')`).
   - `BufferSource{loop:true}` → `BiquadFilter{type:'bandpass', frequency:300, Q:1.2}` → `Gain{value:0.08}` → `humanLayerBusGain`.
   - LFO: `Oscillator{type:'sine', frequency:0.08}` (0.08 Hz = 12.5 s period) → `Gain{value:0.06}` → the wind `Gain` param. Breathes slowly.

3. **Breath (short bursts, ADSR'd, scheduled on main thread).**
   - Pre-generate a 0.3 s pink-noise breath burst buffer at create time. Apply an attack/decay envelope while filling the float buffer (exp attack 30 ms, exp decay 270 ms) so every playback has the same ADSR shape without needing runtime gain ramps.
   - Scheduler: `setInterval` (or a recursive `setTimeout` for jittered timing), fires every `4000 + Math.random()*4000` ms. Each fire creates a `BufferSource` with that buffer, connects through `BiquadFilter{type:'lowpass', frequency:900, Q:0.4}` (breath is darker than speech) → `Gain{value:0.03}` (-30 dBFS) → `humanLayerBusGain`, `.start(ctx.currentTime + 0.02)` with a small randomized offset 0–50 ms for micro-jitter. `onended` disconnects.
   - Jitter frequency: the scheduler uses `setTimeout(..., jitter)` and reschedules itself. Each fire randomizes the next interval. Simpler than setInterval and drift-tolerant.
   - Tab blur: background tabs throttle setTimeout to ≥1s intervals but breath at ~4–8s is well above that floor, so it keeps going. On resume, the next timer fires late once, then re-randomizes — acceptable.

**Public API on AudioPipeline:**
```js
setHumanLayerOn(on, { fadeMs = 300 } = {}) { /* mirrors setAmbientOn; ramps humanLayerEnvelopeGain to 0 or 1 */ }
setHumanLayerVolume(v) { /* 0..1 clamp, writes humanLayerBusGain.gain */ }
```

VoiceAgent changes (`js/voice-agent.js:_updateAmbient`):
```js
_updateAmbient({ wasActive = CALL_ACTIVE_STATES.has(this.state) } = {}) {
  const shouldBeOn = this.isInCall() && this.noiseMode !== 'off';
  const fadeMs = shouldBeOn
    ? (wasActive ? 40 : AMBIENT_FADE_IN_MS)
    : AMBIENT_FADE_OUT_MS;
  this.pipeline.setAmbientOn(shouldBeOn, { fadeMs });
  // Human-call layer piggybacks on isInCall() — runs continuously regardless
  // of noiseMode selection (muffle/wind/breath are orthogonal to the
  // office/phone/static primary bed). Honour the flag if disabled.
  const humanShouldBeOn = this.isInCall() && this.flags.humanCallLayer !== false;
  this.pipeline.setHumanLayerOn(humanShouldBeOn, { fadeMs });
}
```

**Buffer generation — CPU/memory budget.**
- Muffle + wind buffers: 10 s × 48000 Hz × 4 bytes (Float32) × 2 buffers = ~3.84 MB memory. One-time generation at ctx creation costs ~30 ms on mid-range hardware. Acceptable.
- Breath burst buffer: 0.3 s × 48000 × 4 = 57 KB. Reused across fires.
- All buffers are generated in a single synchronous pass inside `_buildHumanLayer()`, called lazily on first `setHumanLayerOn(true)`. If the user never places a call, no allocation happens.

**Timing invariants.**
- `setHumanLayerOn(true)` before `unlockAudioSync()` is a no-op (same pattern as `setAmbientOn`).
- On endCall, the scheduler timer is cleared and the envelope ramps to 0 over 300 ms; buffer sources are left alone (they're cheap, ~6 KB of filter state) and GCed when the pipeline's `close()` disconnects.
- On page hide / tab blur: buffers keep running; ctx stays active because of the existing keep-alive watchdog at `audio-pipeline.js:295`. On visibility return, the ctx auto-resumes via `_onVisibilityChange`. The scheduler's next timer may fire late once — document this as acceptable.

### What NOT to do

- Do NOT route the human layer through `noiseBusGain` or `playbackGain`. It's a sibling branch.
- Do NOT recompute buffers on noise-mode changes. They're independent of noiseMode.
- Do NOT couple breath bursts to MODEL_SPEAKING / MODEL_THINKING state. The layer is oblivious to speech state by design.
- Do NOT add an AudioWorklet for this. Overkill.
- Do NOT schedule breath via `AudioContext.createConstantSource + automation` — the main-thread setTimeout is simpler and the drift is inaudible at these intervals.
- Do NOT expose the layer as a user-visible toggle (yet). The `HUMAN_CALL_LAYER` env var is the on/off; a UI setting can come later if anyone complains.

---

## Decision 3: Agent-audio compression strength ladder (0–100)

### Recommendation

Replace the binary `setBandPassEnabled(true/false)` with a continuous `setCompressionStrength(0..100)` driving a **single persistent node graph** whose parameters interpolate from "neutral pass-through" at 0 to "heavy walkie-talkie" at 100. The node graph is built once at ctx creation and parameter changes are applied via `setTargetAtTime` with 50 ms time constant — no clicks, no rewiring. Persist in `localStorage['jarvis.compressionStrength']` default 50. Add a `set_compression_strength` tool. Preserve the binary API as a backwards-compat shim.

### Rationale

- **One graph, parameter ramps.** Today's `setBandPassEnabled` disconnects/reconnects the agent chain on every toggle, which is fine for binary but would click audibly if called on a slider drag. Build the graph once with HP + LP + Compressor + WaveShaper always in-path, and interpolate their params. At strength 0, HP→0 Hz, LP→20 kHz, compressor threshold→0 dB, ratio→1, shaper curve flat — the signal passes through unmolested. At strength 100, HP→400 Hz, LP→3200 Hz, threshold→-24 dB, ratio→8, soft clip via a saturating curve.
- **Dispatcher-realistic walkie-talkie at 100.** 400–3200 Hz is narrower than a classic telephone band (300–3400) but preserves consonants well. If QA testing reveals speech clarity suffers, widen to 350–3400 Hz — see "tuning knob" below. Dynamics compression at 8:1 + mild saturation gets the "squashed" feel without destroying intelligibility.
- **Backwards compat is a one-liner.** `setBandPassEnabled(true)` → `setCompressionStrength(50)`; `setBandPassEnabled(false)` → `setCompressionStrength(0)`. No caller needs to change.
- **The LLM can already express "crustier"** — the `set_compression_strength` tool has a numeric parameter the model can push around. No prompt engineering needed beyond the tool description.

### Rejected alternatives

- **Keep the binary toggle, add a separate "strength" slider that only shows when enabled.** Two controls for one dimension. Users will toggle off and wonder why the slider does nothing. Collapse into one axis.
- **Swap in/out different graphs at strength thresholds.** Causes audible clicks at each threshold boundary. Single graph with param ramps is strictly better.
- **Use a DynamicsCompressorNode only.** Gets halfway there but no frequency shaping — agent audio sounds like it went through a squash pedal, not a phone line. Bandpass filters are essential for the walkie-talkie character.
- **Implement via AudioWorklet with custom DSP.** Overkill. Biquad + Compressor + WaveShaper covers the palette at 1/10 the code.
- **Bit-crushing at strength 100.** Tried in prior prototypes (not in this codebase); always sounds like a video-game artifact, not a phone. Skip.

### Implementation notes

**Node graph (always connected, built at ctx creation):**
```
agentGain → highpassFilter → lowpassFilter → compressor → waveShaper → compOut → playbackGain → destination
```

All nodes exist regardless of strength. At strength 0 the filters are transparent (HP 0 Hz, LP 20 kHz), compressor is unity (threshold 0 dB, ratio 1), shaper curve is linear (y = x). The agent chain always goes through the same nodes; only their parameters change.

**Parameter interpolation table** (linear in strength 0–100, apply via `setTargetAtTime(target, ctx.currentTime, 0.05)`):

| Strength | HP (Hz) | LP (Hz) | Threshold (dB) | Ratio | Attack (s) | Release (s) | Saturation curve |
|---:|---:|---:|---:|---:|---:|---:|---|
| 0   | 0    | 20000 | 0    | 1   | 0.003 | 0.25 | linear (pass-through) |
| 25  | 200  | 6000  | -12  | 2.5 | 0.004 | 0.22 | very mild `tanh(1.1·x)` |
| 50  | 300  | 3400  | -18  | 4.5 | 0.006 | 0.18 | `tanh(1.8·x)` (current default) |
| 75  | 360  | 3300  | -22  | 6.5 | 0.008 | 0.14 | `tanh(2.4·x)` |
| 100 | 400  | 3200  | -24  | 8.0 | 0.010 | 0.10 | `tanh(2.8·x)` (current "on") |

For strengths between table rows, linear-interpolate each parameter. The saturation curve is regenerated whenever the strength crosses a 10% boundary (cheap — 1024-sample Float32 fill, ~0.1 ms). Don't recompute on every slider frame; throttle to `requestAnimationFrame`.

**Tuning knob.** If QA or voice-persona reviewers find that strength=100 cuts too much intelligibility:
- First try widening LP from 3200 → 3400 Hz.
- If still muddy, drop HP from 400 → 350 Hz.
- If dynamics sound pumping, drop ratio from 8 → 6.5.
Do not exceed strength 100 with "extra" parameters — keep the scale bounded.

**Backwards-compat shim in AudioPipeline:**
```js
setBandPassEnabled(on) {
  this.setCompressionStrength(on ? 50 : 0);
  this.bandPassEnabled = !!on; // kept for any readers
}

setCompressionStrength(strength) {
  const s = Math.max(0, Math.min(100, Number(strength) || 0));
  if (!this.agentGain) { this.compressionStrength = s; return; }
  const params = interpolateCompressionParams(s); // from table
  const now = this.ctx.currentTime;
  this.bandPass.hp.frequency.setTargetAtTime(params.hp, now, 0.05);
  this.bandPass.lp.frequency.setTargetAtTime(params.lp, now, 0.05);
  this.bandPass.comp.threshold.setTargetAtTime(params.threshold, now, 0.05);
  this.bandPass.comp.ratio.setTargetAtTime(params.ratio, now, 0.05);
  this.bandPass.comp.attack.setTargetAtTime(params.attack, now, 0.05);
  this.bandPass.comp.release.setTargetAtTime(params.release, now, 0.05);
  if (this._lastShaperBucket !== Math.floor(s / 10)) {
    this.bandPass.shaper.curve = makeSaturationCurve(params.drive); // regenerate
    this._lastShaperBucket = Math.floor(s / 10);
  }
  this.compressionStrength = s;
}
```

**VoiceAgent integration.** Rename `setCompressionEnabled` → keep both:
```js
setCompressionEnabled(on) { this.setCompressionStrength(on ? 50 : 0); }
setCompressionStrength(strength) {
  this.compressionStrength = Math.max(0, Math.min(100, Number(strength) || 0));
  this.compressionEnabled = this.compressionStrength > 0;  // derived
  this.pipeline.setCompressionStrength(this.compressionStrength);
  try { localStorage.setItem('jarvis.compressionStrength', String(this.compressionStrength)); } catch {}
  this._persistSessionBlob();
  this._publishEvent('compression-changed', { strength: this.compressionStrength, enabled: this.compressionEnabled });
}
getCompressionStrength() { return this.compressionStrength ?? (this.compressionEnabled ? 50 : 0); }
```

Persisted defaults: on construction, read `localStorage['jarvis.compressionStrength']`; if present and numeric, use it; else if legacy `session.compression` is boolean, map true→50 false→0; else default 50. Write through `_persistSessionBlob` alongside existing fields.

**New Gemini tool (append at END of `STATIC_TOOL_DECLARATIONS` — AFTER the map tools):**
```js
{
  name: 'set_compression_strength',
  description:
    'Adjust how much phone-line compression is applied to your voice. Range 0 (studio-clean) to 100 (heavy walkie-talkie). ~50 is the default phone sound. Use when the user says "sound crustier", "sound clearer", "more compression", "less filtering". Persists across reloads.',
  parameters: {
    type: 'object',
    properties: {
      strength: { type: 'number', description: 'Integer 0–100.' }
    },
    required: ['strength']
  }
}
```

**Prompt-cache ordering note.** The append order at end of `STATIC_TOOL_DECLARATIONS` must be:
1. map_focus
2. map_highlight_load
3. map_show_layer
4. set_compression_strength

All four are NEW and go at the end; the prior (v1) tools `set_captions`, `open_palette`, `run_palette_action`, `set_activity_note`, `set_quick_actions`, `filter_loads`, `filter_carriers`, `set_theme`, `set_transcript_pref` stay in their current positions. Nothing in the middle moves. Cache prefix is preserved.

**System prompt addendum** (append to the "UI helper tools" list at end of `SYSTEM_PROMPT_SKELETON` in `api/tools.js`):
```
- Use set_compression_strength when the user asks about how you sound ("crustier", "clearer", "more phone-line", "studio"). 0 is clean, 50 is default phone, 100 is heavy walkie-talkie.
- Use map_focus / map_highlight_load / map_show_layer only on the Map page. map_focus accepts city, state, or load/carrier id; prefer load/carrier id when applicable.
```

### What NOT to do

- Do NOT disconnect/reconnect the agent chain on strength changes. Param ramps only.
- Do NOT regenerate the WaveShaper curve on every slider frame. Throttle to 10%-bucket changes (i.e. crossing 10,20,30…).
- Do NOT remove `setBandPassEnabled` — keep it as a shim so no caller breaks.
- Do NOT expose `set_compression_strength` without clamping the input. Gemini will send 150 or -20 and must be bounded.
- Do NOT couple compression strength to noise volume or persona. Orthogonal dimensions.

---

## Cross-cutting fixes

### Fix 1: Hide tool-call notes when transcript mode is `off`

**Problem.** `js/tool-registry.js:handleToolCall` (line 319) always calls `this.onToolNote(...)`. When `transcriptMode === 'off'`, the transcript panel isn't rendered, but the note still goes to `VoiceAgent._logTool` which pushes into `this.transcript`. The result is that the internal `TranscriptLog` keeps growing with "tool" lines that no one sees — wasted memory, and a potential leak of tool arguments into `sessionStorage` even when the user asked for no transcript.

**Decision.** Pass the **transcript mode** into ToolRegistry via a live getter alongside `showText`, and guard `onToolNote` at the top of `handleToolCall`.

**File + exact edit.**

`js/tool-registry.js:283–307`. Extend the constructor options:
```js
constructor({ sendTextMessage, onNavigate, onToolNote, showText, transcriptMode }) {
  // ... existing ...
  this.transcriptMode = typeof transcriptMode === 'function' ? transcriptMode : () => 'full';
}
```

`js/tool-registry.js:319–348` — guard both the success and error branches:
```js
async handleToolCall({ id, name, args }) {
  const reply = (payload) => this.send({ type: 'tool_result', id, name, ...payload });
  const textVisible = !!this.showText();
  const mode = this.transcriptMode(); // 'off' | 'captions' | 'full'
  const renderNote = (mode === 'full'); // captions overlay doesn't show tool lines either
  try {
    const result = await this._execute(name, args || {});
    if (renderNote) {
      if (textVisible) this.onToolNote(`${name}(${JSON.stringify(args || {})}) → ${safeJson(result)}`);
      else this.onToolNote(name);
    }
    reply({ ok: true, result });
  } catch (err) {
    const msg = (err && err.message) || String(err);
    if (renderNote) {
      if (textVisible) this.onToolNote(`${name} failed: ${msg}`);
      else this.onToolNote(`${name} (failed)`);
    }
    const envelope = { ok: false, error: msg };
    if (err && err.fillFailure) envelope.result = { fill_failure: err.fillFailure };
    reply(envelope);
  }
}
```

`js/voice-agent.js:324–331` — pass the live getter at construction:
```js
this.toolRegistry = new ToolRegistry({
  sendTextMessage: (m) => this._sendJson(m),
  onNavigate: onNavigate || ((p) => this._onAgentNavigate(p)),
  onToolNote: (s) => this._logTool(s),
  showText: () => !!this.flags.showText,
  transcriptMode: () => this.getTranscriptMode()   // NEW
});
```

**Why the live getter, not a mode set on the registry at mode-change time?** The getter picks up server-forced `showText=false` automatically because `getTranscriptMode()` already coerces to `'off'` in that case (`voice-agent.js:381–384`). One source of truth.

**Why skip tool lines in 'captions' too?** Captions are last-1-2-lines of AGENT speech only. Tool chatter in captions would be noisy and off-thesis for what captions are for. `full` mode is the only place tool lines belong.

**Why not server-side log redaction?** That's a separate concern covered by `SHOW_TEXT=false` already. This fix is purely client-side UI.

**Test assertion.** After the fix, set `transcriptMode='off'`, fire a `tool_call` in the Gemini WS, confirm:
- `tool_result` message is sent back to Gemini (tool still executes — only the UI note is suppressed).
- `TranscriptLog` has no `from:'tool'` row added.
- `_publishEvent('tool-call-start'/'end')` still fires (for activity indicator).

### Fix 2: Voice-dock height overflow

**Problem.** `.voice-dock-body { max-height: 60vh; min-height: 240px; }` + `.voice-settings-sheet { max-height: 70vh; }`. Together, open-settings can push the dock past `100vh` because each has its own cap and they stack vertically inside the dock flex column. The dock has `overflow: hidden` (line 25) which clips, but the clipped content then becomes inaccessible. On shorter viewports (≤720 px) the settings sheet content can't even scroll into view.

**Decision.** Anchor the entire dock to the viewport with a single cap and let the body + settings flex within. The inner regions stay scrollable but the total dock height never exceeds the viewport.

**File + exact edits in `css/voice-dock.css`:**

Line 12-27 (`.voice-dock`):
```css
.voice-dock {
  position: fixed;
  bottom: var(--sp-4);
  right: var(--sp-4);
  width: 380px;
  max-width: calc(100vw - var(--sp-6));
  max-height: calc(100vh - var(--sp-5));  /* NEW: hard cap */
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
```

Line 99-105 (`.voice-dock-body`):
```css
.voice-dock-body {
  flex: 1 1 auto;           /* change from flex:1 to flex:1 1 auto */
  display: flex;
  flex-direction: column;
  min-height: 200px;
  overflow: hidden;         /* transcript scrolls inside */
  /* remove max-height: 60vh */
}
```

Line 382-388 (`.voice-settings-sheet`):
```css
.voice-settings-sheet {
  border-top: 1px solid var(--color-border);
  background: var(--color-bg-elev-2);
  flex: 0 1 auto;           /* NEW: allow shrink but not grow */
  max-height: 50vh;         /* tighter than 70vh */
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}
```

Line 554 (mobile `@media (max-width: 640px)` override for `.voice-dock-body`):
- Remove `max-height: 42vh; min-height: 160px` and rely on the parent dock's `max-height: calc(100vh - ...)`. The body's `flex: 1 1 auto` + transcript's `overflow-y: auto` handles it.

**Why not just raise the dock `max-height` to 100vh?** Because the dock is `position: fixed; bottom: var(--sp-4); right: var(--sp-4)` — a 100vh dock would push its bottom anchor off-screen top. The `calc(100vh - var(--sp-5))` gives a 24 px breathing room at the top.

**Verification to run.** Open settings with full transcript + debug panel + error banner visible at viewport height 720 px. Dock total height should max at ~696 px. All inner regions (transcript, settings body) remain scrollable.

### Fix 3: Horizontal scrollbar

**Problem.** One of `.voice-transcript`, `.voice-chips`, or `.app-nav` (mobile) has runaway width from a long token, long URL, or tool-call JSON string. `app-nav` is intentional (tab scroll on mobile), so focus on the transcript + chips.

**Decision — three-line fix in `css/voice-dock.css`:**

Line 107-118 (`.voice-transcript`):
```css
.voice-transcript {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;                 /* NEW */
  padding: var(--sp-3) var(--sp-4);
  font-size: var(--fs-sm);
  line-height: 1.5;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  background: var(--color-bg);
  -webkit-overflow-scrolling: touch;
  overflow-wrap: anywhere;            /* NEW — break long tokens */
  word-break: break-word;             /* NEW — legacy fallback */
}
```

Line 169 (`.voice-line-text`) already has `word-break: break-word` — leave it.

In `css/components.css` at line 476 (`.voice-chips`):
```css
.voice-chips {
  display: flex;
  flex-wrap: wrap;                    /* already wraps, but verify */
  gap: var(--sp-1);
  padding: var(--sp-2) var(--sp-4);
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg-elev-1);
  overflow-x: hidden;                 /* NEW — truly suppress if flex-wrap leaks */
}
```

**Do NOT touch `.app-nav` on mobile** — its `overflow-x: auto` is intentional for the tab row.

**If the scrollbar persists after these fixes**, suspect `.palette-modal` or a long tool-call JSON line in the transcript. The `overflow-wrap: anywhere` on `.voice-transcript` covers the latter. Palette scrolling is vertical only — `palette-list` already has `overflow-y: auto` + no `overflow-x`, so unless a row has explicit `white-space: nowrap`, it shouldn't overflow. If it does, audit `.palette-row` — add `overflow: hidden; text-overflow: ellipsis; white-space: nowrap` to the label, allow `flex-shrink: 1` on its container.

---

## Performance summary

- **Leaflet:** lazy-loaded only on `/map.html`. Main chunk unaffected. Map chunk target < 60 KB gzip, hard ceiling 75 KB.
- **Ambient human layer:** buffers generated once at ctx creation (~3.9 MB memory, ~30 ms CPU at creation time). Zero per-frame allocation. Breath scheduler uses a single `setTimeout` chain.
- **Compression node graph:** built once per pipeline init. Param ramps via `setTargetAtTime`. Shaper curve regenerated only on 10%-bucket changes (≤ 10 times per full slider sweep, ~0.1 ms each).
- **Prompt cache:** four new tool declarations (`map_focus`, `map_highlight_load`, `map_show_layer`, `set_compression_strength`) appended at end of `STATIC_TOOL_DECLARATIONS`, after v1 additions. Preserves cache prefix.
- **ToolRegistry guard:** O(1) live getter check at top of `handleToolCall`. No hot-path cost.

---

## What NOT to do (cross-cutting)

- Do NOT introduce a map rendering library other than Leaflet.
- Do NOT migrate data files for coordinates in this round.
- Do NOT turn the human-call layer into a user-visible mode toggle in this round (env-var gated).
- Do NOT rewire the compression node graph on strength changes.
- Do NOT insert new tool declarations in the middle of `STATIC_TOOL_DECLARATIONS`.
- Do NOT render tool notes in captions mode (they're agent-speech-only by design).
- Do NOT raise `.voice-dock-body { max-height }` — remove it and let flex + dock cap handle it.
