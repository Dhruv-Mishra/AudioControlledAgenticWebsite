# Dhruv FreightOps Frontend Overhaul v2 — "Expressive Console"

> Supersedes `specs/frontend-overhaul-design.md` (Harbor Bridge). DOM contract in `specs/frontend-overhaul-architecture.md` is unchanged and binding.

## 1. Concept

**Name: "Expressive Console"** — Material 3 Expressive (2025) applied with restraint to a dispatch console. Calm, tonal, container-first surface with one decisive lime accent, a single geometric sans throughout, and the minimised voice dock as the one visible "instrument." 

Inspirations:
- **Google Home redesign (2024–25)** — tonal surface ladder, filled tonal chips, container morphing between collapsed and expanded states. Drives the dock minimise→expand motion.
- **Google Wallet** — bottom-anchored rounded-rectangle pill with a primary filled action inside. Drives the **minimised dock pill**.
- **Google Calendar 2024+ / Gmail M3 refresh** — tonal top bar, segmented filter rail, dense-but-airy tables.
- **ChatGPT desktop's minimised chat pill** — always-visible primary action plus collapse caret in one 56–64 px bar. Drives the dock contents order.
- **Flutter Material 3 showcase / Polestar HMI** — spring physics under 200 ms, tonal primary fills, zero glassmorphism.
- **Linear (only for its dense data handling)** — row height, hairline discipline. Nothing else borrowed.

**Explicitly rejects** Harbor Bridge's Fraunces display serif, amber+cyan lamp gradient, vignette/grain/scanline atmosphere, compass rose, radar sweep, copper underline bars, ledger-rule backgrounds, brass rate-dial, purple-to-pink gradients, glassmorphism, Inter/Roboto/Space-Grotesk/Manrope defaults.

---

## 2. Color tokens (M3 dynamic + legacy aliases)

**Accent commitment: vivid lime `#BEF264` primary in dark mode (`#A3E635` strong); `#3E5A0B` in light mode.** Dark is default.

### Dark (default)

```css
:root {
  /* --- M3 Expressive tonal palette --- */
  --md-sys-color-primary:             #BEF264;
  --md-sys-color-on-primary:          #0F1A00;
  --md-sys-color-primary-container:   #2F4A00;
  --md-sys-color-on-primary-container:#DCFCA0;
  --md-sys-color-secondary:           #C4CCB3;
  --md-sys-color-on-secondary:        #1C2113;
  --md-sys-color-secondary-container: #2B3326;
  --md-sys-color-on-secondary-container:#DDE7CB;
  --md-sys-color-tertiary:            #8AD4E0;
  --md-sys-color-on-tertiary:         #00363F;
  --md-sys-color-tertiary-container:  #1F4A52;
  --md-sys-color-on-tertiary-container:#C4ECF3;
  --md-sys-color-error:               #FFB4AB;
  --md-sys-color-on-error:            #690005;
  --md-sys-color-error-container:     #93000A;
  --md-sys-color-on-error-container:  #FFDAD6;

  /* Surface ladder */
  --md-sys-color-surface-dim:                 #0F1210;
  --md-sys-color-surface:                     #11151F;
  --md-sys-color-surface-bright:              #2A2F28;
  --md-sys-color-surface-container-lowest:    #0B0E09;
  --md-sys-color-surface-container-low:       #151A14;
  --md-sys-color-surface-container:           #1A2018;
  --md-sys-color-surface-container-high:      #212A1F;
  --md-sys-color-surface-container-highest:   #2A3327;

  --md-sys-color-on-surface:          #E3E8DE;
  --md-sys-color-on-surface-variant:  #BFC7B7;
  --md-sys-color-outline:             #8A9282;
  --md-sys-color-outline-variant:     #424A3C;

  --md-sys-color-warn:                #FFB787;
  --md-sys-color-on-warn:             #4A2400;
  --md-sys-color-warn-container:      #663808;

  /* --- Legacy --color-* aliases (load-bearing for JS inline styles) --- */
  --color-bg:             var(--md-sys-color-surface);
  --color-bg-elev-1:      var(--md-sys-color-surface-container-low);
  --color-bg-elev-2:      var(--md-sys-color-surface-container);
  --color-bg-elev-3:      var(--md-sys-color-surface-container-high);
  --color-bg-elev-4:      var(--md-sys-color-surface-container-highest);
  --color-border:         var(--md-sys-color-outline-variant);
  --color-border-strong:  var(--md-sys-color-outline);
  --color-border-accent:  color-mix(in oklab, var(--md-sys-color-primary) 50%, transparent);
  --color-text:           var(--md-sys-color-on-surface);
  --color-text-muted:     var(--md-sys-color-on-surface-variant);
  --color-text-dim:       var(--md-sys-color-outline);
  --color-text-inverse:   var(--md-sys-color-on-primary);
  --color-accent:         var(--md-sys-color-primary);
  --color-accent-strong:  #A3E635;
  --color-accent-soft:    var(--md-sys-color-primary-container);
  --color-accent-wash:    color-mix(in oklab, var(--md-sys-color-primary) 10%, transparent);
  --color-accent-outline: color-mix(in oklab, var(--md-sys-color-primary) 45%, transparent);
  --color-warn:           var(--md-sys-color-warn);
  --color-warn-soft:      var(--md-sys-color-warn-container);
  --color-danger:         var(--md-sys-color-error);
  --color-danger-soft:    var(--md-sys-color-error-container);
  --color-info:           var(--md-sys-color-tertiary);
  --color-info-soft:      var(--md-sys-color-tertiary-container);
  --color-success:        var(--md-sys-color-primary);
  --color-success-soft:   var(--md-sys-color-primary-container);

  /* Voice agent state colors */
  --color-state-idle:       var(--md-sys-color-outline);
  --color-state-listening:  var(--md-sys-color-primary);
  --color-state-thinking:   var(--md-sys-color-tertiary);
  --color-state-speaking:   var(--md-sys-color-primary);
  --color-state-tool:       var(--md-sys-color-warn);
  --color-state-error:      var(--md-sys-color-error);

  /* Atmosphere — REMOVED but tokens stay, resolve transparent */
  --color-grain-overlay:    transparent;
  --color-scanline:         transparent;
  --color-vignette:         transparent;

  --color-overlay-bg:       color-mix(in oklab, var(--md-sys-color-surface-container-high) 96%, transparent);
  --color-overlay-scrim:    rgba(0, 0, 0, 0.56);
  --color-spotlight-mask:   rgba(0, 0, 0, 0.72);

  /* Map surfaces (consumed inline by map-widget.js) */
  --color-map-bg:                 var(--md-sys-color-surface-dim);
  --color-map-polyline:           color-mix(in oklab, var(--md-sys-color-primary) 75%, transparent);
  --color-map-polyline-pending:   color-mix(in oklab, var(--md-sys-color-warn) 65%, transparent);
  --color-map-pin-ring:           color-mix(in oklab, var(--md-sys-color-surface) 88%, transparent);
  --color-map-highlight-ring:     color-mix(in oklab, var(--md-sys-color-primary) 80%, transparent);
}
```

### Light

```css
[data-theme="light"] {
  --md-sys-color-primary:             #3E5A0B;
  --md-sys-color-on-primary:          #FFFFFF;
  --md-sys-color-primary-container:   #DCFCA0;
  --md-sys-color-on-primary-container:#111F00;
  --md-sys-color-secondary:           #56624A;
  --md-sys-color-on-secondary:        #FFFFFF;
  --md-sys-color-secondary-container: #DAE7C8;
  --md-sys-color-on-secondary-container:#141E0C;
  --md-sys-color-tertiary:            #00677A;
  --md-sys-color-on-tertiary:         #FFFFFF;
  --md-sys-color-tertiary-container:  #B3EBF5;
  --md-sys-color-on-tertiary-container:#001F25;
  --md-sys-color-error:               #BA1A1A;
  --md-sys-color-error-container:     #FFDAD6;
  --md-sys-color-on-error:            #FFFFFF;
  --md-sys-color-on-error-container:  #410002;
  --md-sys-color-surface:                     #FBFDF4;
  --md-sys-color-surface-dim:                 #DBDED3;
  --md-sys-color-surface-bright:              #FBFDF4;
  --md-sys-color-surface-container-lowest:    #FFFFFF;
  --md-sys-color-surface-container-low:       #F5F8EE;
  --md-sys-color-surface-container:           #EFF2E8;
  --md-sys-color-surface-container-high:      #E9ECE2;
  --md-sys-color-surface-container-highest:   #E3E6DD;
  --md-sys-color-on-surface:          #1A1D14;
  --md-sys-color-on-surface-variant:  #44483D;
  --md-sys-color-outline:             #74796C;
  --md-sys-color-outline-variant:     #C4C8BA;
  --md-sys-color-warn:                #7A4300;
  --md-sys-color-on-warn:             #FFFFFF;
  --md-sys-color-warn-container:      #FFDCC2;

  /* Legacy alias remapping */
  --color-bg:             var(--md-sys-color-surface);
  --color-bg-elev-1:      var(--md-sys-color-surface-container-low);
  --color-bg-elev-2:      var(--md-sys-color-surface-container);
  --color-bg-elev-3:      var(--md-sys-color-surface-container-high);
  --color-bg-elev-4:      var(--md-sys-color-surface-container-highest);
  --color-border:         var(--md-sys-color-outline-variant);
  --color-border-strong:  var(--md-sys-color-outline);
  --color-text:           var(--md-sys-color-on-surface);
  --color-text-muted:     var(--md-sys-color-on-surface-variant);
  --color-text-dim:       var(--md-sys-color-outline);
  --color-text-inverse:   var(--md-sys-color-on-primary);
  --color-accent:         var(--md-sys-color-primary);
  --color-accent-strong:  #2A4000;
  --color-accent-soft:    var(--md-sys-color-primary-container);
  --color-accent-wash:    color-mix(in oklab, var(--md-sys-color-primary) 8%, transparent);
  --color-accent-outline: color-mix(in oklab, var(--md-sys-color-primary) 50%, transparent);
  --color-warn:           var(--md-sys-color-warn);
  --color-warn-soft:      var(--md-sys-color-warn-container);
  --color-danger:         var(--md-sys-color-error);
  --color-danger-soft:    var(--md-sys-color-error-container);
  --color-info:           var(--md-sys-color-tertiary);
  --color-info-soft:      var(--md-sys-color-tertiary-container);
  --color-grain-overlay:  transparent;
  --color-scanline:       transparent;
  --color-vignette:       transparent;
  --color-overlay-bg:     color-mix(in oklab, var(--md-sys-color-surface-container) 96%, transparent);
  --color-overlay-scrim:  rgba(0, 0, 0, 0.32);
  --color-map-bg:         var(--md-sys-color-surface-dim);
  --color-map-polyline:           color-mix(in oklab, var(--md-sys-color-primary) 85%, transparent);
  --color-map-polyline-pending:   color-mix(in oklab, var(--md-sys-color-warn) 75%, transparent);
  --color-map-pin-ring:           color-mix(in oklab, var(--md-sys-color-surface) 92%, transparent);
  --color-map-highlight-ring:     color-mix(in oklab, var(--md-sys-color-primary) 85%, transparent);
}
```

### Contrast
- Dark: `#E3E8DE` on `#11151F` = 13.1:1 AAA. `#BEF264` on `#11151F` = 11.4:1. `#0F1A00` on `#BEF264` = 13.8:1 AAA filled button.
- Light: `#1A1D14` on `#FBFDF4` = 15.2:1. `#3E5A0B` on `#FBFDF4` = 6.1:1.

---

## 3. Typography — **Geist + Geist Mono**

Single family for display/UI/mono. Distinctive modern grotesque (Vercel, 2023–25), tabular numerics, slashed zero, generous x-height. Not in the banned list.

```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500;600&display=swap" />
```

```css
:root {
  --font-sans:    "Geist", ui-sans-serif, -apple-system, "Segoe UI Variable", "Helvetica Neue", sans-serif;
  --font-mono:    "Geist Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  --font-display: var(--font-sans);  /* aliased — legacy */

  /* Fluid scale */
  --fs-2xs:     clamp(10px, 0.68rem + 0.05vw, 11px);
  --fs-xs:      clamp(11px, 0.72rem + 0.10vw, 12px);
  --fs-sm:      clamp(13px, 0.82rem + 0.10vw, 13px);
  --fs-base:    clamp(14px, 0.90rem + 0.10vw, 14px);
  --fs-md:      clamp(15px, 0.94rem + 0.20vw, 16px);
  --fs-lg:      clamp(18px, 1.05rem + 0.40vw, 20px);
  --fs-xl:      clamp(22px, 1.20rem + 0.70vw, 26px);
  --fs-2xl:     clamp(28px, 1.40rem + 1.20vw, 36px);
  --fs-display: clamp(32px, 1.60rem + 2.10vw, 48px);

  --lh-xs:1.4; --lh-sm:1.5; --lh-base:1.5; --lh-md:1.45;
  --lh-lg:1.3; --lh-xl:1.2; --lh-2xl:1.1; --lh-display:1.05;

  --fw-regular:400; --fw-medium:500; --fw-semibold:600; --fw-bold:700;

  --tracking-tight:  -0.012em;
  --tracking-normal: 0;
  --tracking-open:   0.01em;
  --tracking-wide:   0.04em;
  --tracking-caps:   0.06em;
}

body {
  font-family: var(--font-sans);
  font-feature-settings: "ss01" 1, "ss02" 1, "cv11" 1, "zero" 1;
  font-variant-numeric: tabular-nums slashed-zero;
}

/* DROP every "opsz" / "SOFT" / "WONK" font-variation-settings — Fraunces axes. */
```

Headings use Geist 500 (medium), not 400. No italics serif. Labels are sentence-case Geist medium — drop the all-caps micro-labels with wide tracking from v1.

---

## 4. Shape tokens — M3 consistent, no asymmetric corners

```css
:root {
  --md-sys-shape-corner-none:  0px;
  --md-sys-shape-corner-xs:    4px;
  --md-sys-shape-corner-sm:    8px;
  --md-sys-shape-corner-md:   12px;
  --md-sys-shape-corner-lg:   16px;
  --md-sys-shape-corner-xl:   28px;
  --md-sys-shape-corner-full: 9999px;

  /* Legacy aliases */
  --radius-xs:   var(--md-sys-shape-corner-xs);
  --radius-sm:   var(--md-sys-shape-corner-sm);
  --radius-md:   var(--md-sys-shape-corner-md);
  --radius-lg:   var(--md-sys-shape-corner-lg);
  --radius-xl:   var(--md-sys-shape-corner-xl);
  --radius-pill: var(--md-sys-shape-corner-full);

  /* Dock — one radius minimised, one expanded — no mixed corners */
  --radius-dock:          var(--md-sys-shape-corner-full);
  --radius-dock-expanded: var(--md-sys-shape-corner-xl);
}
```

Shape assignment: chips `full`, buttons `full`, inputs `sm`, cards/panels `md`, modals `lg`, dock minimised `full`, dock expanded `xl`, FAB `lg`.

---

## 5. Motion tokens — M3 Expressive spring, fast

```css
:root {
  --dur-instant:  80ms;
  --dur-fast:    120ms;
  --dur-base:    180ms;
  --dur-slow:    320ms;
  --dur-map-fly: 600ms;

  --md-sys-motion-easing-emphasized:            cubic-bezier(0.2, 0, 0, 1);
  --md-sys-motion-easing-emphasized-accelerate: cubic-bezier(0.3, 0, 0.8, 0.15);
  --md-sys-motion-easing-emphasized-decelerate: cubic-bezier(0.05, 0.7, 0.1, 1);
  --md-sys-motion-easing-standard:              cubic-bezier(0.2, 0, 0, 1);
  --md-sys-motion-easing-standard-accelerate:   cubic-bezier(0.3, 0, 1, 1);
  --md-sys-motion-easing-standard-decelerate:   cubic-bezier(0, 0, 0, 1);

  --md-sys-motion-spring-spatial: linear(
    0, 0.082 3.5%, 0.322 7.5%, 0.666 12.5%, 1.012 18.5%,
    1.146 22%, 1.143 25.5%, 1.062 31%, 0.981 37%, 0.955 43%,
    0.985 52%, 1.007 66%, 1
  );
  --md-sys-motion-spring-effects: cubic-bezier(0.2, 0, 0, 1);

  /* Legacy aliases */
  --ease-snap:     var(--md-sys-motion-easing-emphasized);
  --ease-out-expo: var(--md-sys-motion-easing-emphasized-decelerate);
  --ease-material: var(--md-sys-motion-easing-standard);
  --ease-in-out:   var(--md-sys-motion-easing-standard);
  --ease-spring:   var(--md-sys-motion-spring-spatial);

  /* REMOVED — kept as 0 alias so pages.css rules still compile */
  --dur-stage: 0ms;
  --stagger-delay-1: 0ms; --stagger-delay-2: 0ms; --stagger-delay-3: 0ms;
  --stagger-delay-4: 0ms; --stagger-delay-5: 0ms; --stagger-delay-6: 0ms;
}

@media (prefers-reduced-motion: reduce) {
  :root {
    --dur-instant:0; --dur-fast:0; --dur-base:0; --dur-slow:0; --dur-map-fly:0;
    --md-sys-motion-spring-spatial: linear;
    --ease-spring: linear; --ease-material: linear; --ease-snap: linear;
  }
}
```

**No `--dur-stage` orchestration.** Content arrives fast in one ≤180 ms fade.

---

## 6. Elevation — M3 tonal ladder

```css
:root {
  --md-sys-elevation-level-0: none;
  --md-sys-elevation-level-1:
    0 1px 2px 0 rgba(0, 0, 0, 0.30),
    0 1px 3px 1px rgba(0, 0, 0, 0.15);
  --md-sys-elevation-level-2:
    0 1px 2px 0 rgba(0, 0, 0, 0.30),
    0 2px 6px 2px rgba(0, 0, 0, 0.15);
  --md-sys-elevation-level-3:
    0 4px 8px 3px rgba(0, 0, 0, 0.15),
    0 1px 3px 0 rgba(0, 0, 0, 0.30);

  /* Legacy aliases */
  --shadow-hairline:   inset 0 0 0 1px var(--color-border);
  --shadow-inset-lift: none;
  --shadow-overlay:        var(--md-sys-elevation-level-2);
  --shadow-overlay-strong: var(--md-sys-elevation-level-3);
  --shadow-dock:           var(--md-sys-elevation-level-2);
  --shadow-press-dark:     none;
  --shadow-pin:            var(--md-sys-elevation-level-1);
  --shadow-focus-ring-accent: 0 0 0 3px color-mix(in oklab, var(--md-sys-color-primary) 38%, transparent);
  --shadow-focus-ring-danger: 0 0 0 3px color-mix(in oklab, var(--md-sys-color-error) 38%, transparent);
  --shadow-focus-ring-cyan:   0 0 0 3px color-mix(in oklab, var(--md-sys-color-tertiary) 38%, transparent);
}
```

Usage: panels/cards/tables = level-0 + hairline. Nav = level-0. Dock minimised = level-2. Dock expanded = level-3. Command palette + settings sheet = level-3.

---

## 7. Component specs

### 7.1 Button (M3)

All buttons: 40 px tall (44 mobile), pill radius, no shadow, no inset highlight.

- **`.btn--primary`** → M3 Filled: `primary` bg, `on-primary` text.
- **`.btn`** (default) → M3 Filled Tonal: `secondary-container` bg, `on-secondary-container` text.
- **`.btn--outlined`** → M3 Outlined: transparent, `primary` text, `outline` border.
- **`.btn--ghost`** → M3 Text: transparent, `primary` text.
- **`.btn--danger`** → `error-container` bg, `on-error-container` text.
- Hover: slight color-mix lighten. `:focus-visible`: 3 px ring via `--shadow-focus-ring-accent`.
- Sizes: `.btn--sm` 32 px, `.btn--lg` 48 px, `.btn--icon` 40×40.

### 7.2 Chip

All chips 32 px tall, pill radius, sentence-case (no uppercase, no `tracking-caps`).

- `.chip` / `.chip-btn` default → outlined, `on-surface-variant` text.
- `[aria-pressed="true"]` / `.is-active` → tonal fill `secondary-container`.
- Status chips (`.chip--ok/warn/danger/info/accent/neutral`) → tonal fills from container palette.

### 7.3 Input / Select / Textarea — M3 Outlined

48 px tall, `outline` border, `sm` radius, no gradient fill. `:focus`: `primary` border + inset 1 px. `.field--float` floating label sits on the outline notch.

### 7.4 Panel / Card

`surface-container-low` bg, hairline `outline-variant`, `md` radius, no shadow, no gradient. Summary-card `.value` uses Geist medium (no Fraunces, no `font-variation-settings`).

### 7.5 Table

48 px row height, hairline `outline-variant` dividers, hover `surface-container`, `aria-selected` → `secondary-container`. **Drop the `tbody tr::before` coloured left-edge rail from v1.** Status communicated via chip in the Status column alone. Header labels are sentence-case `on-surface-variant`, no uppercase.

### 7.6 Top bar (nav)

`.app-header`: 64 px tall, `surface-container-low`, `outline-variant` bottom hairline, no amber glow, no shadow. Nav links: `full` radius, 40 px tall, 16 px padding. `[aria-current="page"]` → `secondary-container` fill. **Drop the `::after` underline bar.** **Drop the animated brand beacon dot** — static lime dot.

### 7.7 Segmented, toggle, slider

Segmented: filled-tonal selected state. Toggle: M3 switch, 52×32 track, 24 px thumb, `primary` when on. Slider: `primary` thumb, tonal track.

---

## 8. Voice dock — signature surface, minimised-first

### 8.1 Default state: MINIMISED PILL

**The critical user-requested behaviour.**

- Position: desktop `fixed; bottom:24px; right:24px`. Mobile `bottom:16px+safe-area; left:16px; right:16px`.
- Size: desktop **420 px × 60 px**, mobile **full width − 32 px gutter × 60 px**.
- Background: `surface-container-high` (`--color-bg-elev-3`).
- Border: 1 px `outline-variant`.
- Radius: `--radius-dock` (full pill).
- Elevation: `--md-sys-elevation-level-2` (single soft shadow).

**Pill contents (L → R, single row, gap 8 px):**

1. **State dot** (10 px, `--color-state-*` per state) — no radar ring, no sweep.
2. **Brand label** "Jarvis" — Geist 500, 14 px.
3. **Status chip** — 28 px tall, filled-tonal. Copy per state: *Stand by* / *Dialling* / *Listening* / *Thinking* / *Speaking* / *On call · 0:42*.
4. **Primary action button** (`#voice-call-btn`) — M3 filled primary, extended (label + icon). 40 px tall, pill radius. "Place Call" + phone icon. On desktop wide enough → label shows; on mobile &lt;380 px → icon-only 40×40.
5. **Expand caret** (`#voice-dock-toggle`) — 40 px icon button, ghost variant, chevron-up glyph.

**In call**, pill stays minimised; content morphs (M3 container-morph, `--dur-base` spring):
- State dot colour updates.
- Status chip shows "On call" + tabular-num timer.
- Call button morphs to "End Call" (filled error) — same bounding box, 180 ms crossfade.
- A small **mute toggle** (32 px round icon button, ghost) slides in between status chip and End button.

### 8.2 State dot colours (all preserve `[data-state]`)

| state | dot colour |
|---|---|
| `idle` / `arming` | `--md-sys-color-outline` |
| `dialing` / `live_opening` / `reconnecting` | `--md-sys-color-warn` |
| `live_ready` / `listening` | `--md-sys-color-primary` (lime) |
| `thinking` / `model_thinking` | `--md-sys-color-tertiary` (cyan) |
| `speaking` / `model_speaking` | `--md-sys-color-primary` + pulse |
| `tool_executing` | `--md-sys-color-warn` |
| `error` | `--md-sys-color-error` |
| `closing` | `--md-sys-color-outline` |

Dot-only CSS pulse: `1s ease-in-out infinite`; disabled in `prefers-reduced-motion`.

**Primary button idle pulse**: 1 px outline ring expands from the button every 3.2 s while `data-call-state="idle"`, opacity 0.4→0, `--dur-slow`. Disables on any other state. Honours reduced motion.

### 8.3 Expanded state — triggered ONLY by clicking expand caret

- Desktop: width 440 px, height `min(82vh, 720px)`, uniform `--radius-dock-expanded` (28 px). Anchored bottom-right.
- Mobile: bottom-sheet, top radius 28 px, full-width − 16 px, height `min(80dvh, 640px)`.
- Surface: `surface-container-highest`.
- Elevation: level-3.

**Expanded grid rows top→bottom:**
1. **Top bar** 64 px — brand dot + Jarvis + status chip + (timer in call) + settings icon + collapse caret.
2. **Error banner** (hidden default).
3. **Visualiser** 72 px — compact horizontal 5-bar level meter inside `#voice-status-strip` so `wireVuMeter` stays no-op-safe.
4. **Transcript** 1 fr — `surface-container` bg, 20 px line-height, no ledger ruling, from/agent/tool coloured semantic tokens.
5. **Quick-chips row** 48 px (auto height; inserted by `js/quick-chips.js`).
6. **Action footer** auto — Primary Call button (filled, extended, 48 px), mute button, hint line, kbd pips (small, ghost tone).

**Settings sheet** (`#voice-settings-sheet`) preserves `role="dialog" aria-modal="true"`, tabbed layout, slides from right on desktop, bottom-sheet on mobile. `surface-container-highest` bg, no gradient wash.

### 8.4 Visualiser

Keep 5 `<span class="bar">` spans inside `#voice-status-strip`. Render as vertical bars: 6 px wide, 4 px gap, max height 48 px, driven by `agent.pipeline.readMicLevel()`/`readVuLevel()` via the `wireVuMeter` rAF loop. Colour per `[data-state]` (lime/cyan/warn/error/outline-variant).

**REMOVED**: `.voice-scope-compass`, `.voice-scope-needle`, `.voice-scope-hub`, `.voice-scope-ticks`, `.voice-scope::before` scanline, `.voice-scope::after` reticle grid, `.voice-scope-readout`. The SESS id folds into the top-bar chip group.

### 8.5 Call button — state machine (all 5 states preserved)

| `data-call-state` | label | icon | variant | pulse |
|---|---|---|---|---|
| `idle` | Place Call | phone | `btn--primary` (filled lime) | 3.2 s idle ring |
| `cancel` | Cancel | × | `btn--outlined` warn | none |
| `end` | End Call | handset-down | `btn--danger` | none |
| `reconnect` | End Call | handset-down | `btn--danger` + 1.4 s attention pulse | yes |
| `closing` | Ending… | handset-down | `btn--outlined` disabled | none |

Transitions: same bounding-box container-morph, content crossfades over `--dur-base`.

### 8.6 Minimised ↔ expanded morph

- Height 60 px ↔ target height, `--dur-slow` `--md-sys-motion-spring-spatial`.
- Radius `full` ↔ 28 px `xl` over `--dur-slow` `--md-sys-motion-easing-emphasized`.
- Width 420 ↔ 440 on desktop.
- Internal body rows fade `opacity 0↔1`, `--dur-base`, `--md-sys-motion-spring-effects`. No stagger delays.
- `prefers-reduced-motion`: snap to target.

### 8.7 DOM contract preserved (CRITICAL)

Every ID, data-agent-id, class hook, aria-attr listed in `specs/frontend-overhaul-architecture.md` §2 and §1 (dock section) must survive the rewrite. Non-negotiable: `#voice-dock`, `#voice-dock-toggle`, `#voice-call-btn[data-call-state]`, `#voice-settings`, `#voice-settings-sheet`, `#voice-transcript`, `#voice-status-pill[data-state]`, `#voice-status-strip`, `#voice-error`, all settings-sheet control IDs, all persona/mode/theme `-seg` containers, 5 `<span class="bar">` children inside `.voice-vu`, `aria-live="polite"` on pill + transcript, `role="dialog" aria-modal="true"` on settings sheet.

---

## 9. Page-level layouts

All pages use single-column stack by default; tables live on the page surface rather than inside an extra panel.

### 9.1 Dispatch

Drop the 3-col layout. Two stacked regions:
1. Header row: title + "Export CSV" (primary) + "New load" (tonal).
2. KPI row: 4 summary-cards, `repeat(auto-fit, minmax(200px, 1fr))`. Values in Geist 500, 28 px.
3. Filter bar: `surface-container-low`, 72 px tall. **Drop the 3-px left accent rail.**
4. Loads table: full-width `table-wrap`, no panel frame around it. Selection opens a **right-side detail drawer** on desktop (≥1100 px), full bottom-sheet on mobile. Drawer owns `#detail-panel`.
5. Activity rail demoted into the drawer or settings; `dispatch.open_map` / `dispatch.map_lanes` stay on a tab inside the drawer.

### 9.2 Carriers

Filter bar + `carrier-grid` at `repeat(auto-fit, minmax(280px, 1fr))`. **Kill the card hover translate/lift.** Hover → subtle `surface-container-high` fill swap.

### 9.3 Negotiate

One-column centered form, max-width 720 px. **Kill the `.rate-readout` brass dial** (conic-gradient knob). Rate readout becomes: large Geist 500 number + tonal chip delta below, optional 4 px pill progress bar beneath. `--rate-pct` still set by JS; only drives the linear bar.

### 9.4 Contact

One-column form, max-width 640 px. M3 outlined inputs. Submit = filled primary.

### 9.5 Map

Unchanged structure. Restyled per §10.

---

## 10. Map

- Shell: `--color-map-bg = surface-dim`. Filter rail `surface-container-low`, 320 px desktop, bottom-sheet mobile. **Drop the inset amber rail.**
- Filter rail uses M3 filter-chips (`.chip-btn`) with `secondary-container` when pressed.
- Detail drawer (`#map-detail`): `surface-container-high`, 28 px top-left radius, elevation-3, container-morph open (`--dur-slow` spring).
- Pins (`.map-pin`): 28 px circle, `primary` pickup, `tertiary` dropoff, `warn` delayed. 2 px `pin-ring` inset. No decorative copper rings.
- Polylines: lime 75 % active, warn pending. Stroke 3 px round.
- Controls: icon buttons in a floating `surface-container-high` pill, 12 px radius, stacked top-right.
- Tile error banner: `error-container` filled; retry = outlined button.

---

## 11. Accessibility

- Body contrast ≥ 7:1 AAA both modes.
- Primary action ≥ 13.8:1 AAA.
- Focus ring visible on every interactive; 3 px accent ring at 38 % opacity.
- Keyboard: skip-link → nav → page `<h1>` → content → dock pill. `Space`/`Enter` on call button. `Esc` closes settings and collapses expanded dock.
- `aria-live="polite"` on `#voice-status-pill` + `#voice-transcript` (preserved).
- `role="dialog" aria-modal="true"` on settings sheet, focus trap when open.
- `aria-expanded` on `#voice-dock-toggle`, `#voice-settings`.
- `aria-pressed` on mute + filter chips.
- `aria-current="page"` on active nav.
- Touch targets ≥ 44×44 on mobile.
- Tabular-num + slashed-zero on all IDs, timers, rates.
- `prefers-reduced-motion`: zeros durations, disables dot pulse, call-btn reconnect pulse, idle ring, container-morph — dock snaps.

---

## 12. Anti-patterns (forbidden)

- Serif display type (no Fraunces, Iowan, Charter).
- Banned fonts: Inter, Roboto, Arial, system-ui defaults, Space Grotesk, Manrope, Sora, Poppins, Montserrat, Open Sans, Lato, Nunito, Plus Jakarta Sans, DM Sans.
- Harbor Bridge signatures: amber+cyan dual accent, brass dial (`.rate-readout .dial`), compass rose, radar sweep, lamp halo behind dock (`.voice-dock-halo`), ledger rules (`repeating-linear-gradient`), copper underline bars (`.page-header::after`, `.summary-card::after`, filter-bar left rail, `.app-header` amber glow, `.app-nav a[aria-current]::after`).
- Atmosphere layer: `body::before` grain, `.app-shell::after` vignette, scanline overlays.
- Gradient substrates on body, inputs, panels, or panel headers.
- Glassmorphism (`backdrop-filter: blur`) anywhere.
- Purple-anything. Lavender `--color-state-thinking` — now tertiary cyan.
- Decorative SVG ornaments (compass, ticks, reticle, scope readout copper label).
- Animated brand beacon dot — static.
- All-caps with wide tracking as default label style. `.label-caps` class kept but styled sentence-case medium.
- Card hover `translateY(-2px)` lifts — flat M3 hover fills only.
- Multi-layer drop shadows on buttons/panels/cards.
- `--dur-stage` staggered entries.
- Emoji in UI (icons SVG only).
- Hero imagery on any page.
- Strings `Fraunces`, `Schibsted Grotesk`, `IBM Plex Mono`, `SOFT`, `WONK`, `opsz` anywhere in CSS.

---

## 13. Alignment with root

Tokens single-source in `css/tokens.css`. All values via CSS custom properties. Mobile-first, 2-space indent, semantic HTML, visible focus. Every legacy `--color-*`, `--radius-*`, `--dur-*`, `--ease-*`, `--stagger-delay-*`, `--shadow-*` name resolves via alias so Bucket C JS continues unchanged. Every `data-agent-id`, `#id`, `name`, `for`, `role`, `aria-*` from architecture §1/§2 preserved.

### What v2 overrides from v1
- Typography family: Fraunces + Schibsted + IBM Plex → Geist + Geist Mono.
- Accent system: amber+cyan → lime single.
- Dock shape: `28px 28px 14px 14px` → uniform `full` minimised / `xl` expanded.
- **Dock default state: expanded panel → minimised pill with visible Call button.**
- Atmosphere: grain + vignette + scanline + halo → flat.
- Motion: `--dur-stage: 560ms` + staggered entries → deleted; content arrives fast.
- Hover on cards: 2-px translate + shadow → tonal fill swap.
- All copper/underline/ribbon ornaments: removed.

### What stays
- File ownership (Dev A foundation, Dev B dock, Dev C pages).
- DOM contract from `specs/frontend-overhaul-architecture.md`.
