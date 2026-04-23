# Expanded Dock Menu — Production-Grade Spec

> Scope: `.voice-dock:not(.is-collapsed) .voice-dock-body` and the `#voice-settings-sheet` aside. Nothing outside those selectors changes.
> Consumes: `css/tokens.css` (M3), `css/voice-dock.css`, `css/components.css` (`.toggle` primitive).
> Owner: frontend-dev.
> Supersedes ad-hoc styling in `css/voice-dock.css:598-1162` for the rows listed below.

---

## 1. Expanded dock body

### 1.1 Layout grid

Spacing scale in use: **4 / 8 / 12 / 16 / 24 px** (all token-backed — `--sp-1..--sp-6`). No other increments permitted inside the dock body.

### 1.2 Breakpoints

| Name    | Width               | Transcript min-h | Transcript max-h | Body H total        |
| ------- | ------------------- | ---------------- | ---------------- | ------------------- |
| Mobile  | ≤ 640 px            | 200 px           | calc(60dvh-144px)| fills bottom-sheet  |
| Tablet  | 641 – 1099 px       | 240 px           | 360 px           | auto                |
| Desktop | 1100 – 1599 px      | 260 px           | 420 px           | auto                |
| Wide    | ≥ 1600 px           | 280 px           | 480 px           | auto                |

### 1.3 Visualizer strip (`.voice-visualiser`)

- Height: **72 px** (unchanged). Padding: **12 px 16 px**. Border-bottom: `1px solid var(--md-sys-color-outline-variant)`.
- VU: keep all **5 bars**, 6 px wide, 4 px gap; idle height 4 px, max driven height 44 px. Retain the existing `wireVuMeter` contract — do not rename `.voice-vu .bar`.
- Readout right-aligned: label `Session` in `--fs-xs`, id in `--font-mono` tabular-nums. Use `color-mix(in oklab, var(--md-sys-color-on-surface) 72%, transparent)` for the label.

### 1.4 Transcript pane

- Padding: **16 px** all sides (upgrade from current `12px 16px 16px`).
- Inner transcript: radius `var(--radius-md)` (12 px), border `1px solid var(--md-sys-color-outline-variant)`, background `var(--md-sys-color-surface-container-low)`. Scrollbar thumb `var(--md-sys-color-outline-variant)`, 6 px wide.
- Line gap: **8 px** between turns; 12 px between speaker-change turns (`.voice-line + .voice-line[data-from]:not([data-from="system"])`).

### 1.5 Action footer (fixes the "unprofessional" complaint)

Current footer crushes the hint and the 5 kbd pips into one `flex-wrap: wrap` row. Replace with a two-row hierarchy:

```
┌─────────────────────────────────────────────────┐
│ [activity-indicator]                            │  row 1 — optional, mounted by JS
│ Click Place Call to talk to Jarvis.             │  row 2a — hint copy, left-aligned
│ ⌘K cmd   Space call   M mute   Esc close        │  row 2b — kbd pips, left-aligned, own line
└─────────────────────────────────────────────────┘
```

- Padding: **12 px 16 px 16 px**. Border-top: `1px solid var(--md-sys-color-outline-variant)`.
- Gap between hint and pips row: **8 px**.
- Hint copy: `--fs-sm` (13 px), `color: var(--md-sys-color-on-surface-variant)`, `line-height: var(--lh-sm)`.
- Kbd pips (`.voice-kbd`): **20×22 px**, `padding: 0 6px`, `border-radius: var(--radius-sm)` (8 px), background `var(--md-sys-color-surface-container-highest)`, border `1px solid var(--md-sys-color-outline-variant)`, font `var(--font-mono)` **11 px / 500 weight**, color `var(--md-sys-color-on-surface)`.
- Label next to each pip: `--fs-2xs` (10–11 px), `color: var(--md-sys-color-outline)`, 4 px gap.
- Mobile (≤640): show only 3 pips — Space, M, Esc. Hide `⌘K` and `/` via `display: none` on `.voice-kbd-hints > li:nth-child(n+4)`.

---

## 2. Settings sheet (`#voice-settings-sheet`)

### 2.1 Sheet shell

**Desktop (≥ 641 px):**

| Prop            | Value                                                   |
| --------------- | ------------------------------------------------------- |
| position        | fixed, `top: 24px; right: 24px; bottom: 24px`           |
| width           | `min(440px, calc(100vw - 48px))`                        |
| radius          | `var(--md-sys-shape-corner-xl)` — 28 px                 |
| background      | `var(--md-sys-color-surface-container-high)`            |
| border          | `1px solid var(--md-sys-color-outline-variant)`         |
| elevation       | `var(--md-sys-elevation-level-3)`                       |
| enter transform | `translateX(calc(100% + 48px)) → translateX(0)`         |
| enter duration  | `280ms` with `var(--md-sys-motion-spring-spatial)`      |

**Mobile (≤ 640 px):**

| Prop            | Value                                                                |
| --------------- | -------------------------------------------------------------------- |
| position        | fixed, `left: 0; right: 0; bottom: 0; top: auto`                     |
| width           | `100%`                                                               |
| height          | `min(80dvh, 640px)`                                                  |
| radius          | `28px 28px 0 0`                                                      |
| padding-bottom  | `env(safe-area-inset-bottom, 0)` added to body                       |
| drag handle     | **NEW** — see §2.2                                                   |
| enter           | `translateY(calc(100% + 24px)) → translateY(0)` @ 280 ms             |

### 2.2 Drag handle (mobile-only)

Visible only at ≤ 640 px. Sits above `.voice-settings-header`:

```html
<span class="voice-settings-handle" aria-hidden="true"></span>
```

- Dimensions: **32×4 px**, `border-radius: var(--radius-pill)`.
- Background: `var(--md-sys-color-outline)`.
- Centered via `margin: 12px auto 8px`.
- Hide on desktop: `@media (min-width: 641px) { .voice-settings-handle { display: none; } }`.
- Not interactive (no drag dismiss required) — purely an affordance cue. Mark `aria-hidden="true"`.

### 2.3 Header

- Height: **56 px**. Padding: `12px 12px 12px 20px` (unchanged).
- Title: `--fs-md` (16 px), `--fw-medium` (500), `letter-spacing: var(--tracking-tight)`.
- Close button: existing `.voice-icon-btn` — 40×40 hit, SVG 18×18.

### 2.4 Tab row — M3 primary tabs with underline indicator

Replace current pill-background active state (`css/voice-dock.css:934-938`) with M3 primary tab indicator.

Order: **Voice | Agent | Transcript | Theme** (unchanged).

```
┌────────┬────────┬──────────────┬────────┐
│ Voice  │ Agent  │  Transcript  │ Theme  │
│ ────── │        │              │        │   <- 2px indicator
└────────┴────────┴──────────────┴────────┘
```

| Prop                 | Value                                                       |
| -------------------- | ----------------------------------------------------------- |
| row height           | **48 px**                                                   |
| tab padding          | `0 16px`, tabs stretch equally (`flex: 1 1 auto`)           |
| font                 | `--fs-sm` (13 px) `--fw-medium`                             |
| inactive color       | `var(--md-sys-color-on-surface-variant)`                    |
| active color         | `var(--md-sys-color-primary)`                               |
| hover bg             | `color-mix(in oklab, var(--md-sys-color-on-surface) 6%, transparent)` |
| active indicator     | `::after` — 2 px bar, width = 40% of tab, centered, `background: var(--md-sys-color-primary)`, `border-radius: 2px 2px 0 0`, bottom 0 |
| indicator transition | `transform 160ms var(--md-sys-motion-easing-emphasized)`    |
| bottom divider       | `1px solid var(--md-sys-color-outline-variant)` on row      |
| focus                | `box-shadow: var(--shadow-focus-ring-accent)` (3 px)        |

Remove: `background: var(--voice-secondary-container)` on active. Active state is **indicator + color only** — no pill fill.

### 2.5 Voice panel — control rows (the complaint's core fix)

Current toggle rows have no consistent row chrome. New pattern: **full-width rows, 12 px vertical × 16 px horizontal padding, inline label on the left, control on the right, 1 px bottom divider.** Rows are the primary visual rhythm of the sheet.

Panel body padding: **0** (rows span edge-to-edge). Per-row padding carries the gutter. Keep the `.voice-settings-body` 16 px top-padding and drop its horizontal padding to `0`.

#### Row order (Voice panel):

| # | Control                  | Type                         | Layout                            |
| - | ------------------------ | ---------------------------- | --------------------------------- |
| 1 | **Mode**                 | Segmented (Place Call / Wake Word) | label column 96 px + segmented fills remaining |
| 2 | **Background audio**     | M3 switch                    | label + (optional) helper text stack on left, switch right |
| 3 | **Phone-line compression** | M3 switch (NEW)            | same as #2 with helper: "Adds a call-center warmth to Jarvis's voice" |
| 4 | **Volume**               | Range 0–150 with readout     | label column 96 px + slider + 40 px readout |

#### Row primitive (`.voice-settings-row`)

```
┌─────────────────────────────────────────────────────┐
│ [label]        [helper text optional]   [control]   │  12 px vertical padding
├─────────────────────────────────────────────────────┤  1 px divider
```

| Prop           | Value                                                         |
| -------------- | ------------------------------------------------------------- |
| display        | flex, `align-items: center`, gap `16px`                       |
| padding        | `12px 16px`                                                   |
| min-height     | **56 px** (matches M3 list-item, gives 44 px hit target)      |
| divider        | `border-bottom: 1px solid var(--md-sys-color-outline-variant)` |
| last row       | `border-bottom: 0`                                            |
| hover bg       | `color-mix(in oklab, var(--md-sys-color-on-surface) 4%, transparent)` (full-row state layer) |
| label text     | `--fs-sm` (13 px), `--fw-medium`, `color: var(--md-sys-color-on-surface)` |
| helper text    | `--fs-xs` (12 px), `color: var(--md-sys-color-on-surface-variant)`, margin-top 2 px, `line-height: var(--lh-sm)` |
| control region | `margin-left: auto` — right-aligned                           |

Variant for stacked segmented (mode row): add `.voice-settings-row--segmented` — switch to column layout at ≤ 480 px only; otherwise inline.

#### Toggle visual (reuse `.toggle` from `css/components.css:861`)

**Downsize from the current 52×32 / 24 px thumb to the spec target: 52×32 track, 20 px thumb.** Update `.toggle .track::after` checked state from `width: 24px; height: 24px` to `width: 20px; height: 20px; top: 4px; left: 28px`. Unchecked thumb: `16 px @ top 6px, left 6px` (unchanged).

Colors stay: unchecked track `--md-sys-color-surface-container-highest` with outline border; checked `--md-sys-color-primary` (lime), thumb `--md-sys-color-on-primary` (ink).

**Hit target**: the `<label class="toggle">` must stretch to fill the row so the whole right side is clickable. Give it `min-height: 44px; min-width: 52px; display: inline-flex; align-items: center`. Visible switch dimensions unchanged.

Keep the `<input type="checkbox">` semantic. **Do not** add `role="switch"` — `<input type="checkbox">` with the `.toggle` label is already correctly announced in NVDA/JAWS/VoiceOver. Label-to-input association is via `for="voice-*-toggle"`, already in place.

#### Phone-line compression row (NEW)

```html
<div class="voice-settings-row voice-settings-row--toggle">
  <div class="voice-settings-row-text">
    <span class="voice-settings-row-label">Phone-line compression</span>
    <span class="voice-settings-row-helper">Adds a call-center warmth to Jarvis's voice.</span>
  </div>
  <label class="toggle" for="voice-phone-compression-toggle">
    <input type="checkbox"
           id="voice-phone-compression-toggle"
           data-agent-id="voice.phone_compression_toggle" />
    <span class="track"></span>
    <span class="sr-only">Phone-line compression</span>
  </label>
</div>
```

- Default unchecked.
- Persist to `localStorage.jarvis.phoneCompression`.
- `data-agent-id="voice.phone_compression_toggle"` is mandatory — do not rename.
- Wire to `agent.setPhoneCompression(on)` which delegates to `pipeline.setPhoneCompression(on)` (exposed by the ai-engineer's pipeline change).

#### Background audio row

Update markup to use the new row primitive (same shell as phone-compression). Keep existing `id="voice-background-toggle"` and `data-agent-id="voice.background_toggle"`. Keep `checked` default and `localStorage.jarvis.backgroundAudio` persistence. No helper text required; optional helper: "Ambience loop plays during the call."

#### Volume row

- Slider: 150 px wide on desktop, 100% of remaining width on mobile.
- Tick marks at 0 / 50 / 100 / 150 — render as 4 absolute-positioned 1×8 px bars using `--md-sys-color-outline-variant`.
- Readout `<output>` to the right, 40 px wide, `--font-mono`, `font-variant-numeric: tabular-nums`, `--fs-sm`, `color: var(--md-sys-color-on-surface)`. Suffix `%`.
- Live-update via `input` event; `data-agent-id="voice.output_volume"` preserved.

### 2.6 Agent / Transcript / Theme panels

Apply the same `.voice-settings-row` primitive to every row in those panels. No more ad-hoc `.voice-control-row` layouts inside the sheet — they become instances of `.voice-settings-row`. Tab panels inherit the same 0-side-padding / full-width-rows rhythm.

---

## 3. Motion

| Element                  | Property              | Duration | Easing                                    |
| ------------------------ | --------------------- | -------- | ----------------------------------------- |
| Sheet enter (desktop)    | transform + opacity   | **280 ms** | `var(--md-sys-motion-spring-spatial)`   |
| Sheet enter (mobile)     | transform + opacity   | **280 ms** | `var(--md-sys-motion-spring-spatial)`   |
| Sheet exit               | transform + opacity   | **180 ms** | `var(--md-sys-motion-easing-emphasized-accelerate)` |
| Toggle switch            | track bg + thumb pos  | **160 ms** | `var(--md-sys-motion-easing-emphasized)` |
| Tab indicator slide      | transform             | **160 ms** | `var(--md-sys-motion-easing-emphasized)` |
| Row hover fade           | background-color      | `var(--dur-fast)` (120 ms) | `var(--ease-snap)`      |
| Slider thumb hover scale | transform 1 → 1.1     | `var(--dur-fast)` | `var(--ease-snap)`               |

`@media (prefers-reduced-motion: reduce)`: all durations above collapse to 0 via the existing `tokens.css:400-415` reset. No bespoke reduced-motion rules required.

---

## 4. Accessibility

- **Focus ring** on every interactive element: `box-shadow: var(--shadow-focus-ring-accent)` (3 px, lime @ 38%). No `outline` unless reinstating a fallback for Firefox.
- **Keyboard**:
  - Tabs: arrow-left / arrow-right cycles tabs (JS contract preserved from `js/ui.js` settings-tab wiring — do not regress).
  - Rows containing a single toggle: pressing Space on the row itself activates the label (works natively via `<label>` wrap).
  - Escape inside the sheet returns focus to `#voice-settings-btn` in the header (JS contract preserved).
- **Contrast**:
  - Row dividers on `--md-sys-color-surface-container-high` at 1.2:1 minimum (the existing `--md-sys-color-outline-variant` already meets this in both themes).
  - Helper text at 4.5:1 against the container surface — `--md-sys-color-on-surface-variant` meets this in dark and light.
- **Hit target**: every control ≥ 44×44 — enforced via row `min-height: 56px` and toggle `min-height: 44px`.
- **Announcements**: the `.sr-only` span inside each toggle label ensures screen readers read the control name even when the visible label is in a separate text node.
- **Reduced motion**: tokens collapse durations; do not add `prefers-reduced-motion: reduce` overrides inside this scope.

---

## 5. Non-negotiables

- Preserve every existing `id`: `voice-settings-sheet`, `voice-settings-title`, `voice-settings-close`, `voice-settings-panel-voice|agent|transcript|theme`, `voice-mode-seg`, `voice-background-toggle`, `voice-volume`, `voice-persona-seg`, `voice-transcript-seg`, `voice-theme-seg`, `voice-clear`, `voice-debug-panel`, `voice-debug-metrics`.
- Preserve every existing `data-agent-id` attribute on controls. **Add** `data-agent-id="voice.phone_compression_toggle"` on the new input with `id="voice-phone-compression-toggle"`.
- Preserve `role="dialog"`, `aria-modal`, `aria-labelledby`, `aria-hidden`, `role="tablist"`, `role="tab"`, `aria-selected`, `aria-controls`, `role="tabpanel"`, `role="radiogroup"`, `aria-checked` on everything they already exist on.
- Preserve the 5-bar VU contract (`#voice-status-strip .voice-vu .bar` iterated by `wireVuMeter`).

---

## 6. What to avoid (anti-patterns)

- Glassmorphism / backdrop-filter on the sheet — v2 rejects this.
- Pill-filled active tab — replaced by underline indicator per §2.4.
- Gradient toggle tracks — flat tonal only.
- Uppercase labels — `text-transform: none` everywhere; use `--tracking-normal`.
- Hardcoded hex values in row / toggle / slider styles. All colors via tokens.
- Icon-only toggle rows without a text label (accessibility regression).
- Wrapping action-footer hint + all 5 kbd pips into one unbounded wrap row (the original bug).

---

## 7. Alignment with root

**Stays (from `frontend-overhaul-v2-design.md`):** M3 Expressive palette, lime primary, Geist sans / Geist Mono, tonal surface ladder, `--md-sys-elevation-level-*` for depth, `--md-sys-motion-spring-spatial` for morph, 28 px dock-expanded radius.

**Overrides (scoped to this spec):**
- Tab active treatment: pill fill → underline indicator.
- Sheet width: 420 → 440 px desktop.
- Toggle thumb (checked): 24 px → 20 px.
- Settings body gutter: 16 px → 0 px (rows carry the gutter).
- `.voice-control-row` with fixed 82 px label column → replaced by `.voice-settings-row` with auto-width text stack.
- Kbd pips & action footer promoted from wrap-row to two-row hierarchy.

---

## 8. Implementation checklist for frontend-dev

1. Add `.voice-settings-row`, `.voice-settings-row-text`, `.voice-settings-row-label`, `.voice-settings-row-helper` primitives to `css/voice-dock.css` §11.
2. Add `.voice-settings-handle` rule (mobile-only) and insert the element into `js/ui.js` settings-sheet markup.
3. Rewrite `.voice-settings-tabs` / `.voice-settings-tab` rules to M3 underline per §2.4.
4. Shrink the checked-state thumb in `.toggle .track::after` in `css/components.css` to 20 px.
5. Add the phone-compression row in `js/ui.js` under the background-audio row.
6. Refactor all four settings panels to use `.voice-settings-row` — drop `.voice-control-row`/`.voice-control-label` inside the sheet (keep the class outside if other places use it).
7. Update `.voice-dock-action-footer` to the two-row hierarchy from §1.5; hide pips 4–5 on mobile.
8. Add `<output>` element and tick-marks to the volume row.
9. Verify: open dock → open settings → every row hit target ≥44 px, every control focus-visible, tabs switch with underline slide, reduced-motion collapses transitions, mobile shows drag handle + safe-area pad.
