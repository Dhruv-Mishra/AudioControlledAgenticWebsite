# Architecture v2 Delta — Dhruv FreightOps

Appends to `specs/frontend-overhaul-architecture.md`. The v1 plan stays authoritative for the agent-DOM integration contract. Only the dock state-machine defaults and a few guard-rails change.

## 1. Dock state-machine contract (NEW)

**Mount default.** `#voice-dock` ships with `.is-collapsed` applied in `buildDockMarkup()` for ALL viewports (v1 applied it only when `matches('(max-width: 640px)')` inside `bootstrapVoiceShell`). `aria-expanded="false"` on `#voice-dock-toggle` at template time (was `"true"`).

**Header-row ownership of `#voice-call-btn`.** The call button moves from `.voice-dock-action` (footer — hidden when collapsed) into `.voice-dock-header` (always visible). The header row carries: state dot, brand label, `#voice-status-pill`, `#voice-live-chip`, `#voice-muted-chip`, `#voice-ambient-chip`, `#voice-mic`, `#voice-settings`, `#voice-dock-toggle`.

**`.is-collapsed` visibility rules (CSS contract Dev B must ship):**
- Hides: `#voice-transcript`, `#voice-status-strip` visualiser subtree, `#voice-error`, `.voice-dock-action`, `#voice-settings-sheet`, `#jarvis-chips`.
- Shows: `.voice-dock-header` and every child named above, including `#voice-call-btn`.

**Toggle semantics.** `#voice-dock-toggle` is the ONLY affordance that flips `.is-collapsed`. `aria-expanded` mirrors inverse. Existing handler flow unchanged — only the default state changes.

**Call-button semantics.** `#voice-call-btn` click triggers the call and only the call. MUST NOT call `dock.classList.remove('is-collapsed')` or touch toggle state. Dock stays minimised through the entire call lifecycle (`idle` → `cancel/dialing` → `end/live_ready` → `closing`).

## 2. Latency-pass files — awareness only

Files in flight with ai-engineer: `api/live-bridge.js`, `js/voice-agent.js`, `js/audio-pipeline.js`, `api/tools.js`, `js/tool-registry.js`. All remain Bucket C for Dev A/B/C.

Coordination:
- **Eager WS open:** `bootstrapVoiceShell` must continue to run `new VoiceAgent({ transcriptEl })` synchronously after dock mount. Dev B must not add `await` or microtask gate between `document.body.appendChild(dock)` and the agent constructor.
- **DOM snapshot:** `tool-registry.findByAgentId` still resolves via `[data-agent-id=...]`. Dev C's restyle is neutral.
- **Session resumption:** `[data-call-state="reconnect"]` is already enumerated; Dev B template covers it.

## 3. Preserved from v1 architecture (unchanged)

- Every `data-agent-id` in v1 §1
- Every `#id` JS queries in v1 §2
- Every form `name=`, `for=`, input `type=`, `autocomplete=`
- Every `role="dialog"`, `aria-live`, `aria-modal`, `aria-hidden`, `aria-expanded`, `aria-pressed`
- Five `data-call-state` values + matching `call-btn--*` classes
- `[data-state]` variants on pill/strip/dock
- Five `<span class="bar">` children inside `#voice-status-strip > .voice-vu`
- File ownership (Dev A / Dev B / Dev C)
- MutationObserver debounce (ui.js)

## 4. Risky edges for v2

1. **Relocation breaks compound selectors.** Grep: `rg "voice-dock-body.*voice-call-btn|voice-dock-action.*voice-call-btn" js/` — expect zero hits.
2. **Orphaned v1 canvas/compass code.** Delete compass SVG emitter AND matching rAF loop in `ui.js` in one PR. `wireVuMeter`'s `if (!bars.length) return` guard means any lingering VU call is safe.
3. **Quick-chips mount under `display:none`.** `.voice-dock-body` stays in the DOM, hidden in collapsed state. `quick-chips.js`'s `ensureMount()` has no visibility precondition. Reviewer must NOT accept implementations that remove `.voice-dock-body`.
4. **Activity indicator mount.** Same story — `.voice-dock-action` stays in DOM, hidden when collapsed.
5. **Transcript scroll anchoring.** `#voice-transcript` `display:none` at first paint. When user expands mid-call, scroll-to-bottom logic fires independent of collapsed state.
6. **Reduced motion + morph.** Container morph (height 60 ↔ target, radius full ↔ xl) must be guarded behind `@media (prefers-reduced-motion: reduce) { .voice-dock, .voice-dock * { transition: none !important; } }`.

## 5. Verification snippets (paste in browser console)

```js
// 5.1 Minimised-first contract
console.assert(document.getElementById('voice-dock').classList.contains('is-collapsed'), 'dock should default collapsed');
console.assert(!!document.getElementById('voice-call-btn'), 'call-btn present');
console.assert(getComputedStyle(document.getElementById('voice-call-btn')).display !== 'none', 'call-btn visible while collapsed');
console.assert(document.getElementById('voice-dock-toggle').getAttribute('aria-expanded') === 'false', 'toggle aria-expanded mirrors collapsed');

// 5.2 Call button does NOT expand
const dock = document.getElementById('voice-dock');
dock.classList.add('is-collapsed');
document.getElementById('voice-call-btn').click();
requestAnimationFrame(() => {
  console.assert(dock.classList.contains('is-collapsed'), 'call-btn click must not expand dock');
});

// 5.3 Expand caret DOES expand
document.getElementById('voice-dock-toggle').click();
console.assert(!dock.classList.contains('is-collapsed'), 'toggle click expands dock');
console.assert(document.getElementById('voice-dock-toggle').getAttribute('aria-expanded') === 'true', 'aria-expanded flips');

// 5.4 Visualiser contract
console.assert(document.querySelectorAll('#voice-status-strip .voice-vu .bar').length === 5, '5 VU bars required for wireVuMeter');

// 5.5 Agent-id spot-check
const requiredDockIds = ['voice.call_btn','voice.settings','voice.dock.collapse','voice.mic','voice.clear_transcript'];
const missing = requiredDockIds.filter(x => !document.querySelector('[data-agent-id="' + x + '"]'));
console.assert(missing.length === 0, 'missing dock agent-ids: ' + missing.join(','));

// 5.6 Call-button never hidden by .is-collapsed
dock.classList.add('is-collapsed');
console.assert(document.getElementById('voice-call-btn').offsetParent !== null, 'call-btn must be visible in collapsed state');
```

## 6. Implementation notes for Dev B

- `js/ui.js:929-939` — replace mobile-only `isMobile` branch with unconditional `dock.classList.add('is-collapsed')`. Set `aria-expanded="false"` in template string.
- `js/ui.js:157-189` — lift `#voice-call-btn` from `.voice-dock-action` into `.voice-dock-header`. Rest of action footer stays where it is, hidden by `.is-collapsed`.
- Delete lines 106-146 (compass SVG) AND the `wireVuMeter`/canvas rAF loop at ~571-791. Keep `wireVuMeter` function shell driving the 5 bars only.
- `css/voice-dock.css` — add `.voice-dock.is-collapsed .voice-dock-body { display: none; }`, same for `.voice-dock-action`, `#voice-settings-sheet`, `#voice-error`, `#voice-status-strip`.
- Do NOT add `await` between `document.body.appendChild(dock)` and `new VoiceAgent(...)` — ai-engineer's eager-WS depends on sync constructor.
