# Upgrade Oracle Decisions

Three decisions for the `live-agent-upgrade` team. Written 2026-04-22.

Context: Web Speech API STT is broken (stutter, drop-off, Firefox/iOS gaps). The user wants on-device STT without enabling Gemini `inputAudioTranscription`, transcript-off-by-default with a toggle, more agent-controlled features, the model-name chip hidden, and the whole flow performant.

---

## Decision 1: On-device STT replacement

### Recommendation

Replace `js/local-stt.js`'s Web Speech API wrapper with **Whisper `tiny.en` via `@xenova/transformers` running in a dedicated Web Worker**, WebGPU-accelerated where available, WASM fallback where not. ~40 MB int8-quantized weights, loaded lazily on the first `placeCall`, cached by transformers.js default in the browser's Cache Storage. Web Speech is kept only as a narrow fallback.

### Rationale

- **Direct fit for the existing pipeline.** `js/audio-worklets/pcm-capture.js:65` already emits 16 kHz Int16 PCM frames — that is exactly Whisper's input format. No resample, no format translation. The worker just accumulates the Int16 into a 30 s ring buffer and runs inference.
- **Streaming-friendly.** Whisper tiny is fast enough on modern hardware (p50 ~250 ms per 5 s chunk on M2/WebGPU, ~800 ms on desktop WASM) that 1.5 s partial-emission is feasible with a 30 s window / 10 s hop.
- **Privacy preserved.** All audio stays in-browser. Matches the user's explicit constraint: "WITHOUT enabling it on the API."
- **Cross-browser reach.** WebGPU is in Chrome/Edge stable; transformers.js falls back to WASM on Firefox + Safari 17, which covers everyone the current app targets (`scripts/build.js:53` sets targets chrome110/firefox115/safari17/edge110). Web Speech gaps on Firefox + iOS disappear.
- **Library, not framework.** `@xenova/transformers` is a runtime library — no compile step, no DSL, no render model. Fits CLAUDE.md's "no framework without Oracle sign-off" bar. I am signing off.
- **Proven.** Thousands of deployments, active maintenance, auto model caching.

### Rejected alternatives

- **(B) Moonshine via transformers.js or onnxruntime-web.** Newer model, attractive for streaming, but the JS runtime story is still thin (bugs, thin docs). Re-evaluate in 6 months.
- **(C) whisper.cpp → WASM vendored.** Full control + no npm dep, but: hand-writing the JS bindings, managing worker-side memory, and shipping our own `.wasm` asset is ~2 weeks of integration versus ~2 days for transformers.js. Not worth it.
- **(D) Just fix Web Speech** (dedup, VAD-gate, 15 s sessions). Would patch the repeat-phrase bug, but the underlying accuracy ceiling stays low, Firefox stays empty, iOS Safari stays broken, and Chrome's auto-cutoff quirks remain. Treats the symptom.
- **(E) Hybrid (D)-default + opt-in (A).** A clever idea, but most users never discover opt-in features; shipping two STT systems also doubles the bug surface. Commit to Whisper as primary and keep Web Speech only as a narrow degraded fallback.

### Implementation notes

**File layout.**

- `js/stt-worker.js` — ESM Web Worker. Imports `@xenova/transformers` at the top. Dynamic-`import()`-ed from `js/voice-agent.js` on the FIRST `placeCall` only. esbuild code-splits it into its own chunk (`scripts/build.js` already has `splitting: true`).
- `js/stt-controller.js` — main-thread driver. Owns the worker instance, exposes an EventTarget API matching `LocalStt` (so `voice-agent.js:_initLocalStt` can drop it in with minimal change). Forwards PCM frames from `AudioPipeline` via `postMessage({type:'audio', pcm}, [pcm.buffer])` (transferable, zero-copy).
- `js/local-stt.js` — keep, but repurpose. Becomes the Web-Speech fallback ONLY. `stt-controller.js` picks the right backend at runtime based on capability/opt-in state.

**Worker contract (freeze this; frontend-dev and AI-engineer share it):**

- Messages IN:
  - `{type:'init', useWebGPU: boolean}` → boot transformers.js, load model, emit progress.
  - `{type:'audio', pcm: Int16Array, seq: number}` (transferable) — append to ring.
  - `{type:'flush'}` — force final emission for the current segment.
  - `{type:'reset'}` — clear ring + segment state (called on `endCall`).
- Messages OUT:
  - `{type:'progress', loaded, total}` while downloading.
  - `{type:'ready'}` once the model is loaded.
  - `{type:'partial', text, segmentId}` during a segment, ~every 1.5 s.
  - `{type:'final', text, segmentId}` on VAD endpoint or `flush`.
  - `{type:'error', code, message}` on non-recoverable errors.
- Dedup contract: final `text` REPLACES the partials for the same `segmentId`. Never emit a substring of a previously-finaled segment. The controller maintains a `lastFinalByHash` set to drop literal duplicates across segments.
- Buffer: 30 s rolling ring (480,000 Int16 samples = 960 KB), 10 s hop.
- VAD-gated: main thread reads `AudioPipeline` mic level; does NOT send audio to the worker during silence windows (>400 ms RMS < threshold). Cuts p95 ~40 % on typical dispatcher speech patterns.

**Boot policy.**

- Worker is NOT instantiated on page load. First `placeCall` instantiates it.
- Model download is gated: if `navigator.connection?.effectiveType === 'slow-2g'` or `navigator.connection?.saveData === true`, show a one-time confirm "Download 40 MB transcription model? You can skip and use the basic captioning." with choices Download / Skip. Persist in `localStorage['jarvis.stt.opted']`.
- Call proceeds WHILE the model downloads. During that window, show a "Preparing captions…" ghost row; when `ready` arrives, the captions start flowing in.
- Do NOT gate the Place Call button on model readiness. Ever. The call is the product; captions are the addon.

**Fallback tree (precedence, top wins):**

1. Whisper worker `ready` → use it.
2. Whisper worker loading (first ~2–4 s on subsequent calls — weights cached) → show "Preparing captions…" placeholder.
3. Whisper not available (no WebGPU AND no WASM OR user declined the download OR `saveData`) AND Web Speech supported → use Web Speech fallback.
4. Neither → leave user transcript empty, show `voice-transcript-hint`: "Transcription unavailable on this browser."

**Eval strategy.**

New `evals/stt-accuracy-smoke.js`:
- Feed 3 canned 16 kHz mono Int16 WAVs through the worker directly (no mic):
  - (a) clean dispatcher phrase: "Check the status on load LD-10824 and counter at eighteen fifty."
  - (b) same phrase + office chatter underlay at -18 dBFS.
  - (c) numbers-heavy: "MC one-two-three-four-five-six, rate twenty-two hundred, pickup oh-four-oh-five at fourteen-thirty."
- Assertions:
  - WER < 15 % on (a), < 25 % on (b).
  - Partial-order monotonicity: every `partial.text` for a segment is a prefix of every later `partial.text` for the same segment OR of the eventual `final.text`.
  - No phrase-repetition: no 4-gram occurs more than 2× in any single `final.text`.
  - p50 latency partial < 2.0 s, p95 final < 3.5 s from audio-end.

### What NOT to do

- Do NOT run ASR on the main thread. Whisper is CPU-heavy; this will jank the VU meter, the call button, everything.
- Do NOT re-implement model caching in IndexedDB. transformers.js does this in Cache Storage already — trust it.
- Do NOT gate the Place Call button on model readiness.
- Do NOT run Web Speech and Whisper in parallel. Pick one at session start (based on capability) and stick with it for the duration of the call. Switching mid-call is a rat's nest of double-transcripts.
- Do NOT send audio to the worker during VAD-silent gaps. Inference cost is linear in audio duration.
- Do NOT require a user account or server-side state. All of this stays client-local.

---

## Decision 2: New agent-controlled features

### Recommendation

Ship **6 features**. Ordered by dependency.

1. **Captions overlay** — bottom-center strip that shows the last 1–2 lines of agent speech, visible when the full transcript panel is off.
2. **Command palette** — `Ctrl/⌘+K` searchable action menu, agent-addressable.
3. **Agent activity indicator** — live status strip above the call button ("Comparing 3 carriers…"), agent-pushable.
4. **Quick-action chips** — 3–5 page-contextual one-tap chips, agent can override per turn.
5. **Smart filter tools** — `filter_loads`, `filter_carriers` with URL sync.
6. **Theme toggle** — light/dark/system, agent-controllable.

### Rationale

The user's brief was: "add more features which are also agent controlled." The chosen 6 share three properties:

- **Every one has a `data-agent-id`** → agent can click / highlight / read it via existing tools.
- **Every one either introduces a NEW tool the agent can call OR reuses existing DOM-manipulation tools** → no feature that's invisible to the agent.
- **Every one is dispatcher-useful**, not demo-glitz. A dispatcher on a call juggling 20 loads benefits from palette (jump anywhere), filter-loads (narrow the table), activity indicator (see what Jarvis is doing), captions (glance at what Jarvis said while still looking at the table), chips (one-tap common flows), theme (bright-room vs night-shift).

**Features skipped intentionally** — first-run tour (demo glitz), carrier compare pane (overlaps with filter + detail panel), global search (palette covers it), keyboard cheatsheet (put it in a tooltip), agent notes pinboard (needs server persistence), barge-in indicator (Gemini handles interrupts; a UI cue is hard to design without false positives), "repeat that" button (user can just say it).

### Rejected alternatives

- **Ship 10–12 features.** Would dilute polish and exceed the perf budget. 6 is the plateau.
- **Ship 2–3 features.** Doesn't meet the "add MORE features" brief — leaves the upgrade feeling thin.
- **Ship the compare/tour/cheatsheet trio.** Those are demo features. A dispatcher using the tool daily doesn't benefit from a tour after day 1, doesn't compare carriers pairwise (they filter + scan), and the cheatsheet is a tooltip away.

### Per-feature specs

**Feature 1 — Captions overlay**

- DOM anchor: `#jarvis-captions` with `data-agent-id="captions.overlay"`.
- Position: fixed, bottom 16 px, centered, max-width 520 px, z-index above page, below the voice dock.
- Style: dark flat card per DESIGN.md (no glassmorphism). `var(--color-bg-elev-3)`, `var(--color-border)`, `var(--radius-md)`, `var(--shadow-overlay)`, padding `var(--sp-3) var(--sp-4)`, `var(--fs-base)` body. Honours `prefers-reduced-motion` (instant appear/disappear, no fade).
- Content: last 1–2 lines of agent speech only (not user — too noisy). Auto-hides 3 s after `turn_complete`.
- Toggle: visible when transcript pref is `off` or `captions`. The user can also toggle just captions without a full transcript via the settings sheet.
- Tool signature (new): `set_captions({enabled: boolean})` — toggles captions visibility. Agent can call this e.g. "let me turn on captions for you."
- Dependency: STT worker (only matters if user-side captions ever get re-enabled; agent-side captions only need `transcript_delta` which Gemini provides regardless).
- Acceptance: line appears ≤ 200 ms after Gemini audio chunk starts; disappears 3 s after `turn_complete`; stays in-viewport on mobile (width clamps to `calc(100vw - var(--sp-4))`).

**Feature 2 — Command palette**

- DOM anchor: `#jarvis-palette` with `data-agent-id="palette.root"`. Input at `palette.input`, list at `palette.list`, each action as `palette.action.<action_id>`.
- Shortcut: `Ctrl+K` on Win/Linux, `⌘+K` on macOS. Esc closes. ↑↓ navigates. Enter runs.
- Action registry: `js/palette-actions.js` — export an array of `{id, label, keywords, handler, section}`. New actions added in one file.
- Initial action set: navigate-to-dispatch/carriers/negotiate/contact, clear-transcript, toggle-transcript-off/captions/full, toggle-theme, call-top-carrier (opens carriers + focuses first), filter-delayed-loads, end-call, mute.
- Style: centered modal, 520 px wide, 60 vh max, backdrop `rgba(0,0,0,0.55)`, `var(--shadow-overlay)`.
- Tool signatures (new):
  - `open_palette({query?: string})` → opens palette with input pre-filled.
  - `run_palette_action({action_id: string})` → runs the action directly without opening.
- Dependency: none.
- Acceptance: opens in < 50 ms, keyboard-only usable (no mouse needed), focus trap inside modal, ARIA `role="dialog"` `aria-modal="true"`.

**Feature 3 — Agent activity indicator**

- DOM anchor: `#jarvis-activity` with `data-agent-id="activity.status"`. Inside `.voice-dock-action`, above the call button.
- Height: 28 px when active, 0 px when idle (collapses). Text `var(--fs-sm)`, `var(--color-text-muted)`.
- Content: automatic notes derived from:
  - `tool_call` events → "Looking up <load_id>…" / "Comparing carriers…" (map tool names to human phrases).
  - `state === MODEL_THINKING` → "Thinking…" after 500 ms debounce.
  - `state === TOOL_EXECUTING` without a specific note → "Taking action…"
- Agent can override via new tool `set_activity_note({text, ttl_seconds})`. Default ttl 5, max 30, min 1. Text is sanitized (textContent, no HTML).
- `aria-live="polite"` so screen readers announce state changes.
- Tool signature (new): `set_activity_note({text: string, ttl_seconds?: number})`.
- Dependency: none — pure UI hook.
- Acceptance: no note persists > 30 s; note text ≤ 80 chars (truncate with "…"); collapses cleanly when idle.

**Feature 4 — Quick-action chips**

- DOM anchor: `#jarvis-chips` with `data-agent-id="chips.root"`. Each chip at `chips.<chip_id>`.
- Layout: horizontal flex row under the captions overlay (or at the top of the transcript when Full). 3–5 chips max. Chip style matches DESIGN.md `.chip`.
- Per-page default registry (hardcoded per route, registered in `js/page-*.js`):
  - Dispatch: "Show delayed" / "In-transit TX" / "Export CSV"
  - Carriers: "Reefer available" / "Top-rated dry-van" / "Shortlisted"
  - Negotiate: "Counter +$100" / "Accept" / "Add pickup time"
  - Contact: "Schedule callback" / "Attach last load"
- Clicking a chip fires a local handler (calls the right tool's client handler directly OR opens a form). No LLM round-trip.
- Agent override via new tool `set_quick_actions({chips: [{id, label, tool, args}]})`. The override lasts until page change or the next `set_quick_actions` call.
- Tool signature (new): `set_quick_actions({chips: [{id: string, label: string, tool: string, args?: object}]})`.
- Dependency: ideally after filter tools (so agent-suggested chips can leverage them), but not strictly blocking.
- Acceptance: chips re-render on route change within a single paint (< 16 ms); max 5 rendered; keyboard-tabbable; `Enter` / `Space` activates.

**Feature 5 — Smart filter tools**

- Two new server-side tool declarations (in `api/tools.js`):
  ```
  {
    name: 'filter_loads',
    description: 'Filter the loads table on the dispatch page. All params optional and combine with AND. Syncs to URL query.',
    parameters: { type:'object', properties: {
      status: { type:'string', enum:['all','in_transit','booked','pending','delayed','delivered'] },
      lane_contains: { type:'string' },
      carrier_contains: { type:'string' },
      min_miles: { type:'number' },
      max_miles: { type:'number' }
    }}
  }
  {
    name: 'filter_carriers',
    description: 'Filter the carrier directory. Params combine with AND.',
    parameters: { type:'object', properties: {
      equipment: { type:'string', enum:['all','dry van','reefer','flatbed','tanker'] },
      available: { type:'string', enum:['all','yes','no'] },
      search: { type:'string' }
    }}
  }
  ```
- Client handler (`js/tool-registry.js` via `registerDomain`): sets the DOM filter inputs, fires `input` events so the page's existing filter logic responds; appends URL query via `history.replaceState`.
- Dependency: none (the filter inputs already exist on the page).
- Acceptance: voice-round-trip p50 ≤ 1.2 s from end-of-utterance "show me delayed loads on I-80" to filtered table; URL query reflects state; reload restores filters.

**Feature 6 — Theme toggle**

- DOM anchor: `#jarvis-theme` with `data-agent-id="theme.toggle"`. 3-way segmented control in the settings sheet: Dark / Light / System.
- Storage: `localStorage['jarvis.theme']` (values `'dark'|'light'|'system'`). Default `'system'`.
- Applied by setting `data-theme` on `<html>`. To prevent flash-of-wrong-theme, inline a ~200-byte `<script>` in `<head>` on each HTML shell BEFORE the CSS link:
  ```
  <script>(function(){try{var t=localStorage.getItem('jarvis.theme')||'system';if(t==='system'){t=matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';}document.documentElement.setAttribute('data-theme',t);}catch(e){}})();</script>
  ```
- Tool signature (new): `set_theme({theme: 'dark'|'light'|'system'})`.
- Dependency: `css/tokens.css` must already have `[data-theme="light"]` overrides — DESIGN.md:57 says it does; verify before shipping.
- Acceptance: no flash on load; toggle persists across reloads; `prefers-color-scheme` media query responds live when `'system'` is selected.

### What NOT to do

- Do NOT add features without a `data-agent-id` on their primary surface. The whole thesis is "more agent-controlled features"; a UI-only feature is off-thesis.
- Do NOT have agent tools touch the DOM directly. Use the existing `tool-registry` handlers and the `findByAgentId` indirection — keeps the security story (no arbitrary selectors) intact.
- Do NOT auto-open the command palette on page load or after N seconds of inactivity. It's a user-invoked tool. Agent-invoked is fine.
- Do NOT render captions AND full transcript at the same time. Pick one per pref value.
- Do NOT write features that require server-side persistence (pinboard, saved searches). Local state only until we introduce a backend.

---

## Decision 3: Performance strategy

### Recommendation

- **Initial-load JS budget**: keep the main bundle under ~15 KB gzipped (current `voice-agent.js` prod is 6.6 KB per `specs/perf-audit.md`). Ship new feature modules as SEPARATE esbuild chunks loaded via dynamic `import()` from `js/ui.js` after the first paint.
- **STT model**: lazy-loaded on first `placeCall` only. Cached by transformers.js default in Cache Storage. Gate the download on `!navigator.connection?.saveData && effectiveType !== 'slow-2g'`; require user confirm on cellular.
- **Prompt-cache on Gemini Live**: system prompt skeleton (`api/tools.js:SYSTEM_PROMPT_SKELETON`) is already stable and tool declarations are appended in a stable order. Adding 4 new tool declarations is fine as long as we add them AT THE END of `STATIC_TOOL_DECLARATIONS` so the cached prefix is unchanged. Target > 80 % hit rate (unchanged from current baseline).
- **Mobile 3G budget**: the main shell + the 6 features must load in < 2 s on 3G. That means: main chunk + features = ≤ 50 KB gzipped. Whisper is NOT in this budget — its 40 MB download is gated on wifi/fast-connection.

### Rationale

The existing build already code-splits (`scripts/build.js:69`: `splitting: true`). We lean on that. Each feature file is its own export and gets its own chunk by default. Dynamic `import('./captions-overlay.js')` from `ui.js` loads it on-demand.

The risk with adding 6 features is bundle bloat. Measure after each feature lands (`npm run build:meta` → `dist/meta.json`) and fail the PR if the main chunk exceeds 15 KB gzipped.

Gemini prompt caching bills on stable prefixes. System prompt + tool schemas currently cache well. Adding tools AT THE END preserves the cache. Inserting tools in the middle would invalidate — don't.

### Rejected alternatives

- **Preload everything on page load.** Violates the call-metaphor UX principle ("nothing happens until you place a call") and blows the mobile budget.
- **Lazy-load the STT worker on user typing / hover / idle.** Over-engineered. The first placeCall is the natural trigger — user has committed to the call, spending the bandwidth is justified.
- **Custom IndexedDB cache for Whisper weights.** transformers.js already caches. Reinventing is waste.

### Implementation notes

- Add `dist/meta.json` bundle-size gates to `scripts/build.js` — fail the build if `js/voice-agent.js` gzipped > 15 KB, and log a warning if any feature chunk > 20 KB.
- Stagger the feature module imports in `ui.js`:
  ```js
  // After first paint + after bootstrapVoiceShell returns:
  requestIdleCallback(() => {
    import('./command-palette.js').then(m => m.init());
    import('./activity-indicator.js').then(m => m.init(voiceAgent));
    import('./quick-chips.js').then(m => m.init(voiceAgent));
    import('./theme.js').then(m => m.init());
  });
  // Only when the user toggles captions/opens settings for the first time:
  import('./captions-overlay.js').then(m => m.init(voiceAgent));
  ```
- `stt-controller.js` import is even lazier — deferred to inside `placeCall` itself so the worker + transformers.js bundle don't count toward page load at all.
- Add a smoke test `evals/bundle-budget-smoke.js` that boots a fresh build, checks gzip sizes, asserts budget.

### What NOT to do

- Do NOT bundle `@xenova/transformers` into the main chunk. It's multi-MB.
- Do NOT call `preload` on the model weights. Wait for the explicit placeCall trigger.
- Do NOT add new tool declarations BEFORE existing ones in the array — invalidates Gemini's prompt cache.
- Do NOT skip the `requestIdleCallback` staggering for feature imports. On low-power devices, parallel module fetches contend with the first paint.
- Do NOT measure perf once and declare victory. Each new feature needs a gzip delta checked in.
