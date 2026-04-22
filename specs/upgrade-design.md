# Upgrade Design Spec

Designer-approved visual spec for the `live-agent-upgrade` team. Derived from
`specs/upgrade-oracle-decisions.md` + status shared with team-lead. All visual
values MUST come from `css/tokens.css`. No hardcoded hex, radius, or spacing
values in component styles. Written 2026-04-22.

## 0. Scope summary

1. Header chip `#header-model` is **removed** entirely. The Gemini model ID
   should not be visible in the UI.
2. Transcript display is **off by default**. A new tri-state toggle (Off /
   Captions / Full) lives only in the voice settings sheet. Server flag
   `showText === false` overrides to Off and disables the control.
3. New **captions overlay** renders bottom-center above the voice dock when
   the tri-state is set to Captions. Auto-fades 3 s after `turn_complete`.
4. Six new agent-controlled features (palette, activity indicator, quick chips,
   filter tools, theme toggle, captions) with strict token discipline.

## 1. New tokens (additive only)

Append to `css/tokens.css` under `:root`. Do NOT change existing values.

```
--color-overlay-bg       : rgba(17, 21, 26, 0.92);  /* elev-1 at 92% */
--color-overlay-scrim    : rgba(0, 0, 0, 0.55);
--color-spotlight-mask   : rgba(0, 0, 0, 0.70);

--z-skip-link            : 1000;
--z-header               : 100;
--z-dock                 : 200;
--z-captions             : 250;
--z-overlay              : 500;

--shadow-overlay-strong  : 0 20px 56px -12px rgba(0,0,0,0.60),
                           0 4px 10px rgba(0,0,0,0.35);
```

Ensure `[data-theme="light"]` overrides exist for `--color-overlay-bg` in the
light block (already-existing tokens handle the rest).

## 2. Header changes

Remove `#header-model` span and the `fetch('/api/config').then(...)` that
populates it. The nav retains brand + nav links + the "Voice" button.

## 3. Transcript display tri-state

Lives in the settings sheet. New control row:

```
┌─ Transcript ───────────────────────────────┐
│  [ Off ]  [ Captions ]  [ Full ]            │
│  Tiny muted helper text (optional).         │
└─────────────────────────────────────────────┘
```

Markup (conceptual):

```html
<div class="voice-control-row" role="radiogroup" aria-label="Transcript mode">
  <span class="voice-control-label">Transcript</span>
  <div class="segmented transcript-seg" id="voice-transcript-seg"
       data-agent-id="transcript.mode_seg">
    <button role="radio" type="button" data-mode="off"
            data-agent-id="transcript.mode.off" aria-checked="true">Off</button>
    <button role="radio" type="button" data-mode="captions"
            data-agent-id="transcript.mode.captions" aria-checked="false">Captions</button>
    <button role="radio" type="button" data-mode="full"
            data-agent-id="transcript.mode.full" aria-checked="false">Full</button>
  </div>
</div>
<p class="voice-settings-note" id="voice-transcript-note"></p>
```

- Storage: `localStorage['jarvis.ui.transcriptMode']`, default `'off'`.
- Server `showText === false` → forces `'off'`, disables all three buttons,
  shows note "Transcripts disabled by server config".
- State sync: applied on first paint (no flash) and on `flags-ready`.

### Visual behaviour per mode

- **off** → transcript panel hidden; captions overlay hidden.
- **captions** → transcript panel hidden; captions overlay visible.
- **full** → transcript panel visible; captions overlay hidden.

## 4. Captions overlay

```
.voice-captions {
  position: fixed;
  left: 50%;
  bottom: calc(var(--sp-7) + env(safe-area-inset-bottom, 0px));
  transform: translateX(-50%);
  max-width: min(520px, calc(100vw - var(--sp-4)));
  padding: var(--sp-2) var(--sp-4);
  background: var(--color-overlay-bg);
  color: var(--color-text);
  font-size: var(--fs-sm);
  font-weight: var(--fw-medium);
  line-height: var(--lh-sm);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-overlay-strong);
  z-index: var(--z-captions);
  pointer-events: none;
  text-align: center;
  opacity: 0;
  transition: opacity var(--dur-base) var(--ease-out-expo);
}
.voice-captions.is-visible { opacity: 1; }
```

- ARIA: `role="status"` + `aria-live="polite"`.
- Auto-fade 3 s after `turn_complete` (set `is-visible` off).
- Mobile: bottom anchored above the docked call bar — viewport-clamped.
- Show only the **last 1–2 lines** of agent speech. No user side.
- `prefers-reduced-motion: reduce` disables the fade; use instant show/hide.

## 5. Command palette

- 560 px wide centered modal on desktop (≥ 641 px).
- Full-height bottom sheet on mobile (≤ 640 px).
- Backdrop: `var(--color-overlay-scrim)`.
- Surface: `var(--color-bg-elev-3)`, `var(--radius-lg)`, `var(--shadow-overlay-strong)`.
- Input: 44 px tall, `var(--color-bg-elev-1)`, no border, 1 px bottom hairline
  `var(--color-border)`.
- Results list: 36 px row height, hover `var(--color-bg-elev-2)`, selected
  `var(--color-accent-soft)` with `var(--color-accent)` text.
- Section headers: `var(--fs-xs)` all-caps, `var(--color-text-muted)`.
- Z-index `var(--z-overlay)`.
- ARIA: `role="dialog"`, `aria-modal="true"`, labelled by its own heading.
- Live region announces result count.

## 6. Agent activity indicator

- Mount inside `.voice-dock-action`, above the call button.
- Height: 28 px when active, 0 px when idle (transitions via `max-height`
  so there is no layout pop).
- Text: `var(--fs-sm)` `var(--fw-medium)` `var(--color-text-muted)`.
- On text change, flash a subtle `var(--color-accent)` dot (4×4 px) inline.
- `aria-live="polite"`; `role="status"`.
- Truncate at 80 chars with an ellipsis.

## 7. Quick-action chips

- Mount ABOVE the transcript panel OR above the captions overlay, depending
  on the transcript mode.
- Horizontal flex row, wrap cleanly. Max 5 visible; overflow elided.
- Each chip reuses the standard `.chip` styling with `chip--neutral` as base
  and hover → `chip--ok` tint (accent text on accent-soft bg).
- Height 28 px, padding `0 var(--sp-3)`, `var(--radius-pill)`,
  `var(--fs-xs)` `var(--fw-medium)`, `var(--tracking-wide)`.
- Focus ring: `var(--shadow-focus-ring-accent)`.

## 8. Theme toggle

- 3-way segmented (Dark / Light / System) in settings sheet.
- Data-agent-id: `theme.toggle` on the container, `theme.dark`, `theme.light`,
  `theme.system` on each button.
- Inline bootstrap script in `<head>` BEFORE CSS to prevent FOUC (Oracle
  decision 3).

## 9. Skip link + z-index

- `.skip-link` bumped to `var(--z-skip-link)` (above header).
- Header z-index normalised to `var(--z-header)`.
- Dock z-index normalised to `var(--z-dock)`.
- Captions z-index `var(--z-captions)` (above dock, below overlays).

## 10. Accessibility bar

- Every new interactive element has a visible `:focus-visible` ring using
  `var(--shadow-focus-ring-accent)`.
- All overlays respect Escape-to-close, keyboard-only flows, and
  `prefers-reduced-motion: reduce` (no animations, no fades — instant state
  changes).
- Dynamic regions use `aria-live="polite"` (captions, activity, palette).
- Screen readers announce state changes on tri-state toggle and theme toggle.

## 11. Token-only contract

No hardcoded hex anywhere. All colors, spacing, radii, shadows, and z-indexes
flow through the tokens defined in `css/tokens.css`. The added tokens above
are the only allowed additions.
