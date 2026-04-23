# Dhruv FreightOps — Frontend Overhaul Architecture & Safety Plan

Produced by oracle. Any frontend-dev working on the overhaul must read this before touching a single file.

## Recommendation

Three-dev split:
- **Dev A — Foundation**: `css/tokens.css`, `css/base.css`, `css/components.css`, `index.html` `<head>` + font loading.
- **Dev B — Agent surface**: `css/voice-dock.css`, `js/ui.js` (dock/header/settings-sheet template — reviewer gate required).
- **Dev C — Pages**: `css/pages.css`, `css/map.css`, all `partials/*.html`.

All other `js/*.js` + `api/*.js` are frozen — no dev touches them.

## 1. Integration Contract: every `data-agent-id`

### Nav / shell (built by `js/ui.js`)
`nav.brand`, `nav.dispatch`, `nav.carriers`, `nav.negotiate`, `nav.map`, `nav.contact`, `nav.voice_dock`.

### Voice dock (built by `js/ui.js`; Dev B territory)
`voice.ambient_chip`, `voice.settings`, `voice.dock.collapse`, `voice.call_btn`, `voice.mic`, `voice.noise`, `voice.noise_volume`, `voice.phone_compression`, `voice.output_volume`, `voice.compression_strength`, `voice.mode.live`, `voice.mode.wakeword`, `voice.clear_transcript`, `voice.enable_playback`, `voice.persona.<id>` (dynamic), `voice.stt.retry`, `voice.stt.consent.accept`, `voice.stt.consent.skip`, `transcript.mode_seg`, `transcript.mode.off`, `transcript.mode.captions`, `transcript.mode.full`, `theme.toggle`, `theme.dark`, `theme.light`, `theme.system`.

### Palette / chips / captions / activity (feature JS)
`palette.root`, `palette.input`, `palette.list`, `palette.action.<id>`, `chips.root`, `chips.<chip-id>`, `captions.overlay`, `activity.status`.

### Dispatch page — `partials/dispatch.html` + `page-dispatch.js`
`dispatch.action.new_load`, `dispatch.action.export`, `dispatch.filters.search`, `dispatch.filters.status`, `dispatch.filters.lane`, `dispatch.loads_tbody`, `dispatch.open_map`, `dispatch.map_lanes`, `dispatch.kpi.in_transit`, `dispatch.kpi.pending`, `dispatch.kpi.delayed`, `dispatch.kpi.revenue`, `dispatch.row.<load_id>` (dynamic), `dispatch.map_lane.<load_id>` (dynamic), `dispatch.detail.title`, `dispatch.detail.pickup`, `dispatch.detail.dropoff`, `dispatch.detail.commodity`, `dispatch.detail.rate`, `dispatch.detail.carrier`, `dispatch.detail.eta`, `dispatch.detail.assign_carrier`, `dispatch.detail.request_status`, `dispatch.detail.escalate`.

### Carriers page — `partials/carriers.html` + `page-carriers.js`
`carriers.action.import`, `carriers.action.new`, `carriers.filters.search`, `carriers.filters.equipment`, `carriers.filters.available`, `carriers.grid`, `carriers.card.<id>`, `carriers.card.<id>.call`, `carriers.card.<id>.message`, `carriers.card.<id>.shortlist`.

### Negotiate page — `partials/negotiate.html`
`negotiate.load_id`, `negotiate.form`, `negotiate.form.pickup`, `negotiate.form.dropoff`, `negotiate.form.commodity`, `negotiate.form.weight`, `negotiate.form.target_rate`, `negotiate.form.note`, `negotiate.readout.amount`, `negotiate.submit`, `negotiate.counter`, `negotiate.accept`, `negotiate.log`.

### Contact page — `partials/contact.html`
`contact.form`, `contact.form.name`, `contact.form.email`, `contact.form.preferred_time`, `contact.form.message`, `contact.form.submit`, `contact.callback_list`.

### Map page — `partials/map.html` + `map-widget.js`
`map.root`, `map.filters.rail`, `map.canvas`, `map.detail`, `map.search`, `map.filter.loads`, `map.filter.carriers`, `map.filter.lanes`, `map.filter.delayed`, `map.list_toggle`, `map.zoom_in`, `map.zoom_out`, `map.reset_view`, `map.tile_retry`, `map.skeleton`, dynamic: `map.load.<id>.pickup`, `map.load.<id>.dropoff`, `map.carrier.<id>`, `map.list.<id>`.

**Rule:** Every ID above must exist on a visible element after restyle. If a designer wants to drop an element, it must go through an oracle review that also deletes the matching handler in `tool-registry`/`api/tools.js`.

## 2. JS→DOM Dependencies

### IDs queried with `getElementById` / `#id`

**Shell**: `#route-target`, `#main`, `#route-live-region`

**Dock**: `#voice-dock`, `#voice-dock-toggle`, `#voice-dock-body` (via `.voice-dock-body` class), `#voice-transcript`, `#voice-transcript-hint`, `#voice-transcript-hidden`, `#voice-transcript-seg`, `#voice-transcript-note`, `#voice-status-pill`, `#voice-status-strip`, `#voice-status-text`, `#voice-muted-chip`, `#voice-live-chip`, `#voice-live-timer`, `#voice-ambient-chip`, `#voice-settings`, `#voice-settings-sheet`, `#voice-settings-close`, `#voice-call-btn`, `#voice-call-btn-label`, `#voice-call-hint`, `#voice-mic`, `#voice-mic-label`, `#voice-error`, `#voice-session-id`, `#voice-persona-seg`, `#voice-mode-seg`, `#voice-mode-note`, `#voice-theme-seg`, `#voice-clear`, `#voice-noise`, `#voice-noise-vol`, `#voice-phone`, `#voice-volume`, `#voice-compression-strength`, `#voice-compression-strength-readout`, `#voice-debug-panel`, `#voice-debug-metrics`

**Captions**: `#jarvis-captions`, `#jarvis-activity`, `#jarvis-chips`

**Dispatch**: `#summary-grid`, `#loads-tbody`, `#detail-panel`, `#detail-assign`, `#dispatch-map-sub`, `#dispatch-map-lanes`, `#filter-q`, `#filter-status`, `#filter-lane`

**Carriers**: `#carrier-grid`, `#carrier-q`, `#carrier-eq`, `#carrier-available`

**Negotiate**: `#load-id-readout`, `#negotiate-form`, `#convo-log`, `#rate-readout-amount`, `#field-pickup`, `#field-dropoff`, `#field-commodity`, `#field-weight`, `#field-target-rate`, `#field-note`, `#btn-counter`, `#btn-accept`

**Contact**: `#contact-form`, `#contact-name`, `#contact-email`, `#contact-preferred`, `#contact-message`, `#contact-feedback`, `#callback-list`

**Map**: `#map-root`, `#map-canvas`, `#map-detail`, `#map-attribution`, `#map-filter-rail`, `#map-filter-list`, `#map-list-view`, `#map-list-items`, `#map-list-toggle`, `#map-search`, `#map-zoom-in`, `#map-zoom-out`, `#map-reset`, `#map-tile-error`, `#map-tile-retry`

### Class selectors queried by JS (MUST continue to resolve)
`.app-header`, `.app-nav a[href]`, `.skip-link`, `.voice-dock-action`, `.voice-dock-body`, `#voice-status-strip .voice-vu .bar` (5× `<span class="bar">` children required for the VU animation; if replaced by canvas viz, keep a no-op-safe container), `.voice-line.is-hydrated`, `.map-pin` (map-widget does `el.querySelector('.map-pin')`), `.chip-btn[data-layer]`, `.palette-row`, `.palette-modal`, `.app-main.app-main--map`.

### Data attributes JS reads
`[data-state="<state>"]` on `#voice-status-pill` and `#voice-status-strip` — CSS colours VU bars off this. `[data-from]` on `.voice-line`, `[data-interim]` on `.voice-line`, `[data-layer]` on map filter chips, `[data-load-id]` on dispatch rows + map lanes, `[data-mode]` on mode/transcript segmented controls, `[data-theme-value]` on theme buttons, `[data-call-state]` on `#voice-call-btn` (five values: `idle`, `cancel`, `end`, `reconnect`, `closing` + matching `call-btn--*` classes), `[data-persona-id]` on persona buttons, `[data-external]` (router skip), `[data-agent-id]` (every tool), `[data-kind]`, `[data-status]`.

### Form `name` attributes (read via `new FormData(form)`)
Contact form: `name`, `email`, `message`, **`preferred-time`** (hyphen is load-bearing — do NOT rename to `preferred_time`).
Negotiate form: `pickup`, `dropoff`, `commodity`, `weight`, `target_rate`, `note`.

### Label `for` attributes
`tool-registry` uses `label[for="<input-id>"]` to compute accessible labels for the agent's element scan. Keeping `for`/`id` pairs intact preserves labels the LLM sees.

### `index.html` head
The theme bootstrap inline script (line 8) MUST run before CSS loads (FOUC prevention). The `<link rel="modulepreload">` tags for `/js/app.js`, `/js/voice-agent.js`, `/js/router.js` are a perf hook — preserve on any `<head>` rewrite.

## 3. File Classification

### Bucket A — FREELY REWRITE
- `css/tokens.css` — design tokens only. `map-widget.js` uses `var(--color-info)` etc. inside inline style templates, so those token names must still exist (or be aliased).
- `css/base.css`, `css/components.css`, `css/pages.css`, `css/map.css`, `css/voice-dock.css` — rewrite freely. Constraint: selectors for the class hooks in section 2 (`.is-*`, `.voice-vu .bar`, `[data-state=...]`, etc.) must keep their CSS-to-state behaviour or regress visually.

### Bucket B — RESTYLE CAREFULLY
- `index.html` — keep `<div id="main">`, `<div id="route-target" aria-live="polite">`, the theme bootstrap script, modulepreloads, and `<script type="module" src="/js/app.js">`. Everything else is cosmetic.
- `partials/*.html` — classes can change; EVERY `id`, `data-agent-id`, `role`, `aria-*`, `aria-live`, `aria-pressed`, `name`, `for`, `hidden`, `type="..."`, `autocomplete`, `data-layer`, `data-load-id` MUST stay. `<form>` with `id` that tool-registry clicks via `submit_form` (`#negotiate-form`, `#contact-form`) must remain `<form>`. Single `<h1>` per partial for router focus.

### Bucket C — DO NOT TOUCH (JS)
- `js/app.js`, `js/voice-agent.js`, `js/audio-pipeline.js`, `js/audio-worklets/pcm-capture.js`, `js/router.js`, `js/tool-registry.js`, `js/stt-logger.js`, `js/wake-word.js`, `js/stt-worker.js`, `js/stt-controller.js`, `js/local-stt.js`, `js/map-widget.js`, `js/activity-indicator.js`, `js/captions-overlay.js`, `js/command-palette.js`, `js/palette-actions.js`, `js/quick-chips.js`, `js/theme.js`, `js/page-*.js`, `js/personas.js`
- `api/*.js`

**Exception — `js/ui.js` is on the edge.** It builds the header, skip link, and dock. The dock redesign requires editing `buildDockMarkup()` (and possibly `buildHeader()`). Surgical HTML-template change inside JS. Dev B owns this with reviewer gate.

## 4. Risky Files

### `js/ui.js` — Dev B with reviewer gate

*Why risky*: builds the entire dock DOM; `app.js` + `voice-agent.js` + `activity-indicator.js` + `quick-chips.js` + `theme.js` + `command-palette.js` all query inside this DOM.

*Must preserve*: every ID in section 2 under "Dock"; the structure `#voice-status-strip > .voice-vu > 5× .bar`; `.voice-dock-body` (chips mount); `.voice-dock-action` (activity-indicator mount); `[data-state]` on pill + strip driven by `setPill`; `[data-call-state]` on call button driven by `renderCallButton`; `#voice-persona-seg`, `#voice-mode-seg`, `#voice-transcript-seg`, `#voice-theme-seg` as containers with child `<button>` elements carrying `data-persona-id`/`data-mode`/`data-theme-value`; `#voice-transcript` as transcript scroll container; `#voice-error` as error banner slot; `aria-live="polite"`, `role="dialog"` on settings sheet.

*Must NOT*: rename an ID, move the VU bars outside `#voice-status-strip`, drop the `hidden` attribute handling on chips/banners, remove `aria-expanded`/`aria-pressed`/`aria-checked`, change `<button>` to `<div role="button">` (tool-registry's `click` calls `el.click()`), or wrap the dock root in a new element without keeping `id="voice-dock"` at the semantic top level.

*Dock redesign path*: ship a new `buildDockMarkup()` that emits the new shape, keep the selectors. If the redesign needs to drop the VU bars or replace them with an audio-visualiser canvas, add a new canvas element inside `#voice-status-strip` so `wireVuMeter` can fall back to empty `bars.forEach` (already guarded with `if (!bars.length) return`), AND wire the visualiser to `agent.pipeline.readMicLevel()` / `agent.pipeline.readVuLevel()` inside a new animation loop in ui.js.

### `js/router.js`
Reads `#route-target`, `#route-live-region`, `this.target.querySelector('h1')`, `.app-nav a[href]`. Preserve `#route-target` in `index.html`; every partial has exactly one `<h1>`; nav anchors inside `.app-nav`.

### `js/voice-agent.js`
Reads `#voice-error`; passes `#voice-transcript` to `TranscriptLog`; uses `#voice-dock` for MutationObserver selective filtering.

### `js/map-widget.js`
Reads `#map-canvas`, `#map-detail`, `#map-attribution`, `#map-filter-rail`, `#map-filter-list`, `#map-list-view`, `#map-list-items`, `#map-list-toggle`, `#map-search`, `#map-zoom-in/-out`, `#map-reset`, `#map-tile-error`, `#map-tile-retry`. **Every one is in `partials/map.html` — must stay.** Also `.chip-btn[data-layer="..."]`. Does NOT change pin-creation to return non-`.map-pin` elements (flash highlighter does `el.querySelector('.map-pin')`).

### `js/page-*.js`
Each `enter(root)` queries by ID within the partial root. IDs map 1:1 with section 1's per-page list. Drop an ID → quietly break that page's data binding.

### `js/tool-registry.js`
`findByAgentId` global-queries `[data-agent-id="<CSS-escaped id>"]`. Also reads `getComputedStyle(el).display/visibility/opacity` and `getBoundingClientRect()` for visibility — if a restyle makes an agent-targeted element `display:none` by default, the agent won't see it.

## 5. File Ownership (Final)

### Dev A — Foundation (solo)
- `css/tokens.css`, `css/base.css`, `css/components.css`
- `index.html` `<head>` (font loading, modulepreloads, theme bootstrap script)
- Deliverable: tokens, base reset, typography scale, shared primitives (`.btn`, `.input`, `.select`, `.textarea`, `.chip`, `.chip--*`, `.panel`, `.panel-header`, `.panel-body`, `.field`, `.field-label`, `.row`, `.row-sm`, `.stack`, `.toolbar`, `.segmented`, `.toggle`, `.slider`, `.sr-only`, `.muted`, `.mono`, `.skip-link`, `.icon-btn`). Class names are a shared contract — Dev B and Dev C rely on them.

### Dev B — Agent surface (solo)
- `css/voice-dock.css`
- `js/ui.js` (dock/header/settings-sheet markup + wiring) — reviewer gate before merge
- Deliverable: dock visual redesign, all contracts from Risky Files preserved. New audio-visualiser must live inside `#voice-status-strip` so `wireVuMeter` is no-op-safe.

### Dev C — Pages (solo)
- `css/pages.css`, `css/map.css`
- `partials/dispatch.html`, `partials/carriers.html`, `partials/negotiate.html`, `partials/contact.html`, `partials/map.html`
- Deliverable: page-level layouts. Cannot touch `data-agent-id`, `id`, `name`, `for`, `role`, `aria-*`, input `type`, `autocomplete`. Cannot delete the single `<h1>` per partial.

## 6. Conflict Prevention

1. **Shared-vocabulary classes are Dev A's output; Dev B+C use them.** If Dev C needs a new variant (e.g. `.btn--xl`), Dev C files a request — Dev C does not add it to `components.css`.
2. **Dock markup is Dev B; `voice-dock.css` is Dev B.** Dev A stays out of the dock styles.
3. **`index.html` is Dev A, but `<script>` + `<link rel="modulepreload">` are load-bearing for Dev B's JS.** Dev A does not remove or reorder those.
4. **Header is built by `ui.js` (Dev B), not partials (Dev C).** Dev C does not render nav. Dev B does not render pages.
5. **MutationObserver in `ui.js` filters out mutations inside `#voice-dock`** — Dev C may freely re-render partial innerHTML; the observer triggers a debounced `sendElementsSnapshot`, which re-ships the agent-id list to the server. No coordination needed.
6. **Contract change procedure:** if Dev B or Dev C needs to drop a preservation item, file a ticket, oracle amends this plan, matching JS handler + `api/tools.js` tool schema updated in lockstep with the HTML change.
7. **Audio visualiser — designer-facing rule:** lives inside the dock (mounts inside the long-lived `#voice-dock`, not inside `#route-target` which re-renders). Driven by `agent.pipeline.readMicLevel()` / `readVuLevel()` from ui.js.

## 7. Verification Checklist

```bash
# Dev server + health
node server.js            # or PORT=3001 node server.js
curl -s http://localhost:3001/api/health

# Route smoke — load each SPA route, verify no console errors
# /, /dispatch.html, /carriers.html, /negotiate.html, /contact.html, /map.html

# Voice dock smoke, every page:
#   - dock visible and not occluding data
#   - click voice-dock-toggle → is-collapsed class toggles, body hides
#   - click voice-settings → settings sheet opens, aria-expanded=true
#   - Esc closes settings sheet
#   - Place Call button reads "Place Call" in IDLE state

# Agent-id smoke (browser console per route):
#   document.querySelectorAll('[data-agent-id]').length   // >= 15 per page
#   Spot-check critical IDs per page

# Responsive: 390 px (iPhone 14), 768 px (iPad), 1440 px (desktop)
#   Dock does not overlap data; tables scroll horizontally where needed.

# Keyboard
#   Tab from skip-link → nav → page <h1> → interactive elements → dock controls.
#   No tab traps in settings sheet. Esc closes.
#   Space/Enter toggles every chip/button.

# Motion
#   prefers-reduced-motion: reduce — dock collapse/expand has no animation;
#   map zoomAnimation/fadeAnimation disabled (already wired in map-widget.js).

# a11y
#   Every form field has a <label for="..."> or aria-label.
#   4.5:1 contrast for body text.
#   Focus ring visible on every button/link.
```

### Block-merge triggers (do not ship if any true)
- any `data-agent-id` from section 1 not present on expected route after render
- `#route-target`, `#voice-dock`, `#voice-call-btn`, `#voice-settings-sheet`, or `#voice-error` missing
- `filter_loads` or `filter_carriers` tool returns `Dispatch/Carrier filters not mounted`
- any partial missing its `<h1>`
- `<form>` for `#negotiate-form` or `#contact-form` replaced by a non-form element
- input `type` changed on any `negotiate.form.*` or `contact.form.*` field

## 8. Top 5 Breakage Risks + Mitigations

1. **A `data-agent-id` disappears during partial restyle** → agent tools silently fail. *Mitigation: Dev C runs agent-id smoke console snippet per page before PR; CI grep checks the union of IDs in §1 against post-render DOM.*
2. **Dev B renames a dock ID that `voice-agent.js`, `activity-indicator.js`, or `quick-chips.js` reads** → dock loses status pill or chips disappear. *Mitigation: reviewer gate on `ui.js` with the selector list from §2 as a checklist.*
3. **CSS rewrite removes `.voice-vu .bar`, `[data-state=...]` colour rules, or `.is-collapsed` / `.is-open` / `.is-agent-highlighted` / `.is-visible` animations** → states stop being visible even though JS flips the class. *Mitigation: Dev A + Dev B each include a "state hook" block listing every `.is-*` class the JS toggles, with at least a minimal visual treatment. Reviewer checks this block.*
4. **Form `name` renamed in `contact.html`** (`preferred-time` → `preferred_time` slip) → `FormData.get('preferred-time')` returns null. *Mitigation: Dev C treats `name` as frozen.*
5. **Dock redesign moves audio visualiser outside `#voice-dock`** → long-lived dock replaced on every route change, visualiser wiped. *Mitigation: designer brief.*

## 9. Designer / Dev B DOM constraints

- Audio visualiser lives **inside `#voice-dock`**. Dock is built once by `ui.js` and survives every SPA navigation. Anything needing continuous audio data (VU meter, waveform, spectrogram) must mount inside it.
- Visualiser data source: `agent.pipeline.readMicLevel()` (in-call, unmuted) or `agent.pipeline.readVuLevel()` (pre-call ambient). Current impl drives 5 `<span class="bar">` heights at rAF cadence. Canvas/svg replacement is fine, but must be driven from ui.js's animation loop where the `agent` reference is in scope; must tolerate `agent.pipeline` being in any state.
- Call button has **five** `data-call-state` values (`idle`, `cancel`, `end`, `reconnect`, `closing`) and five matching `call-btn--*` classes. Label text and icon swap. Redesign must cover all five states.
- `prefers-reduced-motion` honouring is not optional. Leaflet map, captions fade, dock collapse, and any new audio visualiser attenuate or disable motion when the media query matches.
