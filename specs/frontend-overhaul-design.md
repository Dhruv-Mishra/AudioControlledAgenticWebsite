# Dhruv FreightOps — Frontend Overhaul Design Spec

## 1. Concept & Mood

**Name: "Harbor Bridge"** — a nautical/aviation control-bridge aesthetic crossed with a modernist Swiss rail timetable. The dispatcher is the captain on a ship's bridge at dusk: ink-dark wooden desk, brass instrument rings, amber glow from a paper chart under a lamp, a single cyan compass light, and the slow pulse of a radar sweep.

**Primary inspirations (real products / sources):**
- **Teenage Engineering OP-1 Field & TX-6 mixers** — the industrial-instrument typography (tight condensed labels over soft warm substrate), the precision ring dials, the sense that every control has been machined. This drives the dial-as-mic-level in the dock.
- **Braun T1000 world receiver / Dieter Rams control panels** — ruled horizontal registers, all-caps micro-labels in copper ink, panels that feel "tuned" rather than "designed".
- **Swiss SBB rail timetables / Massimo Vignelli's NYC subway map** — the numeric rail of the dispatch board; tabular figures, perfect 4px grid, colored status rails instead of noisy row backgrounds.
- **Figma's right panel + Linear's command K** — compactness, focus, hairline dividers.
- **Stripe Workbench / Raycast Pro** — the subtle gradient substrate and the feeling that the UI is *one continuous instrument*, not a collage of cards.
- **Radar scope (actual marine/aviation PPI scopes)** — the voice dock's listening-state ring is a radar sweep, not a pulsing blob.

This is explicitly **not** Linear-dark-console v2. We move from "code editor for trucking" to "ship's bridge for trucking" — warmer, more material, more characterful while staying just as data-dense.

---

## 2. Color Tokens

### Dark (default — "Night Bridge")

The substrate is a deep indigo-slate (not pure black) so the amber accent can feel like lamplight rather than a neon sticker.

```css
:root {
  /* Canvas — deep indigo-ink */
  --color-bg:             #0A0F14;   /* base canvas */
  --color-bg-grain:       #0C1219;   /* +1% lift under grain overlay */
  --color-bg-elev-1:      #10161D;   /* panels, dock body */
  --color-bg-elev-2:      #151C26;   /* hovered rows, inner panels */
  --color-bg-elev-3:      #1B2430;   /* modals, popovers */
  --color-bg-elev-4:      #222D3B;   /* raised dock header, active nav tab */

  /* Hairlines */
  --color-border:          #1F2935;
  --color-border-strong:   #2C3849;
  --color-border-accent:   rgba(247, 179, 43, 0.32);

  /* Ink */
  --color-text:            #ECE6D6;  /* warm bone — lamplight on paper */
  --color-text-muted:      #9CA7B6;
  --color-text-dim:        #5B6675;
  --color-text-inverse:    #0A0F14;

  /* --- Accents — amber lamp + cyan compass --- */
  --color-accent:          #F7B32B;  /* brass/amber — primary signal */
  --color-accent-strong:   #E39A0C;
  --color-accent-soft:     #2A1E06;
  --color-accent-wash:     rgba(247, 179, 43, 0.08);

  --color-cyan:            #4FD1C5;  /* compass cyan — secondary / live */
  --color-cyan-strong:     #2BB3A6;
  --color-cyan-soft:       #0A2A2A;

  /* State semantics */
  --color-warn:            #F59E3C;
  --color-warn-soft:       #2C1E0B;
  --color-danger:          #E15A4C;
  --color-danger-soft:     #2D0F0E;
  --color-info:            #4FD1C5;  /* cyan doubles as info */
  --color-info-soft:       #0A2A2A;
  --color-success:         #6BBF7B;  /* delivered */
  --color-success-soft:    #0E1F14;

  /* Voice agent state colors — each state owns a hue */
  --color-state-idle:       #5B6675;
  --color-state-listening:  #4FD1C5;  /* cyan — receptive */
  --color-state-thinking:   #C39BE8;  /* dusted lavender */
  --color-state-speaking:   #F7B32B;  /* amber — transmitting */
  --color-state-tool:       #F59E3C;  /* warn-amber */
  --color-state-error:      #E15A4C;

  /* Atmosphere */
  --color-grain-overlay:    rgba(255, 248, 220, 0.015);
  --color-scanline:         rgba(255, 248, 220, 0.018);
  --color-vignette:         rgba(0, 0, 0, 0.38);
  --color-glow-amber:       radial-gradient(circle, rgba(247,179,43,0.18), transparent 62%);
  --color-glow-cyan:        radial-gradient(circle, rgba(79,209,197,0.16), transparent 62%);
}
```

### Light (optional — "Paper Chart")

Warm cream, not white; dark ink; same amber + teal accents.

```css
[data-theme="light"] {
  --color-bg:             #F4EFE3;   /* nautical chart cream */
  --color-bg-grain:       #F0EAD8;
  --color-bg-elev-1:      #FBF7EC;
  --color-bg-elev-2:      #EAE2CE;
  --color-bg-elev-3:      #DDD2B9;
  --color-bg-elev-4:      #C9BD9E;

  --color-border:          #C8BCA0;
  --color-border-strong:   #A39577;
  --color-border-accent:   rgba(138, 76, 0, 0.32);

  --color-text:            #1B150A;
  --color-text-muted:      #57503F;
  --color-text-dim:        #8A806C;
  --color-text-inverse:    #FBF7EC;

  --color-accent:          #8A4C00;   /* umber ink — AAA on cream */
  --color-accent-strong:   #5E3400;
  --color-accent-soft:     #F0DFC2;
  --color-accent-wash:     rgba(138, 76, 0, 0.06);

  --color-cyan:            #1A6A63;
  --color-cyan-strong:     #0E4944;
  --color-cyan-soft:       #D2ECE8;

  --color-warn:            #B45309;
  --color-danger:          #B4261D;
  --color-success:         #2F6B3B;
  --color-info:            #1A6A63;

  --color-state-idle:       #8A806C;
  --color-state-listening:  #1A6A63;
  --color-state-thinking:   #6B4EA0;
  --color-state-speaking:   #8A4C00;
  --color-state-tool:       #B45309;
  --color-state-error:      #B4261D;
}
```

### Contrast verification
- Dark: `#ECE6D6` on `#0A0F14` → 15.9:1. `#F7B32B` on `#0A0F14` → 10.2:1. `#4FD1C5` on `#0A0F14` → 10.8:1. `#9CA7B6` on `#0A0F14` → 8.1:1. All AAA for body.
- Light: `#1B150A` on `#F4EFE3` → 15.0:1. `#8A4C00` on `#F4EFE3` → 6.2:1 AA. `#1A6A63` on `#F4EFE3` → 5.4:1 AA.

### Accent justification
**Amber (#F7B32B)** is the lit-lamp-on-chart-paper color — instantly evocative of a dispatch desk at 3am. It carries warmth the current green lacks and doesn't fall into the "tech bro cyan" trap. **Cyan (#4FD1C5)** is the receiving/listening color of every marine radio and compass rose; it pairs with amber because amber=transmit and cyan=receive, which maps directly to the voice dock's speaking/listening duality.

---

## 3. Typography

### Families (commit firmly — do NOT substitute)

**Display / Numeric / Editorial: `Fraunces`** (Google Fonts, SIL OFL). Variable font. Wide "SOFT" axis set to 30, "WONK" set to 1 on display sizes so the italics swashier. Fraunces is a modern revival of the transitional serifs used in 1970s rail timetables and shipping manifests. It carries weight and character — the antithesis of Inter.

**UI / Body: `Söhne` replacement → `ABC Diatype`** (paid) OR the free pairing **`Schibsted Grotesk`** (OFL, free at Google Fonts). Schibsted Grotesk was designed for a Norwegian news org; it has a slightly condensed, newspaper-ledger texture that is dense without feeling cramped. It is emphatically not Inter, not Space Grotesk, not Manrope. Use Schibsted Grotesk as the primary.

**Numeric Mono / Instrument: `Berkeley Mono`** (paid — Berkeley Graphics). Free fallback: **`Commit Mono`** (SIL OFL, free at commitmono.com). Commit Mono has wider apertures, tabular figures, and a slight warmth that Berkeley Mono shares. This replaces JetBrains Mono — which reads as a default developer font and undermines the "instrument panel" mood.

### Loading

```html
<!-- In <head>, preloaded -->
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="preload" as="style" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300;9..144,400;9..144,500;9..144,700&family=Schibsted+Grotesk:wght@400;500;600;700&display=swap" />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300;9..144,400;9..144,500;9..144,700&family=Schibsted+Grotesk:wght@400;500;600;700&display=swap" />

<!-- Commit Mono via @font-face, self-hosted in /public/fonts/ -->
```

```css
@font-face {
  font-family: "Commit Mono";
  src: url("/public/fonts/CommitMono-400-Regular.woff2") format("woff2");
  font-weight: 400;
  font-display: swap;
  font-style: normal;
}
@font-face {
  font-family: "Commit Mono";
  src: url("/public/fonts/CommitMono-700-Regular.woff2") format("woff2");
  font-weight: 700;
  font-display: swap;
  font-style: normal;
}
```

### Stacks

```css
:root {
  --font-display: "Fraunces", "Iowan Old Style", "Charter", Georgia, "Times New Roman", serif;
  --font-sans:    "Schibsted Grotesk", "Neue Haas Grotesk Text", "Helvetica Neue", Helvetica, Arial, sans-serif;
  --font-mono:    "Commit Mono", "Berkeley Mono", "Iosevka", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
```

### Weights to load
- **Fraunces:** 300, 400, 500, 700 (+ italic 400 for interim transcripts)
- **Schibsted Grotesk:** 400, 500, 600, 700
- **Commit Mono:** 400, 700

### Fluid type scale (mobile-first, clamp())

```css
:root {
  --fs-2xs:  clamp(10px, 0.68rem + 0.05vw, 11px);
  --fs-xs:   clamp(11px, 0.72rem + 0.10vw, 12px);
  --fs-sm:   clamp(13px, 0.82rem + 0.10vw, 14px);
  --fs-base: clamp(14px, 0.90rem + 0.15vw, 15px);
  --fs-md:   clamp(15px, 0.95rem + 0.25vw, 17px);
  --fs-lg:   clamp(18px, 1.05rem + 0.45vw, 21px);
  --fs-xl:   clamp(22px, 1.20rem + 0.85vw, 28px);
  --fs-2xl:  clamp(28px, 1.40rem + 1.60vw, 40px);
  --fs-display: clamp(36px, 1.70rem + 3.40vw, 64px);

  --lh-xs:  1.45;
  --lh-sm:  1.50;
  --lh-base:1.55;
  --lh-md:  1.45;
  --lh-lg:  1.30;
  --lh-xl:  1.15;
  --lh-2xl: 1.05;
  --lh-display: 0.98;
}
```

### Tracking

```css
--tracking-tight:  -0.015em;  /* display serif */
--tracking-normal: 0;
--tracking-open:   0.02em;
--tracking-wide:   0.08em;   /* uppercase instrument labels — wider than before */
--tracking-caps:   0.14em;   /* all-caps micro-labels on dock, panels */
```

### Feature settings

```css
body {
  font-family: var(--font-sans);
  font-feature-settings: "ss01" 1, "ss02" 1, "cv05" 1;  /* Schibsted Grotesk stylistic alts */
  font-variant-numeric: tabular-nums;
}

.display, h1.page-title, .rate-readout .amount {
  font-family: var(--font-display);
  font-feature-settings: "ss01" 1, "ss04" 1, "SOFT" 30, "WONK" 1;
  font-variation-settings: "opsz" 144, "SOFT" 30, "WONK" 1;
  letter-spacing: var(--tracking-tight);
}

.mono, code, pre, .mono-id, .rate-amount, .timer, .load-id {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums slashed-zero;
  font-feature-settings: "calt" 0, "zero" 1;
}

.label-caps {
  font-family: var(--font-sans);
  font-size: var(--fs-xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: var(--tracking-caps);
}
```

### Where each family is used
- **Fraunces (display):** page titles on hero-ish pages (dispatch `h1`, carrier directory `h1`), the big numeric readout on `.summary-card .value`, the `.rate-readout .amount`, settings sheet header.
- **Schibsted Grotesk (sans):** all body copy, buttons, nav, form inputs, chips, tables, transcript text.
- **Commit Mono (mono):** load IDs, MC numbers, carrier MCs, timestamps, tool-call lines, session id, timer, rate values, map popup titles, keyboard shortcuts.

---

## 4. Spacing / Radius / Elevation / Motion Tokens

### Spacing — 4px base, extended scale

```css
:root {
  --sp-0:  0;
  --sp-px: 1px;
  --sp-1:  4px;
  --sp-2:  8px;
  --sp-3:  12px;
  --sp-4:  16px;
  --sp-5:  20px;
  --sp-6:  24px;
  --sp-7:  32px;
  --sp-8:  40px;
  --sp-9:  56px;
  --sp-10: 72px;
  --sp-11: 96px;
  --sp-12: 128px;
}
```

### Radius — softer, with a distinctive "instrument" medium

Material 3 Expressive leans heavily on rounded containers. We soften our radii but keep a characteristic *asymmetric* panel shape on the dock.

```css
:root {
  --radius-xs:    4px;
  --radius-sm:    8px;
  --radius-md:    14px;   /* up from 8 — softer cards */
  --radius-lg:    20px;   /* modals, dock */
  --radius-xl:    28px;   /* dock expanded, bottom sheets */
  --radius-pill:  9999px;
  --radius-dock:  28px 28px 14px 14px;  /* distinct: big top, cut bottom */
}
```

### Elevation — tonal, not shadow-heavy

Material 3's tonal elevation: higher layers are paler/warmer. We use a single soft shadow for overlays plus a backlit amber halo on the dock for the "lamp on desk" feeling.

```css
:root {
  /* Tonal elevation handled via --color-bg-elev-{1..4} */

  --shadow-hairline:   inset 0 0 0 1px var(--color-border);
  --shadow-inset-lift: inset 0 1px 0 rgba(255, 248, 220, 0.03);

  --shadow-overlay:
    0 1px 0 rgba(255, 248, 220, 0.03) inset,
    0 2px 8px rgba(0, 0, 0, 0.35),
    0 18px 40px -12px rgba(0, 0, 0, 0.55);

  --shadow-overlay-strong:
    0 1px 0 rgba(255, 248, 220, 0.04) inset,
    0 4px 14px rgba(0, 0, 0, 0.35),
    0 28px 56px -12px rgba(0, 0, 0, 0.65);

  --shadow-dock:
    0 1px 0 rgba(255, 248, 220, 0.05) inset,
    0 0 0 1px rgba(247, 179, 43, 0.08),
    0 28px 60px -18px rgba(0, 0, 0, 0.70),
    0 -10px 40px -8px rgba(247, 179, 43, 0.06);  /* lamp halo */

  --shadow-focus-ring-accent: 0 0 0 3px rgba(247, 179, 43, 0.38);
  --shadow-focus-ring-cyan:   0 0 0 3px rgba(79, 209, 197, 0.38);
  --shadow-focus-ring-danger: 0 0 0 3px rgba(225, 90, 76, 0.38);

  --shadow-press-dark:  inset 0 2px 3px rgba(0, 0, 0, 0.35);
  --shadow-pin:         0 1px 2px rgba(0, 0, 0, 0.55);
}
```

### Motion — Material 3 Expressive springs

Material 3 Expressive introduces spring curves instead of cubic-bezier for state transitions. We adopt springs for the dock and state transitions; keep cubic-bezier on micro hover for snap.

```css
:root {
  /* Duration */
  --dur-instant: 80ms;
  --dur-fast:    140ms;
  --dur-base:    220ms;
  --dur-slow:    360ms;
  --dur-stage:   560ms;      /* entry orchestration */
  --dur-map-fly: 900ms;

  /* Easing */
  --ease-snap:    cubic-bezier(0.2, 0.9, 0.2, 1);           /* micro */
  --ease-out-expo:cubic-bezier(0.16, 1, 0.3, 1);            /* panel */
  --ease-material:cubic-bezier(0.34, 1.2, 0.3, 1);          /* subtle overshoot */
  --ease-spring:  linear(                                   /* M3 Expressive spring */
    0, 0.009, 0.035 2.1%, 0.141, 0.281 5.7%, 0.723 10.6%,
    0.938 14.1%, 1.017, 1.077, 1.121, 1.149 21.3%, 1.159,
    1.162, 1.156, 1.136 27.3%, 1.082 30.3%, 1.025, 0.974,
    0.939 38.9%, 0.936, 0.942, 0.95 45%, 0.991 55.3%,
    1.006 62.3%, 1.014 80.7%, 1.009 97.1%, 1
  );
  --ease-in-out: cubic-bezier(0.85, 0, 0.15, 1);
}

@media (prefers-reduced-motion: reduce) {
  :root {
    --dur-instant: 0ms;
    --dur-fast: 0ms;
    --dur-base: 0ms;
    --dur-slow: 0ms;
    --dur-stage: 0ms;
    --dur-map-fly: 0ms;
    --ease-spring: linear;
    --ease-material: linear;
  }
}
```

---

## 5. Component Specs

### 5.1 Button

```css
.btn {
  display: inline-flex; align-items: center; justify-content: center;
  gap: var(--sp-2);
  height: 40px;                            /* up from 36; AA tap target */
  padding: 0 var(--sp-5);
  font-family: var(--font-sans);
  font-size: var(--fs-sm);
  font-weight: 600;
  letter-spacing: var(--tracking-open);
  line-height: 1;
  border-radius: var(--radius-sm);
  background: var(--color-bg-elev-2);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  box-shadow: var(--shadow-inset-lift);
  transition:
    background var(--dur-fast) var(--ease-snap),
    border-color var(--dur-fast) var(--ease-snap),
    transform var(--dur-instant) var(--ease-snap);
  white-space: nowrap;
}
.btn:hover  { background: var(--color-bg-elev-3); border-color: var(--color-border-strong); }
.btn:active { transform: translateY(1px); box-shadow: var(--shadow-press-dark); }
.btn:focus-visible { outline: none; box-shadow: var(--shadow-focus-ring-accent); }
.btn[disabled], .btn[aria-disabled="true"] { opacity: 0.45; cursor: not-allowed; }

.btn--primary {
  background: var(--color-accent);
  color: var(--color-text-inverse);
  border-color: var(--color-accent-strong);
  box-shadow:
    inset 0 1px 0 rgba(255, 248, 220, 0.35),
    0 0 0 1px rgba(247, 179, 43, 0.12),
    0 8px 24px -8px rgba(247, 179, 43, 0.35);
}
.btn--primary:hover { background: var(--color-accent-strong); }

.btn--danger {
  background: var(--color-danger-soft);
  color: var(--color-danger);
  border-color: rgba(225, 90, 76, 0.35);
}
.btn--danger:hover { background: var(--color-danger); color: var(--color-text-inverse); }

.btn--ghost { background: transparent; border-color: transparent; }
.btn--ghost:hover { background: var(--color-accent-wash); border-color: var(--color-border-accent); color: var(--color-accent); }

.btn--sm  { height: 32px; padding: 0 var(--sp-3); font-size: var(--fs-xs); }
.btn--lg  { height: 48px; padding: 0 var(--sp-6); font-size: var(--fs-base); }
.btn--icon{ width: 40px; padding: 0; }

@media (max-width: 640px) {
  .btn { height: 44px; padding: 0 var(--sp-5); font-size: var(--fs-base); }
  .btn--sm { height: 36px; }
}
```

### 5.2 Chip

```css
.chip {
  display: inline-flex; align-items: center; gap: var(--sp-1);
  height: 24px;
  padding: 0 var(--sp-2);
  border-radius: var(--radius-pill);     /* pill-shape, not rectangle */
  font-family: var(--font-sans);
  font-size: var(--fs-2xs);
  font-weight: 600;
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
  border: 1px solid transparent;
  background: var(--color-bg-elev-2);
  color: var(--color-text-muted);
  transition: background var(--dur-fast) var(--ease-snap);
}
.chip::before {                            /* 5px dot always present */
  content: "";
  width: 5px; height: 5px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.9;
}
.chip--ok      { color: var(--color-success); background: var(--color-success-soft); border-color: rgba(107,191,123,0.22); }
.chip--warn    { color: var(--color-warn);    background: var(--color-warn-soft);   border-color: rgba(245,158,60,0.22); }
.chip--danger  { color: var(--color-danger);  background: var(--color-danger-soft); border-color: rgba(225,90,76,0.22); }
.chip--info    { color: var(--color-cyan);    background: var(--color-cyan-soft);   border-color: rgba(79,209,197,0.22); }
.chip--accent  { color: var(--color-accent);  background: var(--color-accent-soft); border-color: rgba(247,179,43,0.22); }
.chip--neutral { color: var(--color-text-muted); }
```

### 5.3 Input / Select / Textarea

```css
.input, .select, .textarea {
  display: block;
  width: 100%;
  height: 44px;
  padding: 0 var(--sp-4);
  font-family: var(--font-sans);
  font-size: var(--fs-sm);
  line-height: 1.4;
  color: var(--color-text);
  background: var(--color-bg);
  background-image: linear-gradient(180deg, rgba(255,248,220,0.012), transparent 40%);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  box-shadow: inset 0 1px 0 rgba(0,0,0,0.20);
  transition: border-color var(--dur-fast) var(--ease-snap), box-shadow var(--dur-fast) var(--ease-snap);
}
.input::placeholder { color: var(--color-text-dim); }
.input:hover  { border-color: var(--color-border-strong); }
.input:focus  { border-color: var(--color-accent); box-shadow: 0 0 0 3px rgba(247,179,43,0.18); outline: none; }
.input[aria-invalid="true"] { border-color: var(--color-danger); box-shadow: 0 0 0 3px rgba(225,90,76,0.18); }

.textarea { min-height: 120px; padding: var(--sp-3) var(--sp-4); resize: vertical; height: auto; line-height: 1.55; }

.select {
  appearance: none;
  padding-right: var(--sp-8);
  background-image:
    url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20'><path fill='%239CA7B6' d='M5 8l5 5 5-5z'/></svg>"),
    linear-gradient(180deg, rgba(255,248,220,0.012), transparent 40%);
  background-repeat: no-repeat;
  background-position: right 14px center, 0 0;
  background-size: 14px 14px, auto;
}

/* Floating-label variant (Material-inspired, used on Negotiate + Contact) */
.field--float {
  position: relative;
}
.field--float .input { padding-top: 18px; padding-bottom: 6px; height: 56px; }
.field--float .field-label {
  position: absolute; left: 16px; top: 18px;
  font-size: var(--fs-sm); letter-spacing: 0;
  text-transform: none; font-weight: 500;
  color: var(--color-text-muted);
  pointer-events: none;
  transform-origin: left top;
  transition: transform var(--dur-fast) var(--ease-material), color var(--dur-fast) var(--ease-snap);
}
.field--float .input:focus ~ .field-label,
.field--float .input:not(:placeholder-shown) ~ .field-label {
  transform: translateY(-10px) scale(0.75);
  color: var(--color-accent);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
}
```

### 5.4 Table

The dispatch table becomes a **numeric rail** — no row backgrounds by default, a 2px left **status rail** that carries the row's color, and the entire row reads like a timetable line. Row height 44px on desktop (was 36 — denser feels too cramped against larger typography).

```css
.table-wrap {
  overflow: auto; -webkit-overflow-scrolling: touch;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-elev-1);
  background-image:
    repeating-linear-gradient(180deg, transparent 0 43px, var(--color-border) 43px 44px);  /* horizontal rail every row */
  box-shadow: var(--shadow-hairline);
}
table.table { width: 100%; border-collapse: collapse; background: transparent; }

.table thead th {
  text-align: left;
  padding: 14px var(--sp-4);
  background: var(--color-bg-elev-2);
  font-family: var(--font-sans);
  font-size: var(--fs-2xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: var(--tracking-caps);
  color: var(--color-text-muted);
  border-bottom: 1px solid var(--color-border);
  position: sticky; top: 0; z-index: 1;
}

.table tbody tr {
  border-bottom: 1px solid var(--color-border);
  position: relative;
  transition: background var(--dur-fast) var(--ease-snap);
}
.table tbody tr::before {
  /* 2px status rail on left */
  content: ""; position: absolute; left: 0; top: 0; bottom: 0;
  width: 2px;
  background: transparent;
  transition: background var(--dur-fast) var(--ease-snap);
}
.table tbody tr[data-status="in_transit"]::before { background: var(--color-cyan); }
.table tbody tr[data-status="booked"]::before     { background: var(--color-accent); }
.table tbody tr[data-status="pending"]::before    { background: var(--color-warn); }
.table tbody tr[data-status="delayed"]::before    { background: var(--color-danger); }
.table tbody tr[data-status="delivered"]::before  { background: var(--color-text-dim); }

.table tbody tr:hover,
.table tbody tr[aria-selected="true"] { background: var(--color-bg-elev-2); }

.table td { padding: 12px var(--sp-4); height: 44px; vertical-align: middle; font-size: var(--fs-sm); }
.table td.mono, .table td.load-id {
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  color: var(--color-accent);        /* Load IDs in amber — instrument readout */
  letter-spacing: 0.02em;
}

@media (max-width: 640px) {
  /* Mobile: row becomes a stacked 2-line card */
  .table thead { display: none; }
  .table, .table tbody, .table tr { display: block; }
  .table tr {
    padding: var(--sp-3) var(--sp-4) var(--sp-3) var(--sp-5);
    border-bottom: 1px solid var(--color-border);
  }
  .table td { display: inline; padding: 0; height: auto; }
  .table td.load-id { display: block; font-size: var(--fs-xs); margin-bottom: 4px; }
  .table td[data-label]::before {
    content: attr(data-label) " ";
    font-size: var(--fs-2xs); text-transform: uppercase; letter-spacing: var(--tracking-caps);
    color: var(--color-text-dim); margin-right: 4px;
  }
}
```

### 5.5 Panel

```css
.panel {
  background: var(--color-bg-elev-1);
  background-image: linear-gradient(180deg, rgba(255,248,220,0.012) 0%, transparent 40%);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-hairline);
  overflow: hidden;
}
.panel-header {
  display: flex; align-items: center; justify-content: space-between;
  gap: var(--sp-3);
  padding: var(--sp-3) var(--sp-5);
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg-elev-2);
  /* Distinctive: a very subtle copper underline under the header */
  box-shadow: 0 1px 0 rgba(247, 179, 43, 0.06);
}
.panel-title {
  font-family: var(--font-sans);
  font-size: var(--fs-2xs);
  font-weight: 700;
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
  color: var(--color-accent);      /* titles carry amber — instrument labels */
}
.panel-body { padding: var(--sp-5); }
```

### 5.6 Card (summary cards, carrier cards)

```css
.summary-card {
  position: relative;
  background: var(--color-bg-elev-1);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: var(--sp-4) var(--sp-5) var(--sp-5);
  box-shadow: var(--shadow-hairline), var(--shadow-inset-lift);
  overflow: hidden;
}
.summary-card::after {
  /* tiny 2px accent stripe bottom-left — the "brass seam" */
  content: "";
  position: absolute; left: var(--sp-5); bottom: 0;
  width: 32px; height: 2px;
  background: var(--color-accent);
  opacity: 0.75;
}
.summary-card .label {
  font-family: var(--font-sans);
  font-size: var(--fs-2xs);
  font-weight: 600;
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
  color: var(--color-text-muted);
  margin-bottom: var(--sp-2);
}
.summary-card .value {
  font-family: var(--font-display);
  font-size: var(--fs-2xl);
  font-weight: 400;
  line-height: 1;
  letter-spacing: var(--tracking-tight);
  color: var(--color-text);
  font-variant-numeric: tabular-nums slashed-zero;
  font-feature-settings: "SOFT" 30, "WONK" 1;
}
.summary-card .delta {
  display: inline-flex; align-items: center; gap: 4px;
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  margin-top: var(--sp-2);
  padding: 2px 8px;
  border-radius: var(--radius-pill);
  background: var(--color-accent-soft);
  color: var(--color-accent);
}
.summary-card .delta--down { background: var(--color-danger-soft); color: var(--color-danger); }
```

### 5.7 Carrier card

```css
.carrier-card {
  position: relative;
  background: var(--color-bg-elev-1);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: var(--sp-4) var(--sp-5);
  display: grid;
  grid-template-columns: 40px 1fr auto;
  grid-template-rows: auto auto;
  gap: var(--sp-1) var(--sp-3);
  transition:
    border-color var(--dur-fast) var(--ease-snap),
    transform var(--dur-base) var(--ease-material);
}
.carrier-card:hover { border-color: var(--color-border-strong); transform: translateY(-2px); }

.carrier-card .avatar {
  grid-row: 1 / 3;
  width: 40px; height: 40px;
  border-radius: var(--radius-sm);
  background: var(--color-bg-elev-3);
  display: grid; place-items: center;
  font-family: var(--font-display);
  font-size: var(--fs-lg);
  color: var(--color-accent);
}
.carrier-card .name { font-family: var(--font-sans); font-weight: 600; font-size: var(--fs-md); letter-spacing: -0.005em; }
.carrier-card .mc   { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--color-text-muted); }
.carrier-card .row-actions { grid-column: 1 / -1; margin-top: var(--sp-2); display: flex; gap: var(--sp-2); }
```

### 5.8 Header / Nav

Header grows to **56px tall** (from 48) for better tap targets and display-font breathing room. A **1px copper hairline** sits beneath it.

```css
.app-header {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: var(--sp-5);
  height: 56px;
  padding: 0 var(--sp-5);
  background: var(--color-bg-elev-1);
  background-image: linear-gradient(180deg, var(--color-bg-elev-2) 0%, var(--color-bg-elev-1) 100%);
  border-bottom: 1px solid var(--color-border);
  box-shadow: 0 1px 0 rgba(247, 179, 43, 0.06);
  position: sticky; top: 0; z-index: var(--z-header);
}
.app-brand {
  display: flex; align-items: center; gap: var(--sp-2);
  font-family: var(--font-display);
  font-size: var(--fs-md);
  font-weight: 500;
  letter-spacing: var(--tracking-tight);
  color: var(--color-text);
}
.app-brand .dot {
  width: 10px; height: 10px;
  border-radius: 50%;
  background: var(--color-accent);
  box-shadow:
    0 0 0 2px var(--color-accent-soft),
    0 0 12px rgba(247, 179, 43, 0.45);
  animation: beacon 2.6s var(--ease-in-out) infinite;
}
@keyframes beacon {
  0%, 40%, 100% { box-shadow: 0 0 0 2px var(--color-accent-soft), 0 0 12px rgba(247,179,43,0.45); }
  50%           { box-shadow: 0 0 0 6px rgba(247,179,43,0.05), 0 0 24px rgba(247,179,43,0.35); }
}

.app-nav { display: flex; gap: 2px; align-self: stretch; }
.app-nav a {
  display: inline-flex; align-items: center;
  padding: 0 var(--sp-4);
  font-family: var(--font-sans);
  font-size: var(--fs-sm);
  font-weight: 500;
  color: var(--color-text-muted);
  border-radius: var(--radius-sm);
  position: relative;
  transition: color var(--dur-fast) var(--ease-snap), background var(--dur-fast) var(--ease-snap);
}
.app-nav a:hover { color: var(--color-text); background: var(--color-bg-elev-2); text-decoration: none; }
.app-nav a[aria-current="page"] {
  color: var(--color-text);
}
.app-nav a[aria-current="page"]::after {
  /* active underline — copper bar */
  content: "";
  position: absolute; left: var(--sp-3); right: var(--sp-3); bottom: 6px;
  height: 2px;
  background: var(--color-accent);
  border-radius: 2px;
}

@media (max-width: 640px) {
  .app-header { height: auto; padding: var(--sp-3) var(--sp-3); gap: var(--sp-3); grid-template-columns: 1fr auto; grid-template-rows: auto auto; }
  .app-nav { grid-column: 1 / -1; overflow-x: auto; padding-bottom: 4px; scrollbar-width: none; }
  .app-nav::-webkit-scrollbar { display: none; }
  .app-nav a { height: 36px; white-space: nowrap; }
}
```

### 5.9 Toolbar

```css
.toolbar {
  display: flex; align-items: center; gap: var(--sp-2);
  flex-wrap: wrap;
  padding: 6px;
  background: var(--color-bg-elev-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
}
.toolbar .btn { background: transparent; border-color: transparent; }
.toolbar .btn:hover { background: var(--color-bg-elev-3); border-color: var(--color-border); }
.toolbar .toolbar-sep { width: 1px; height: 24px; background: var(--color-border); margin: 0 var(--sp-1); }
```

### 5.10 Field

```css
.field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.field-label {
  font-family: var(--font-sans);
  font-size: var(--fs-2xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: var(--tracking-caps);
  color: var(--color-text-muted);
}
.field-help { font-size: var(--fs-xs); color: var(--color-text-dim); line-height: 1.4; }
.field-error {
  font-size: var(--fs-xs); color: var(--color-danger);
  display: flex; align-items: center; gap: 4px;
}
```

### 5.11 Rate-readout

Signature instrument on the negotiate page — **a circular dial** on desktop, linear bar on mobile.

```css
.rate-readout {
  display: grid;
  grid-template-columns: 72px 1fr auto;
  align-items: center;
  gap: var(--sp-4);
  padding: var(--sp-5) var(--sp-6);
  background: var(--color-bg-elev-2);
  background-image:
    radial-gradient(120% 90% at 0% 0%, rgba(247,179,43,0.06), transparent 55%);
  border: 1px solid var(--color-border-accent);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-hairline), inset 0 1px 0 rgba(255, 248, 220, 0.04);
}
.rate-readout .dial {
  /* 72px brass compass ring. svg-drawn, arc fills as rate approaches target */
  width: 72px; height: 72px;
  border-radius: 50%;
  background:
    radial-gradient(circle at 50% 60%, rgba(0,0,0,0.30), transparent 55%),
    conic-gradient(from 180deg, var(--color-accent) 0% calc(var(--rate-pct, 0) * 1%), rgba(247,179,43,0.12) calc(var(--rate-pct, 0) * 1%) 100%);
  position: relative;
}
.rate-readout .dial::before {
  /* inner cutout */
  content: ""; position: absolute; inset: 6px;
  border-radius: 50%;
  background: var(--color-bg-elev-2);
  box-shadow: inset 0 2px 6px rgba(0,0,0,0.45);
}
.rate-readout .amount {
  font-family: var(--font-display);
  font-size: var(--fs-2xl);
  font-weight: 400;
  letter-spacing: var(--tracking-tight);
  font-variant-numeric: tabular-nums slashed-zero;
  color: var(--color-text);
}
.rate-readout .unit {
  font-family: var(--font-sans);
  font-size: var(--fs-2xs);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
  color: var(--color-text-muted);
}
.rate-readout .delta {
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  padding: 4px 10px;
  border-radius: var(--radius-pill);
  background: var(--color-accent-soft); color: var(--color-accent);
}

@media (max-width: 640px) {
  .rate-readout { grid-template-columns: 1fr auto; padding: var(--sp-4); }
  .rate-readout .dial { display: none; }
  .rate-readout::before {
    /* linear bar instead */
    content: ""; grid-column: 1 / -1; order: 3;
    height: 4px; border-radius: 2px;
    background: linear-gradient(90deg, var(--color-accent) 0% calc(var(--rate-pct, 0) * 1%), var(--color-bg-elev-3) calc(var(--rate-pct, 0) * 1%) 100%);
  }
}
```

### 5.12 Convo-log

```css
.convo-log {
  background: var(--color-bg-elev-1);
  background-image: repeating-linear-gradient(180deg, transparent 0 27px, rgba(247,179,43,0.05) 27px 28px);   /* ledger rules */
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  height: 320px; overflow-y: auto;
  padding: var(--sp-4);
  display: flex; flex-direction: column; gap: var(--sp-3);
  font-family: var(--font-sans);
  font-size: var(--fs-sm); line-height: 28px;
}
.convo-entry {
  padding: var(--sp-2) var(--sp-3);
  background: transparent;
  border-left: 3px solid var(--color-accent);
  padding-left: var(--sp-3);
}
.convo-entry .author {
  font-family: var(--font-sans);
  font-size: var(--fs-2xs);
  font-weight: 700;
  text-transform: uppercase; letter-spacing: var(--tracking-caps);
  color: var(--color-accent);
}
.convo-entry .timestamp {
  font-family: var(--font-mono); font-size: var(--fs-2xs); color: var(--color-text-dim);
  margin-left: var(--sp-2);
}
.convo-entry[data-kind="counter"] { border-left-color: var(--color-cyan); }
.convo-entry[data-kind="counter"] .author { color: var(--color-cyan); }
.convo-entry[data-kind="accept"]  { border-left-color: var(--color-success); }
.convo-entry[data-kind="accept"]  .author { color: var(--color-success); }
.convo-entry[data-kind="reject"]  { border-left-color: var(--color-danger); }
.convo-entry[data-kind="reject"]  .author { color: var(--color-danger); }
```

### 5.13 Filter bar

```css
.filter-bar {
  display: flex; align-items: flex-end; gap: var(--sp-3); flex-wrap: wrap;
  padding: var(--sp-3) var(--sp-4);
  background: var(--color-bg-elev-1);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  margin-bottom: var(--sp-5);
  box-shadow: var(--shadow-hairline);
  /* distinctive: left brass bar */
  border-left: 3px solid var(--color-accent);
  padding-left: calc(var(--sp-4) - 2px);
}
.filter-bar .field { min-width: 160px; flex: 1 1 160px; }

@media (max-width: 640px) {
  .filter-bar { padding: var(--sp-3); gap: var(--sp-2); }
  .filter-bar .field { flex: 1 1 calc(50% - var(--sp-2)); }
}
```

### 5.14 Summary grid

```css
.summary-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: var(--sp-3);
  margin-bottom: var(--sp-6);
}
@media (max-width: 640px) {
  .summary-grid { grid-template-columns: repeat(2, 1fr); gap: var(--sp-2); }
}
@media (max-width: 380px) { .summary-grid { grid-template-columns: 1fr; } }
```

### 5.15 Skip-link

```css
.skip-link {
  position: absolute; left: var(--sp-4); top: var(--sp-2);
  padding: var(--sp-2) var(--sp-4);
  background: var(--color-accent);
  color: var(--color-text-inverse);
  border-radius: var(--radius-sm);
  font-family: var(--font-sans); font-weight: 600; font-size: var(--fs-sm);
  transform: translateY(-200%);
  transition: transform var(--dur-base) var(--ease-spring);
  z-index: var(--z-skip-link);
  box-shadow: var(--shadow-overlay);
}
.skip-link:focus { transform: translateY(0); }
```

---

## 6. Voice Agent Dock (DETAILED)

This is **the signature surface**. It is the "lamp on the dispatcher's desk" and it carries the metaphor.

### 6.1 Desktop layout (≥900px)

- **Footprint collapsed (idle, not in a call):** floating 64px-tall pill, **420px wide**, bottom-right, `bottom: 24px; right: 24px;`.
  - Contents left-to-right: brass radar-dot logo (10px), brand "Jarvis" in Fraunces 16px, a status chip, spacer, big amber "Place Call" pill button (auto-hug right), expand-caret icon button.
- **Footprint expanded:** **420px wide**, max-height `min(82vh, 720px)`, `border-radius: var(--radius-dock)` (big-top/small-bottom, asymmetric).
  - Rows top-to-bottom:
    1. **Header** (64px): brand + state-aware status pill + live-timer chip + mute chip + icon actions (settings, collapse). Header has a dark-amber halo `box-shadow: 0 -10px 40px -8px rgba(247,179,43,0.06)` — the lamp on the desk.
    2. **Scope panel** (140px): the audio viz region (see 6.4). Background is `--color-bg` with a subtle radial gradient + 1px cyan/amber reticle grid.
    3. **Transcript feed** (flex-1, min 240px): ledger-ruled feed. Auto-scroll with a sticky "Jump to latest" pill when user scrolls up >120px.
    4. **Quick chips row** (44px, only visible while in-call): scrollable horizontal chips — "Accept", "Counter", "Next load", "Show delayed", "Open map".
    5. **Action panel** (88px): the big Call/End button + mute toggle + hint copy.
  - Settings overlay slides in from the right edge of the dock (NOT from the bottom), `translateX(100%) → 0`, 320ms spring. This lets transcripts stay visible behind a slight scrim.

### 6.2 Mobile layout (≤640px)

True **bottom sheet** pattern with three snap points.

- **Collapsed pill:** 64px tall, centered horizontally, `bottom: 16px + env(safe-area-inset-bottom)`. 
  - Width: `calc(100vw - 32px)`, max 420.
  - Contents: 10px radar dot, Jarvis brand, status chip, spacer, round 48×48 amber Call button on the right. Tapping anywhere except the Call button expands; tapping Call places the call AND expands to half-sheet.
- **Half-sheet** (default when in a call): 56vh, grab-handle at top (36×4 rounded bar). Transcript + scope + action panel visible.
- **Full-sheet:** 94vh with safe-area padding. Reachable via pull-up gesture or expand button. Settings open inside.
- Rounded top corners `var(--radius-xl)`, no side/bottom borders.
- Scrim behind full-sheet: `var(--color-vignette)`.
- Swipe-down on handle collapses one level; swipe-down past threshold (40% of sheet height) collapses to pill.
- `padding-bottom: env(safe-area-inset-bottom)` throughout.
- Captions overlay, when transcript mode = captions, floats **above** the collapsed pill (not above full-sheet — redundant).

### 6.3 State machine — exact visual treatment

Every state has: (a) a **status pill** (top-right of header), (b) a **scope color**, (c) a **waveform behaviour**, (d) optional **haptic** (mobile).

| State | Pill label | Pill color | Scope glyph | Waveform |
|---|---|---|---|---|
| `idle` | "Stand by" | `--color-state-idle` grey pill, no pulse | dim grey compass rose, still | flat baseline |
| `dialing` | "Dialling…" | `--color-warn` amber pill, slow pulse 1.6s | amber compass, quarter-sweep rotating clockwise | rising spectrum sweep |
| `live_ready` / `listening` | "Listening" | `--color-cyan` pill, slow pulse 1.4s | cyan **radar sweep** rotating once per 3s, dots per audio burst | 32-bar equalizer driven by mic RMS |
| `thinking` / `model_thinking` | "Thinking" | lavender `#C39BE8` pill, pulse 0.9s | lavender **concentric dots** spiralling inward | inverted breathing (collapsing amplitude) |
| `speaking` / `model_speaking` | "Jarvis speaks" | `--color-accent` amber pill, pulse 0.9s | amber **outward pulse** (ripples from center) | agent-TTS waveform (orange bars) |
| `tool_executing` | "Taking action…" | amber `--color-warn` pill | **tool-targeted crosshair** with mini bouncing brackets | muted bars + horizontal scan-line |
| `error` | "Connection lost" | `--color-danger` red pill, no pulse (steady) | danger reticle, static | flat + 1 red mid-screen dash |
| `closing` | "Hanging up" | muted pill, slow fade | cyan contracts to center | bars fall to baseline |

- All pill state changes trigger a **420ms spring border-color transition** on the dock (subtle amber→cyan→lavender tint on the dock border to reinforce state).
- Shorthand: one `aria-live="polite"` text node in the pill announces label changes.

### 6.4 Audio visualization spec — "The Scope"

A 140px-tall panel directly below the header. Centered SVG, 280×120 viewbox.

**Two superimposed viz modes** (both always running, opacity cross-fade):

1. **Radar sweep (active in idle / listening / dialing states):**
   - 120×120 compass rose (amber hairlines at 12/3/6/9, cyan hairlines at 30° increments).
   - A 60°-wide amber sector rotates clockwise once per 3s (listening) or 1.2s (dialing).
   - Whenever a mic-level "burst" crosses threshold, a small 4px amber dot is deposited at the sweep's leading edge radius proportional to RMS (louder = closer to rim). Dots fade over 1200ms (last-N buffer).
2. **Equalizer bars (active in speaking / thinking):**
   - **32 bars**, 3px wide, 2px gap, height-driven by per-frame FFT of the agent TTS stream (or of the user mic if listening + captions mode).
   - Bars sit on the radar rose — the rose dims to opacity 0.2 when equalizer is active.
   - Bars colored by active state (amber for speaking, lavender for thinking).

**Tech contract for implementer:**
- Viz panel renders via a single `<canvas>` at devicePixelRatio, 60fps with `requestAnimationFrame`.
- Input: `VoiceAgent` exposes `getMicRMS()` (0..1) and `getPlaybackFFT(Uint8Array)` via AudioAnalyser.
- Fallback: no Web Audio → static compass rose with a "no audio" caption.
- **`prefers-reduced-motion: reduce` disables sweep rotation and bar animation**; bars hold at 50% height with a hairline caption "audio activity".

### 6.5 Transcript styling

```css
.voice-transcript {
  font-family: var(--font-sans);
  font-size: var(--fs-sm);
  line-height: 1.55;
  padding: var(--sp-4) var(--sp-5);
  gap: var(--sp-3);
  background: var(--color-bg);
  background-image:
    linear-gradient(180deg, transparent, var(--color-bg-grain) 80%),   /* subtle bottom wash */
    repeating-linear-gradient(180deg, transparent 0 23px, rgba(247,179,43,0.035) 23px 24px);
}
.voice-line {
  display: grid;
  grid-template-columns: 64px 1fr;
  gap: var(--sp-3);
  align-items: baseline;
  padding: 0;
}
.voice-line-tag {
  font-family: var(--font-mono);
  font-size: var(--fs-2xs);
  font-weight: 700;
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
  color: var(--color-text-dim);
  padding-top: 2px;
}
.voice-line[data-from="user"]   .voice-line-tag { color: var(--color-cyan); }
.voice-line[data-from="agent"]  .voice-line-tag { color: var(--color-accent); }
.voice-line[data-from="system"] .voice-line-tag { color: var(--color-text-muted); }
.voice-line[data-from="tool"]   .voice-line-tag { color: var(--color-warn); }

.voice-line-text { color: var(--color-text); word-break: break-word; }
.voice-line-text.is-interim { color: var(--color-text-muted); font-style: italic; font-family: "Fraunces", serif; font-weight: 300; }   /* interim in italic serif — editorial touch */
.voice-line[data-from="tool"] .voice-line-text {
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  color: var(--color-warn);
  background: var(--color-warn-soft);
  padding: 2px var(--sp-2);
  border-radius: var(--radius-xs);
  display: inline-block;
}
```

- **Smart scrollback:** if user scrolls up, auto-scroll pauses and a "Jump to latest" pill fades in at the bottom-center of the transcript.
- **Hydration fade:** stale lines from prior sessions drop to `opacity: 0.55` and show a lavender "resumed" divider.
- **Empty state** (replace current one): centered icon (small radar rose) + line "Dial Jarvis to begin. Transcript lands here." in Fraunces 300 italic 13px, muted.

### 6.6 Controls grouping (Settings sheet)

Organized into **four tabbed sections** (tab bar across top of sheet): **Voice · Agent · Transcript · Theme**.

- **Voice** tab:
  - Mic mode radiogroup: `Place Call` (live) · `Push to talk` · `Wake word` · `Always on`.
  - Noise bed: select + volume slider + A/B preview button ("Hear it").
  - Phone-line compression toggle + strength slider.
  - Output volume slider, 0–150%.
- **Agent** tab:
  - Persona segmented control (5 options) with a color dot and mini voice-preview play-button per option.
  - Wake phrase text input (only visible when wake-word mode).
- **Transcript** tab:
  - Transcript mode segmented: Off · Captions · Full.
  - Captions position radio: Above dock · Above content · Top bar.
  - "Clear transcript" button (ghost-danger).
- **Theme** tab:
  - Theme segmented: Dark · Light · System.
  - Contrast toggle: Standard · High.
  - Reduced-motion toggle (mirrors OS, user-override available).

### 6.7 Collapsed ↔ Expanded transitions

- Collapse: dock `height` animates 720→64, `border-radius` → `pill`, contents fade out 120ms first. 320ms spring (`--ease-spring`), `--dur-base`.
- Expand: reverse. Header contents fade in over 180ms starting at 80ms.
- On mobile, use `transform: translateY()` + `height` for performance.
- `prefers-reduced-motion` → instant swap, no transition.

### 6.8 Keyboard shortcuts (shown inline)

Displayed as small kbd pips in the footer hint of the dock:

- **Space** — place/end call (when dock focused)
- **M** — mute/unmute mic
- **Esc** — close settings sheet
- **⌘K / Ctrl+K** — command palette
- **/** — focus transcript
- **↑/↓** — navigate transcript lines (focus ring on each)

---

## 7. Page-Level Layouts

### 7.1 Dispatch (hero = *instrument board*)

- **Mobile (390px):**
  - Header 64px sticky.
  - Page header: 32px display title "Dispatch Board" + 14px muted subtitle, right-aligned icon row (new load, export).
  - Summary grid: **2 columns** of compact cards, values in Fraunces 28px.
  - Filter bar: 2-col grid of fields, sticky-top `top: 68px`.
  - Loads "table" stacks as cards (per spec 5.4).
  - Detail panel: slide-up bottom sheet when a row is tapped.
  - Fleet map card: full width, 180px height preview.

- **Tablet (700–1024px):**
  - Summary grid 3–4 cols.
  - Loads table full-width (horizontal scroll if necessary).
  - Detail panel docked right at `min(400px, 40%)`.

- **Desktop (1440px):**
  - **Three-column grid: `280px 1fr 360px`.** Left is a new *activity rail* (carrier pings, delayed lanes, incoming calls); center is the main table; right is detail + map preview.
  - Max content width: 1440 + 24 gutter each side.
  - Activity rail hides at ≤1280px, falls back to 2-col.

### 7.2 Carriers

- Hero treatment: the h1 "Carrier Directory" in Fraunces 48px on desktop, with a thin amber underline rule 96px long directly below.
- Grid of carrier cards. Mobile: 1 column. Tablet: 2 columns. Desktop (≥1100): 3 columns. Ultra (≥1440): 4 columns.
- Filter bar: sticky-top beneath header.

### 7.3 Negotiate

- **Mobile:** stacked (form first, log below).
- **Desktop:** `1fr 480px` grid — form fills, log panel on right at fixed 480px with sticky scroll.
- Rate-readout at top of the form becomes the focal instrument: the brass dial + big Fraunces figures.
- Two-column form grid collapses to single column under 640px.

### 7.4 Contact

- **Mobile:** single column.
- **Desktop:** `2fr 1fr` — contact form left (full-width inputs w/ floating labels), scheduled callbacks panel right.
- Callbacks panel uses **dot-timeline** styling: each callback item has a `::before` cyan dot + dashed line connecting to the next.

### 7.5 Map

See §8.

### 7.6 Page entry layout token

All pages share a top-of-page treatment:

```css
.page-header {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: end;
  gap: var(--sp-4);
  padding: var(--sp-7) 0 var(--sp-5) 0;      /* generous top breathing room */
  border-bottom: 1px solid var(--color-border);
  margin-bottom: var(--sp-6);
  position: relative;
}
.page-header::after {
  /* signature copper bar */
  content: "";
  position: absolute; left: 0; bottom: -1px;
  width: 96px; height: 2px;
  background: var(--color-accent);
}
.page-title {
  font-family: var(--font-display);
  font-size: var(--fs-2xl);
  font-weight: 400;
  letter-spacing: var(--tracking-tight);
  font-feature-settings: "SOFT" 30, "WONK" 1;
  color: var(--color-text);
}
.page-subtitle {
  font-family: var(--font-sans);
  font-size: var(--fs-sm);
  color: var(--color-text-muted);
  margin-top: var(--sp-1);
}
@media (max-width: 640px) {
  .page-header { padding: var(--sp-5) 0 var(--sp-3) 0; grid-template-columns: 1fr; }
  .page-title { font-size: var(--fs-xl); }
  .page-header::after { width: 64px; }
}
```

---

## 8. Map Page

The map page must let Leaflet's tiles breathe; we do not fight them. The rails and overlays carry the design.

### 8.1 Layout

- **Desktop:** `300px 1fr` grid. Filter rail becomes 300px (from 280) to fit richer filter UX.
- **Tablet (≤900px):** rail becomes top toolbar, chips scroll horizontally.
- **Mobile:** rail = horizontal chip bar at top (40px). Detail panel = bottom sheet (50vh, rounded top).

### 8.2 Filter rail

- Background: `--color-bg-elev-1` with a vertical right-edge brass hairline (`border-right: 1px solid var(--color-border-accent)`).
- Section titles: `font-family: var(--font-sans)`, 2xs uppercase amber.
- Filter chips: the spec 5.2 chips. Pressed state uses `--color-accent-soft` bg.
- Filter list items: card-styled rows with colored status dot (already implemented), add a small mono `load-id` below the route.
- **New: a mini-metric strip** at the top of the rail: `LANES 14 · ACTIVE 9 · DELAYED 2` in mono, 11px, centered.

### 8.3 Leaflet tile & map surfaces

- Tile filter: `filter: saturate(0.7) brightness(0.9) contrast(1.05)`. Keeps tiles cohesive with the night-indigo substrate without tinting them unrecognisably.
- **Must not apply** `invert()` — tiles go ghostly and unreadable. Already correct in current design.

### 8.4 Pins

Keep the current 16px circle + color. Add:
- **Carrier pins use a rounded-square** (`border-radius: var(--radius-xs)`) — distinct from load pins.
- **Delayed pins** get a subtle 2s breathing outer ring `animation: pin-breath`.
- Hover shows a **mono label tooltip** above the pin with load ID.
- Agent-highlighted pin: keep current triple-ring pulse, but recolor to amber (it currently uses the generic accent which will now be amber — so this is automatic with the new palette).

### 8.5 Lane polylines

- Booked: solid amber, 2.5px, shadow `drop-shadow(0 0 2px rgba(247,179,43,0.35))`.
- Pending: dashed warn `6 4`, 2px.
- In-transit: solid cyan, 2.5px, with an animated dash-offset marching effect (4s linear infinite). Respects reduced motion.

### 8.6 Detail drawer

- Slides from the right on desktop (`translateX(100%)` → 0) with spring over 320ms.
- Content: panel-style with a Fraunces load-id hero (48px), sub-grid of detail-kv rows, then actions row.
- On mobile: bottom sheet with grab handle.

### 8.7 Controls

- Map control cluster bottom-right: stacked `40×40` pill icon buttons — zoom-in, zoom-out, reset, "follow fleet" (new, toggles auto-pan).
- Background `--color-bg-elev-1`, `border: 1px solid var(--color-border)`, shadow overlay. Hover = amber wash.
- Shortcut shown on reset button: tiny `⌘0` kbd.

### 8.8 Attribution

Tiny copper-outlined pill, not a slab:

```css
.map-attribution {
  padding: 3px 8px;
  border: 1px solid var(--color-border-accent);
  border-radius: var(--radius-pill);
  background: rgba(10, 15, 20, 0.85);
  font-size: 10px;
  font-family: var(--font-mono);
}
```

---

## 9. Motion Spec

### 9.1 First-paint sequence (desktop & mobile)

Total budget: **820ms** from paint to "done". All stages spring-based except the skip link.

| Stage | Start | Duration | Target |
|---|---|---|---|
| 0. Skip link ready | 0 | — | (no anim) |
| 1. Header fade | 40ms | 240ms | `opacity 0→1, translateY(-6px → 0)` |
| 2. Page-title reveal | 140ms | 320ms | Fraunces title: `clip-path` wipe left→right + opacity |
| 3. Page subtitle fade | 240ms | 220ms | opacity |
| 4. Summary cards stagger | 300ms | each 280ms, 60ms apart | `opacity 0→1, translateY(10px→0)` |
| 5. Filter bar slide | 440ms | 280ms | `opacity 0→1, translateY(6px→0)` |
| 6. Main table rows stagger | 520ms | each 200ms, 20ms apart, cap 8 rows | opacity + y |
| 7. Voice dock entrance | 640ms | 420ms | from `scale(0.92) translateY(24px)` → 1 (spring) |
| 8. Voice dock beacon dot | 820ms | — | begins pulsing after dock lands |

Implementation: a single JS hook toggles `.is-mounted` on `<body>`; CSS handles the rest via `animation-delay`.

### 9.2 Hover / focus micro-interactions

- All buttons: 140ms snap (`--ease-snap`).
- Cards: 220ms material ease with 2px y-lift.
- Table rows: 140ms snap bg-color only; no transform (dense context).
- Focus rings: 120ms opacity-in, no scale.
- Chips: 140ms bg-color only.

### 9.3 Route transition

Only the `.route-target` body swaps between partials. On route change:
- `aria-busy=true` → fade existing to opacity 0.35 (120ms)
- Content swap
- New partial enters with a 220ms staggered page-header sequence (stages 2–5 above re-run but abbreviated).

### 9.4 Dock state transitions

- State pill changes: 320ms spring on `color` and `border-color`.
- Scope cross-fade between radar & EQ: 180ms opacity.
- Collapse/expand: 320ms spring on `height`, 120ms fade on contents.
- Call button label swap: 80ms fade-out + 140ms fade-in (total 220ms).

### 9.5 Reduced motion

When `prefers-reduced-motion: reduce`:
- All `--dur-*` → 0ms (already tokenised).
- All non-essential keyframe animations set to `animation: none` in a single override block.
- Equalizer bars hold at 50%.
- Beacon dot solid (no pulse).
- Radar sweep fades in place (no rotation).
- Pin pulses disabled (already in map.css).

---

## 10. Background / Atmosphere Treatment

We build a **three-layer** substrate that never exceeds ~3% visible influence.

**Layer 1 — Base gradient (body):**
```css
body {
  background:
    radial-gradient(1200px 600px at 10% -10%, rgba(247, 179, 43, 0.045), transparent 55%),    /* top-left amber lamp-glow */
    radial-gradient(900px 500px at 100% 100%, rgba(79, 209, 197, 0.030), transparent 55%),   /* bottom-right cyan compass */
    var(--color-bg);
  background-attachment: fixed;
}
```

**Layer 2 — Grain (pseudo-element on `<body>`):**
```css
body::before {
  content: "";
  position: fixed; inset: 0; z-index: 0;
  pointer-events: none;
  background-image: url("/public/noise-small.png");      /* 160×160 tileable PNG, ~2kB, opacity baked at 3% */
  background-size: 160px 160px;
  mix-blend-mode: overlay;
  opacity: 0.55;
  /* This gives a very subtle film-grain feel. */
}
```

**Layer 3 — Vignette (pseudo-element on `.app-shell`):**
```css
.app-shell::after {
  content: "";
  position: fixed; inset: 0; z-index: 0;
  pointer-events: none;
  background: radial-gradient(120% 85% at 50% 50%, transparent 55%, var(--color-vignette) 100%);
}
```

**Optional: scan-lines behind the dock scope only** (1px horizontal lines @ 3px interval, opacity 0.04). Off by default; toggled on via a user preference in Theme tab for a "full instrument" look.

Map canvas overrides these — map shows its tiles clean. Light theme keeps the gradients but tuned down to 2% opacity.

---

## 11. Accessibility Checklist

- **Contrast:** body `ECE6D6 / 0A0F14` = 15.9:1 (AAA). Accent amber text on dark = 10.2:1 (AAA). Chip states all cleared AA at minimum; status chips in dark-mode soft backgrounds all ≥4.7:1. Light theme amber ink on cream = 6.2:1 (AA large, AA body).
- **Focus:** every interactive element has `:focus-visible` using `--shadow-focus-ring-accent` (3px amber ring, 38% alpha). Danger-focused elements use `--shadow-focus-ring-danger`. No `outline: none` without a replacement ring.
- **Keyboard:** full tab order through header → main → dock. Settings sheet tab-traps while open. Command palette reachable via `⌘K` / `Ctrl+K`. Transcript lines are individually focusable.
- **Semantic HTML:** preserve existing `<header>`, `<main>`, `<nav>`, `<section>`, `<aside>`. Add `role="application"` only on the map canvas (already present).
- **aria-live:** voice dock status pill is `aria-live="polite"`. Error banner is `role="alert"`. Transcript container is `aria-live="polite"`. Map tile-error is `role="alert"`.
- **Reduced motion:** honoured at token level (`--dur-* = 0`) plus explicit `animation: none` on beacon, sweep, pulse, and pin rings.
- **Touch targets:** minimum 44×44 on mobile for all interactive elements. Buttons grow from 40→44px at ≤640px.
- **Skip-link:** unchanged — slides in on focus.
- **Forms:** floating labels retain `<label for>` associations; `aria-invalid` + `aria-describedby` for error copy.
- **Transcript:** user/agent/system/tool lines carry distinct visual AND textual tags so screen readers announce sender explicitly.
- **Color blindness:** never use color alone — every status chip has a leading dot and text label; every pin has a shape variation (carrier = square, load = round, delayed = breathing).
- **Text zoom 200%:** page layouts verified to reflow without horizontal scroll; dock collapses gracefully.
- **Language:** `lang="en"` on `<html>` (already present).

---

## 12. Inspirations (Real Products — Specific Patterns to Borrow)

- **Teenage Engineering OP-1 Field / TX-6** — the UI's *instrument* language: tight condensed labels, brass-ringed circular controls, tactile panel feel. Informs the rate-readout dial and the dock scope.
- **Braun T1000 World Receiver / Dieter Rams control panels** — horizontal registers, all-caps micro-labels, ruled dividers. Informs the ledger-ruled convo log and transcript.
- **Linear's command-K palette** — the overlay pattern, monospace kbd chips, hover row tint. We keep it.
- **Vercel's deploy log / Railway dashboard** — the subtle radial gradients pulling the eye toward active content.
- **Figma right panel** — the right-docked settings sheet inside the voice dock, NOT a modal.
- **Arc's sidebar / Raycast Pro** — the pill-shaped filter chips, the way active states darken *and* get a copper rule beneath.
- **Tesla cluster / Porsche Taycan HMI** — the transmit/receive color duality (amber/cyan) and the radar sweep in the scope.
- **NYC subway map (Vignelli) / SBB timetable** — the row-status-rail technique on the dispatch table; numeric discipline.
- **Stripe dashboard** — the numeric-first summary card pattern (big Fraunces value, tiny label, delta chip).
- **Radar PPI scopes** — literal reference for the "listening" viz.
- **Tailscale admin console** — the persistent top-right status pill pattern with a dot + state label.
- **Notion's dot-timeline for comments** — informs the callback list.
- **Apple Music's bottom-sheet player on iOS** — handle, snap points, backdrop scrim. Direct inspiration for the mobile dock sheet.
- **Grafana panel borders + inset hairlines** — informs panel styling.

---

## 13. Anti-Patterns for THIS Project

**Typography anti-patterns:**
- Do NOT fall back to Inter, Space Grotesk, Manrope, DM Sans, Poppins, or any "default Figma" sans. If Schibsted Grotesk fails to load, `Helvetica Neue` is the only acceptable fallback.
- Do NOT use a display serif for body copy — Fraunces is for titles, amounts, and the voice dock empty-state only.
- Do NOT mix more than three families. No decorative script, no all-caps display, no pixel/terminal font.

**Color anti-patterns:**
- No purple-to-pink gradients on white.
- No indigo-accent-on-dark look (Linear/Vercel default). We rejected that substrate.
- No rainbow status system: amber + cyan + semantic (warn/danger/success) only.
- No glassmorphism-everywhere. The overlay-bg tokens are used sparingly on captions, popups, and attribution — never on main panels.
- No neumorphism (double-shadow push-in buttons).
- No neon glow on everything. Amber halo is only on the dock and the primary button.

**Layout anti-patterns:**
- Do NOT ship a bento grid as the whole page. Summary cards are a row, not a theme.
- Do NOT add a hero carousel. This is a dispatch console, not a landing page.
- Do NOT add testimonials or "trusted by" logos. Wrong context.
- Do NOT introduce a framework or CSS library to ship this (oracle sign-off required per CLAUDE.md). Pure CSS + tokens.

**Voice dock anti-patterns:**
- Do NOT model the dock on a generic chat bubble widget (Intercom-style). This is an instrument panel, not a support widget.
- Do NOT use a sine-wave line visualiser — cliché. The radar sweep is the distinctive pattern.
- Do NOT stack settings below the transcript. Settings is an overlay on top of the dock body, not a sibling.
- Do NOT auto-open settings on first load. The call button is the single primary CTA.

**Motion anti-patterns:**
- No looping attention-grabbers beyond the beacon dot and state-pill pulse.
- No bouncy springs on page-level transitions. Springs are only on the dock and on state changes.
- No parallax scrolling.
- Do NOT exceed 820ms total first-paint orchestration.

**Data anti-patterns:**
- No skeleton loaders that shimmer across a whole panel — use the radial-pulse pattern already in map.css.
- No empty states with illustrations — use a small scope rose glyph + one line of Fraunces italic.

---

## Implementation notes for the three frontend-devs

- Token file rename: keep `css/tokens.css` but add a comment block `/* Harbor Bridge — Fraunces + Schibsted Grotesk + Commit Mono, amber/cyan on indigo-ink */`.
- Migrate existing `--color-accent: #6EE7B7` → `#F7B32B`. Every component that references `--color-accent` will inherit the new amber automatically. Audit for places where green was semantic (success state) — those move to `--color-success`.
- **Breaking:** `--radius-md: 8px → 14px` and `--radius-lg: 12px → 20px`. Visually audit cards for any hardcoded corner masks.
- **Font loading:** add preload in `index.html`, update `font-feature-settings` in `css/base.css`.
- The dock markup in `js/ui.js:36-196` needs a modest structural refactor to add the scope panel and reorganise controls into the four tabbed sections. Voice-agent state subscription stays identical — only presentation changes.
- Map.css tile filter added to `#map-canvas .leaflet-tile`.
- New asset required: `public/noise-small.png` (160×160, tileable, ~2kB).
- New CSS file recommended: `css/atmosphere.css` for body gradients + noise + vignette, kept separate from tokens.

---

# Concise summary (under 180 words)

**Concept:** "**Harbor Bridge**" — a ship's-bridge/rail-timetable instrument aesthetic crossed with Material 3 Expressive springs. Think Teenage Engineering OP-1 plus Braun T1000 plus a marine radar scope.

**Accents:** **Amber `#F7B32B`** (primary — brass lamp on chart paper, transmit signal) paired with **Cyan `#4FD1C5`** (receive / listening). Replaces the current call-center green.

**Typography pairing:** **Fraunces** (display serif with SOFT 30 / WONK 1 axes) + **Schibsted Grotesk** (UI sans — newspaper-ledger texture) + **Commit Mono** (instrument/numeric). Zero use of Inter, JetBrains Mono, Space Grotesk, or any banned face.

**Biggest departure from current:** the voice dock transforms from a Linear-style bottom-right panel into a full instrument surface with a **radar-sweep "Scope" audio visualizer**, a true mobile bottom-sheet with snap points, and tabbed settings inside the dock. Secondary: rows on the dispatch table gain a 2px color rail (no row fills), the accent flips from green to amber, and the page titles adopt Fraunces display serif with a 96px copper underline rule.

**Spec path:** the full specification is above in this message. No files were written per the agent's "do not write .md files" directive — parent agent can consume the spec directly or persist it manually to `specs/frontend-overhaul-design.md`.

**Files read:**
- C:\Users\dhruvmishra\Desktop\LiveAgentNavigationWebsite\DESIGN.md
- C:\Users\dhruvmishra\Desktop\LiveAgentNavigationWebsite\css\tokens.css
- C:\Users\dhruvmishra\Desktop\LiveAgentNavigationWebsite\css\base.css
- C:\Users\dhruvmishra\Desktop\LiveAgentNavigationWebsite\css\components.css
- C:\Users\dhruvmishra\Desktop\LiveAgentNavigationWebsite\css\voice-dock.css
- C:\Users\dhruvmishra\Desktop\LiveAgentNavigationWebsite\css\pages.css
- C:\Users\dhruvmishra\Desktop\LiveAgentNavigationWebsite\css\map.css
- C:\Users\dhruvmishra\Desktop\LiveAgentNavigationWebsite\index.html
- C:\Users\dhruvmishra\Desktop\LiveAgentNavigationWebsite\partials\dispatch.html
- C:\Users\dhruvmishra\Desktop\LiveAgentNavigationWebsite\partials\carriers.html
- C:\Users\dhruvmishra\Desktop\LiveAgentNavigationWebsite\partials\negotiate.html
- C:\Users\dhruvmishra\Desktop\LiveAgentNavigationWebsite\partials\contact.html
- C:\Users\dhruvmishra\Desktop\LiveAgentNavigationWebsite\partials\map.html
- C:\Users\dhruvmishra\Desktop\LiveAgentNavigationWebsite\js\ui.js (first 200 lines)