# HappyRobot FreightOps — Voice Agent Demo

A working demo of a voice agent (Google Gemini Live API) that takes real actions on a mock freight dispatcher console via tool calling. Built to showcase the exact product surface HappyRobot sells: natural-sounding voice agents for dispatch, customer service, and rate negotiation.

## Highlights

- **Phone-call UX.** Nothing runs until the user clicks **Place Call**. The moment they do, ambient noise fades in, the WebSocket opens, the mic opens, and Jarvis greets them in one short sentence when the session is ready. The big button then becomes **End Call** (or **Cancel** while dialing). See [`specs/call-ux.md`](specs/call-ux.md).
- **Voice agent takes actions on the website** via tool calling — navigate pages, fill forms, click buttons, submit quotes, schedule callbacks, look up loads, assign carriers.
- **Seamless SPA navigation.** Clicking between Dispatch, Carriers, Negotiate, and Contact is handled client-side via the History API — the voice WebSocket, AudioContext, and microphone all live in a single long-lived page shell. The call does not drop, the mic does not re-acquire, and the status pill does not flicker. See [`specs/oracle-seamless-nav.md`](specs/oracle-seamless-nav.md).
- **Persona switching** — Professional, Cheerful, Frustrated, Tired, Excited. Each has its own Gemini voice and tone. Settings overlay.
- **Call-center realism by default** — phone-line compression (300 – 3400 Hz band-pass) ON by default and gentle procedural office chatter at 0.15 volume. Ambient noise runs on an INDEPENDENT audio branch and plays for the full duration of the call, starting the instant the user clicks Place Call.
- **Mobile-first polish.** Full-width bottom dock at ≤ 640 px with safe-area-inset padding for iOS, 48×48 tap targets, scrollable nav, safer bottom padding under the fixed dock. Wake Word is disabled on iOS Safari (SpeechRecognition unreliable); Place Call works natively.
- **Token efficient** — no audio goes upstream until the user places a call; `thinkingLevel: MINIMAL`; sliding-window compression at 80 000 tokens; stable system-prompt + tool-schemas prefix so prompt-caching pays off.
- **Failure-mode UI** for every state: idle, dialing, connecting, live, thinking, speaking, tool-executing, reconnecting, closing, and five error sub-states.

## Stack

- **Frontend:** vanilla HTML/CSS/JS. AudioWorklet for 16 kHz PCM capture. No framework, no build step.
- **Backend:** Node.js 20+. HTTP server + `/api/live` WebSocket bridge to Gemini Live.
- **AI:** `@google/genai` SDK (Live API). Model pinned to `gemini-3.1-flash-live-preview` with a documented fallback to `gemini-live-2.5-flash-preview` if your key doesn't have 3.1 access.

## Run it

```bash
# 1. install deps
npm install

# 2. set your key (either filename works — .env or .env.local)
cp .env.example .env
#   edit .env (or .env.local) and put your GEMINI_API_KEY in
#   — .env.local is loaded AFTER .env and overrides it, which matches the
#     convention used in the GeminiFlashAgentTest Python prototype.

# 3. run
npm start       # or: node server.js
# → http://localhost:3001
```

Open http://localhost:3001 in Chrome, Edge, or any recent Chromium browser. Safari/iOS works for Place Call mode; Wake Word is disabled on Safari because `SpeechRecognition` is flaky there. Click the big green **Place Call** button to start — the dock will ask for mic permission on first use, then Jarvis will greet you.

### Verify the plumbing

```bash
curl -s http://localhost:3001/api/health
# → {"ok":true,"uptime":...,"model":"gemini-3.1-flash-live-preview","hasApiKey":true,...}
```

### Run the text-mode eval

(while the server is running, separate shell)

```bash
npm run eval
```

The eval fires five scripted prompts at `/api/eval` — which uses the same system prompt and tool schemas as the Live path, but with a text-mode `generateContent` call — and asserts the model returns the expected `function_call` on the first turn.

### Forced-failure smoke test

```bash
npm run smoke:invalid-key
```

This spins up a second server instance on port 3458 with a deliberately-invalid key and confirms `/api/health` still returns 200 and the Live WS surfaces a `{ type: "error", code: "invalid_key" }` frame within a few seconds. Use this before claiming "voice works end to end."

## Listening modes

The dock defaults to **Place Call** — a single big green button. Click it to start a call. While on the call the button is red **End Call**. While dialing it's red **Cancel**.

Wake Word ("Hey Jarvis") is available as an advanced setting inside the gear overlay for power users. The toggle is persistent across reloads (`localStorage`) and across page navigation (`sessionStorage`).

| Mode | Behavior |
|---|---|
| **Place Call** (default) | Big button in the dock. Click to start a call; Jarvis greets you and awaits your request. Click End Call to hang up. Turn-taking handled by Gemini's native VAD (500 ms silence threshold). Barge-in works: start talking while Jarvis is speaking and the model stops mid-word. Auto-ends after 3 minutes of silence. |
| **Wake Word** (advanced, in settings) | Mic arms in the background and listens for "Hey Jarvis" / "Hi Jarvis" / "Okay Jarvis". Triggers a call as if you'd tapped Place Call. Requires `SpeechRecognition` (Chromium, Edge); disabled automatically on iOS Safari. |

## Continuous conversation across pages

The site is a single-page app. `/`, `/carriers.html`, `/negotiate.html`, and `/contact.html` are **all served by the same `index.html` shell**; the client-side router (`js/router.js`) uses the History API to swap section bodies (`/partials/*.html`) into the shell's `<main>` without a full document reload. The voice dock, `VoiceAgent`, `AudioPipeline`, `WebSocket`, and `MediaStreamTrack` are all created exactly once at page load and survive every route change.

Concretely, when you click a nav link (or ask Jarvis to `navigate`):

1. The router intercepts the click, calls the current route's `exit()` to unregister its domain tools, then fetches the new partial and injects it into `<main id="route-target">`.
2. The router pushes the URL via `history.pushState` — the URL bar updates, back/forward work, and the URL is bookmarkable (the server serves the same shell for any of the four paths).
3. After the partial's `enter()` registers fresh domain tools, the router calls `voiceAgent.handleRouteChange({ path })`, which ships a single `page_context` frame upstream. No WebSocket reconnect. No AudioContext rebuild. The status pill stays on `Live — streaming`.
4. If the upstream happens to not be ready yet (first page load), the page_context is queued and sent on the next `setup_complete`.

Session-resumption handles (`sessionStorage['jarvis.session']`) are still captured and persisted — they are now used only for **full tab reloads** and **genuine WebSocket drops** (network blip, server restart), not for routine navigation.

**Quick test:** Open `/`, say *"My name is Skyler. Remember that."*. Click **Carriers** in the nav. The call should feel continuous — no pill flicker, no mic prompt, no audio glitch. Say *"What did I say my name was?"* — Jarvis answers *"Skyler."*

**Clearing state:** the **Clear** button in the dock wipes the visible transcript AND the sessionStorage blob.

Full design: [`specs/oracle-seamless-nav.md`](specs/oracle-seamless-nav.md) (SPA architecture) + [`specs/session-resumption.md`](specs/session-resumption.md) (handle flow for reload / reconnect).

## Keyboard + buttons

- **Place Call / End Call / Cancel**: the big button in the dock. Primary action in every state. Enter or Space when focused triggers it.
- **Mute mic** (round button next to Place Call, visible only during a call): click or press `M` to mute/unmute. The `MUTED` chip appears next to the status pill.
- **Settings gear** (icon in the header): opens an overlay with Persona, Noise, Phone-line compression, Output volume, and Mode (Place Call / Wake Word). `Esc` closes it.
- **Persona**: 5 voices (Professional / Cheerful / Frustrated / Tired / Excited). Switching mid-call reopens the upstream with a new voice; the call stays alive.
- **Clear transcript**: inside Settings — wipes the visible transcript and the cross-page `sessionStorage` blob.
- **Debug mode**: append `?debug=1` to the URL to see the metrics panel (state, mode, WS state, frame counts, calls, greeting sent flag) and console logs.

## Default audio-effect settings

The dock ships with call-center-realistic defaults so the demo sounds the part without any fiddling:

| Setting | Default | Range |
|---|---|---|
| Phone-line compression | **ON** | toggle |
| Noise preset | **Office chatter** | off / phone / office / static |
| Noise volume | **0.15** | 0.0 – 1.0 |
| Agent output volume | 1.0 | 0.0 – 1.5 |

Outbound mic audio to Gemini is untouched — the model always hears clean 16 kHz PCM, so token cost and STT accuracy are not affected.

**Audio graph topology:**
- **Agent audio path:** Gemini 24 kHz PCM → `agentGain` → [optional phone-line bandpass 300–3400 Hz + soft-clip] → `playbackGain` (agent-volume slider) → `ctx.destination`.
- **Ambient noise path (independent):** procedural noise source → `noiseBusGain` (noise-volume slider) → `noiseEnvelopeGain` (fade envelope, driven by the session state machine) → `ctx.destination`.

The two paths never merge before `ctx.destination`. That means:
1. **Ambient noise plays continuously for the duration of the call**, not only while Gemini is speaking.
2. The agent-volume slider scales the agent only; the noise slider scales the noise only.
3. Phone-line bandpass compresses the AGENT voice only — the background room stays broadband, which is how a real phone call sounds (you, unfiltered, in your room; the voice on the other end, compressed).

The ambient state machine fades in over ~220 ms the instant the user clicks Place Call (state becomes `DIALING`) and stays on through `LIVE_OPENING` / `LIVE_READY` / `MODEL_*` / `TOOL_EXECUTING` / `RECONNECTING`. It fades out over ~300 ms when the user clicks End Call. If you mute the mic, noise keeps playing — it's the room you're calling from, not the line you're calling on.

User adjustments persist in `sessionStorage['jarvis.session']` so they survive page reloads. The server receives no audio-effect metadata; these are purely client-side rendering choices.

## Mobile / responsive

The site is designed mobile-first and polished for three viewport tiers:

| Tier | Width | Notes |
|---|---|---|
| Phone | ≤ 640 px | Full-width bottom-fixed dock with iOS safe-area-inset padding. Nav becomes a horizontally scrollable row. Summary cards collapse to 2-up (1-up below 380 px). Tables scroll horizontally inside `.table-wrap`. 48 px tap targets on all primary buttons. |
| Tablet | ≤ 900 px | Dock narrows to 340 px bottom-right. Page grids collapse from 2-col to 1-col for negotiate / contact. |
| Desktop | > 900 px | Full 380 px dock in bottom-right with persistent transcript panel. |

iOS-specific:
- `SpeechRecognition` is unreliable on iOS Safari → Wake Word is disabled with a hint. Place Call works natively (it's gesture-triggered).
- `AudioContext` unlocks synchronously on the Place Call click so iOS 15+ autoplay policy honours it.
- `viewport-fit=cover` is already on the shell; safe-area insets on the dock mean the End Call button sits above the home indicator.

Verify with Chrome DevTools device mode or any mobile browser pointed at `http://<your-host>:3001`.

## 60-second demo script

Say these out loud. Each should exercise a different tool path.

1. **"Hey Jarvis, take me to the carriers page."** → `navigate` to `/carriers.html`.
2. **"Highlight the shortlist button for Liberty Freight."** → `highlight(agent_id="carriers.card.C-088.shortlist")`.
3. **"Filter carriers to show only available ones."** → `select(agent_id="carriers.filters.available", option="Available now")`.
4. **"Go to rate negotiation."** → `navigate("/negotiate.html")`.
5. **"Set the target rate to 1850 and submit the quote."** → `fill(target_rate)` + `submit_quote` / `submit_form`.
6. **"Navigate to dispatch and find load LD-10824."** → `navigate("/")` + `get_load("LD-10824")`.
7. **"Assign the next available carrier to that load."** → `assign_carrier`.

While demoing, flip through the **persona** selector — the session closes and re-opens with a new voice + tone so the change is immediately audible. Toggle **Phone-line compression** + **Office chatter** noise to sell the "real call-center" feel.

## Architecture

```
 Browser                                    Node server                  Gemini Live
 ┌─────────────────────┐                   ┌─────────────────────┐     ┌───────────────┐
 │  AudioWorklet       │  PCM16 @16 kHz    │  /api/live WS       │     │               │
 │  (mic → 16 kHz)     │──binary frames──▶ │  (bridge)           │────▶│  sendRealtime │
 │                     │                    │                     │     │               │
 │  WakeWordEngine     │ JSON control       │  bridge.onmessage   │     │  onmessage    │
 │  (Web Speech API)   │◀────JSON──────────│  (fwd tool calls,   │◀────│  (audio,     │
 │                     │                    │   transcripts,     │     │   tool calls) │
 │  ToolRegistry       │ tool_result JSON   │   usage)            │     │               │
 │  (DOM executor)     │──────────────────▶│                     │     │               │
 │                     │ PCM 24 kHz binary  │                     │     │               │
 │  AudioPipeline      │◀─────────────────│  inject noise/BP    │     │               │
 │  (noise + BP +     │                    │                     │     │               │
 │   playback)         │                    │                     │     │               │
 └─────────────────────┘                   └─────────────────────┘     └───────────────┘
```

- **API keys never leave the server.** The browser only ever talks to our Node WS; the Node bridge is the WebSocket client to Gemini.
- **Rate limiting** per-IP (1 concurrent WS, 60/hour, soft frame cap).
- **Sanitisation:** the browser never renders raw model output as HTML. All transcript text is set via `textContent`.

## File ownership

| File | Role |
|---|---|
| `server.js`, `api/*` | ai-engineer — the Gemini bridge + server plumbing |
| `DESIGN.md`, `css/*` | designer — tokens, components, voice-dock |
| `index.html`, `partials/*.html`, `js/page-*.js`, `js/router.js`, `js/app.js` | frontend-dev — SPA shell, route partials, router, per-page domain tool handlers |
| `js/voice-agent.js`, `js/audio-pipeline.js`, `js/wake-word.js`, `js/tool-registry.js`, `js/stt-logger.js`, `js/ui.js`, `js/audio-worklets/*` | ai-engineer + frontend-dev — voice stack |
| `evals/*` | ai-engineer |

## Customizing

- **Model:** set `GEMINI_LIVE_MODEL` in `.env` to override the default `gemini-3.1-flash-live-preview`.
- **Personas:** edit `api/personas.js` — the client reads this list via `/api/config` at boot.
- **Tools:** edit `api/tools.js` for declarations + `js/tool-registry.js` (generic tools) or the page-specific `js/page-*.js` (domain tools).
- **Noise:** procedural Web Audio graphs in `js/audio-pipeline.js`. To use real samples, drop `.wav`/`.mp3` files into `public/sounds/` and adjust the factories.

## Known limitations

- Wake word uses the Web Speech API — works in Chrome/Edge, unreliable or absent in Firefox and older Safari.
- Ambient noise plays on the **client side only**. Gemini receives clean 16 kHz PCM, so token cost and STT/VAD accuracy are not affected.
- The `gemini-3.1-flash-live-preview` alias may not be enabled on every key. The bridge falls back automatically to `gemini-live-2.5-flash-preview`.
- Persona and mode switches DO close and reopen the upstream Gemini session (different voice / VAD config). This is the one place a brief `Opening session` transition is visible — it's a deliberate user action, not a navigation.
- No persistence — load/carrier state resets on a full reload.
- Ephemeral-token direct-to-Gemini mode is not implemented in v1 (server-proxy only). See `specs/oracle-spec.md` for the rationale.

## Troubleshooting

### Turn on DEBUG logging first
Whenever the voice flow misbehaves, run the server with `DEBUG=1` and append `?debug=1` to the URL:
```bash
DEBUG=1 npm start
# browser:
# http://localhost:3001/?debug=1
```
You'll get per-frame logs on both sides.

### What a healthy session looks like
Server stdout:
```
[server] GEMINI_API_KEY detected (len=39)
HappyRobot FreightOps listening on http://localhost:3001
[live <sid>] attach complete — awaiting hello
[live <sid>] hello persona=professional page=/ elements=57
[live <sid>] upstream connect requested model=gemini-3.1-flash-live-preview voice=Kore persona=professional
[live <sid>] onopen model=gemini-3.1-flash-live-preview
[live <sid>] ai.live.connect resolved
[live <sid>] first message received — handshake OK
[live <sid>] output_transcription delta len=7 finished=false
[live <sid>] audio chunk bytes=3840
[live <sid>] audio chunk bytes=3840
[live <sid>] turn_complete
```
Browser DevTools console (with `?debug=1`):
```
[jarvis] ws onopen, sending hello
[jarvis] server msg hello_ack
[jarvis] server msg state connecting
[jarvis] server msg state listening
[jarvis] audio frame bytes=3840 samples=1920 ctx=running
```

### Top failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `[server] GEMINI_API_KEY NOT SET` | Key is missing from both `.env` and `.env.local` | Put `GEMINI_API_KEY=...` in either file (spaces around `=` are not allowed). Restart server. |
| Server logs `onclose code=1007 reason=API key not valid` | The key is present but rejected by Gemini | Generate a fresh key at https://aistudio.google.com/apikey and replace. |
| Server logs show `audio chunk bytes=N` but browser stays silent | Browser `AudioContext` is suspended by Chrome's autoplay policy | Click anywhere on the page once to satisfy the user-gesture requirement. The "Click to enable audio" banner should appear automatically; clicking it resumes the context. |
| Live mode: first utterance after toggling is partially dropped | This was a cold-start bug in an earlier build — `setupComplete` wasn't reset on mode switch, so audio went upstream before the new session was ready | Fixed by `voice-agent.js :: _resetSetupGate()` on every `setMode` / `setPersona`. Verify with `npm run smoke:cold-start-live`. |
| Ambient noise only plays while Gemini is speaking | This was a graph-topology bug — noise was downstream of the agent-output gain | Fixed by running noise on an independent branch direct to `ctx.destination` (`audio-pipeline.js`). Verify by flipping to Live mode and noting that office chatter continues continuously, not just during speech. |
| Clicking a nav link visibly drops the call / shows a reconnect | This was a multi-page-site issue — pre-SPA | Fixed by SPA routing (`js/router.js`). Full navigation architecture is in `specs/oracle-seamless-nav.md`. |

### Diagnostic smoke tests (no browser needed)
```bash
# Asserts the bridge fails gracefully on a bad key.
npm run smoke:invalid-key

# Asserts ai.live.connect() is actually called on the first hello — catches
# future regressions in the SDK call pattern (no key required).
npm run smoke:upstream-handshake

# Full wire-protocol round-trip simulator. If GEMINI_API_KEY is a REAL valid
# key, additionally asserts that the server forwards binary audio from Gemini
# back to the (simulated) browser AND that the browser-side Int16Array decode
# succeeds. If the key is missing/invalid, falls back to the error-path smoke.
npm run smoke:browser-sim

# Asserts Live-mode wire protocol (hello-with-mode=live, set_mode switches).
npm run smoke:live-mode

# Asserts cross-page session-resumption wire protocol: hello with
# resumeHandle is accepted and passed to ai.live.connect, stale handles
# are dropped, page_context messages are wired. No real key needed.
npm run smoke:session-resume

# Asserts Place Call cold-start wire protocol: after Place Call, the
# browser opens EXACTLY ONE WS and ONE upstream (no reconnect churn),
# and the server's defensive `drop pre-setup audio` gate still fires.
# No real key needed.
npm run smoke:cold-start-live

# Asserts the greeting-injection wire: the browser's `call_start`
# message after setup_complete triggers a <call_initiated> block via
# sendClientContent. No real key needed (we test the wire guard).
npm run smoke:greeting-injection

# When the key IS valid, run it explicitly for end-to-end proof:
GEMINI_API_KEY=$YOUR_KEY node evals/simulated-browser-smoke.js
```

### If audio still doesn't play
1. Open DevTools → Network → WS → `/api/live`. Confirm binary messages are arriving (frames with no "Text" in the Data column).
2. Reload with `?debug=1` and look for `[jarvis] audio frame bytes=N samples=N ctx=running` lines.
   - If `ctx=suspended`, click anywhere on the page — the context unlocks and subsequent frames play.
   - If you see no `[jarvis] audio frame` lines but the server shows `audio chunk bytes=N`, the browser WebSocket isn't delivering binary — check for a network proxy rewriting bytes.
3. Check the server log for `output_transcription delta` lines. If present, the model IS speaking; the problem is local to the browser. If absent, the model isn't generating audio — check the key, the model id, and whether the system prompt accidentally said "respond only in text."
