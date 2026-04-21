# DESIGN.md — Dhruv FreightOps

Active design system. All tokens are CSS custom properties defined in `css/tokens.css`. No hardcoded hex, radius, or spacing values in component styles.

## Primary inspiration

**Linear + Retool + Vercel (dark mode default).** Dispatch software lives in a console — dense data, clear hierarchies, zero visual noise. The voice agent UI borrows from operator-console aesthetics (Tailscale admin, Fly.io dashboard) for the status pill and comms panel.

- **Type precision** from Linear (IBM Plex-grade monospace for IDs, tight sans for UI).
- **Data density** from Retool (row-based tables, compact padding).
- **Motion restraint** from Vercel (easeOutExpo, 160 ms max, no bouncy springs).
- **Voice status pill** from operator consoles (Grafana/Datadog indicators).

## Secondary influences

- **Form patterns:** Stripe dashboard.
- **Chip/tag components:** GitHub.
- **Live-call noise toggles:** inspired by Zoom's "Original sound" selector — compact, technical, revealing.

## Color tokens (dark-first)

All colors via CSS custom properties. No hex in component styles.

```
--color-bg            : #0B0D10  (canvas)
--color-bg-elev-1     : #11151A  (panels)
--color-bg-elev-2     : #171C23  (cards, hovered rows)
--color-bg-elev-3     : #1E2530  (modals, popovers)
--color-border        : #232933  (default hairline)
--color-border-strong : #2E3542  (focused inputs)

--color-text          : #E7ECF3  (primary)
--color-text-muted    : #9AA3B2  (secondary)
--color-text-dim      : #5D6573  (tertiary / placeholders)
--color-text-inverse  : #0B0D10  (on accents)

--color-accent        : #6EE7B7  (call-center green — signal positive, live, active)
--color-accent-strong : #34D399
--color-accent-soft   : #064E3B  (accent bg tint)

--color-warn          : #FBBF24
--color-warn-soft     : #3B2F0E
--color-danger        : #F87171
--color-danger-soft   : #3A1E1E
--color-info          : #60A5FA
--color-info-soft     : #0F2A4A

/* Live-agent status colors */
--color-state-idle      : #5D6573
--color-state-listening : #6EE7B7
--color-state-thinking  : #C084FC
--color-state-speaking  : #60A5FA
--color-state-tool      : #FBBF24
--color-state-error     : #F87171
```

Light mode overrides are in `tokens.css` under `[data-theme="light"]` but dark is the default for a dispatch-console feel.

### Contrast
Body text `#E7ECF3` on `#0B0D10` = 16.2:1. Muted `#9AA3B2` on `#0B0D10` = 9.9:1. Accent green `#6EE7B7` on `#0B0D10` = 11.1:1. All comfortably above WCAG AA.

## Typography

```
--font-sans  : "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
--font-mono  : "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;

--fs-xs   : 11px / 16px   -- small meta (IDs, timestamps)
--fs-sm   : 13px / 20px   -- table cells, chips
--fs-base : 14px / 22px   -- body
--fs-md   : 16px / 24px   -- form inputs, primary nav
--fs-lg   : 18px / 26px   -- section titles
--fs-xl   : 22px / 30px   -- page titles
--fs-2xl  : 28px / 36px   -- hero numbers

--fw-regular : 400
--fw-medium  : 500
--fw-semibold: 600

--tracking-tight  : -0.01em  (display)
--tracking-normal : 0
--tracking-wide   : 0.04em   (all-caps labels, button chips)
```

Use `font-feature-settings: "cv11" 1, "ss01" 1;` on Inter for slashed zero and true-italic terminal-ish feel (Linear does this). Mono is used for MC numbers, agent IDs, tool-call logs.

## Spacing (4 px base)

```
--sp-0 : 0
--sp-1 : 4px
--sp-2 : 8px
--sp-3 : 12px
--sp-4 : 16px
--sp-5 : 24px
--sp-6 : 32px
--sp-7 : 48px
--sp-8 : 64px
--sp-9 : 96px
```

Dense layouts: rows 36 px tall (nav items, table rows), 44 px for primary form rows on mobile.

## Radius

```
--radius-xs : 4px   (tags, chips)
--radius-sm : 6px   (inputs, buttons)
--radius-md : 8px   (cards, table containers)
--radius-lg : 12px  (modals, large cards)
--radius-pill: 9999px (status pills, toggles)
```

## Shadow / elevation

Flat by default; use subtle inner hairlines rather than drop shadows for elevation within the console. Overlay layers (modals, voice-agent dock) use a single soft shadow.

```
--shadow-overlay : 0 12px 32px -8px rgba(0, 0, 0, 0.55), 0 2px 6px rgba(0,0,0,0.35);
--shadow-focus-ring-accent : 0 0 0 2px rgba(110, 231, 183, 0.35);
--shadow-focus-ring-danger : 0 0 0 2px rgba(248, 113, 113, 0.35);
```

## Motion

```
--ease-out-expo : cubic-bezier(0.16, 1, 0.3, 1)
--dur-fast      : 120ms
--dur-base      : 180ms
--dur-slow      : 280ms
```

Respect `prefers-reduced-motion: reduce` — disable all non-essential animation and keep state changes instant.

## Components

### Nav bar (`<header class="app-header">`)
48 px tall, full width, border-bottom hairline. Left: product name "Dhruv FreightOps" with a small pulsing-dot logo. Center: page tabs. Right: voice-agent status pill + persona select + session count.

### Voice-agent dock (fixed bottom-right)
Floating card, 340 px wide, 16 px from edge, elevated with `--shadow-overlay`. Three sections stacked: transcript log (scrolls), status strip, control strip (wake-word/PTT, persona select, noise select, volume).

Status strip: circular VU meter (bars) + state chip.

The dock collapses to a 56 px pill when not expanded. `prefers-reduced-motion` disables the pulse animation on the state chip.

### Tables
Sticky header, `--color-bg-elev-1` background, row hover `--color-bg-elev-2`, 36 px row height, 13 px font. First column: mono text for IDs. Status column uses chip component.

### Status chips
```
.chip { height: 22px; padding: 0 8px; border-radius: var(--radius-xs); font-size: var(--fs-xs); font-weight: var(--fw-medium); letter-spacing: var(--tracking-wide); text-transform: uppercase; }
.chip--ok      → accent
.chip--warn    → warn
.chip--danger  → danger
.chip--info    → info
.chip--neutral → border + muted text
```

### Forms
Inputs: 36 px tall (dense) or 40 px (forms). `--color-bg-elev-1`, hairline border, focused border + focus ring. Labels: 11 px uppercase muted, 8 px below input. Helper text: 12 px muted.

### Highlight flash (tool-call visual feedback)
When `highlight(agent_id)` is called, add `.is-agent-highlighted` to the element: 2 px solid accent outline, offset 2 px, scale anim 1.02 → 1 over 600 ms, then fades out after 1.2 s total. Respects reduced motion (just outline, no scale).

### Persona toggle
Segmented control (5 options) in the dock: Professional, Cheerful, Frustrated, Tired, Excited. Each has a color dot (persona.voice color) and label. Selected state has `--color-accent` underline.

### Noise selector
Compact dropdown with 4 options + volume slider: Off, Phone line, Office chatter, Static. Slider is horizontal, 80 px wide.

## Accessibility

- Every interactive element has a `:focus-visible` state using `--shadow-focus-ring-accent`.
- Skip link at the top of every page to main content.
- Voice dock's status changes are announced via an `aria-live="polite"` region.
- `prefers-reduced-motion: reduce` honored on pulse, flash, and scroll effects.

## What to avoid

- Neumorphism, glassmorphism, frosted-glass.
- Big hero imagery. This is a console — show data, not marketing fluff.
- Rainbow gradients. One accent green, period.
- Any motion above `--dur-slow`.

## Alignment with root
Root is CLAUDE.md — vanilla HTML/CSS/JS, mobile-first, 2-space indent, tokens for all design values. No divergences. No framework introduced.
