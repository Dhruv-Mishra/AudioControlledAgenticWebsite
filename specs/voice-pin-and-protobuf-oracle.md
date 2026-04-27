# Oracle Spec: Voice Pinning, Protobuf, and Personality Tile Bug

**Date:** 2026-04-27
**Scope:** Dhruv FreightOps demo — Gemini Live voice agent
**Status:** PRESCRIBE ONLY — do not implement

---

## Decision 1: Voice Pinning Across the Call

### Diagnosis

The voice is derived from `persona.voice` every time `openUpstream()` runs
([live-bridge.js](api/live-bridge.js#L556)):

```js
const voice = KNOWN_VOICES.includes(persona.voice) ? persona.voice : 'Kore';
```

This feeds into `buildLiveConfig({ voiceName: voice, ... })` →
`speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName`
([gemini-config.js](api/gemini-config.js#L59)).

**Why drift happens:**

| Path | Voice changes? | Cause |
|---|---|---|
| SPA nav (`handleRouteChange`) | NO | Only sends `page_context` text frame. Upstream stays open. |
| Network blip → auto-reconnect | YES | New `_connect` → `hello` → `openUpstream`. New Gemini session. Same persona voice string, but Gemini's TTS timbre/pacing can shift on a fresh session — perceived as "different voice." |
| Explicit persona switch | YES (intended) | `closeUpstream('persona_switch')` → `openUpstream({ reuseHandle: false })`. New voice from new persona. |
| Full page reload (non-SPA nav) | YES | VoiceAgent destroyed + rebuilt. New WS → new Gemini session. Even with resume handle, it's a new TTS instance. |

The real culprit is paths 2 and 4: any reconnect/rebuild creates a fresh
Gemini Live session. Even when the voice NAME is identical, the session-level
TTS characteristics (timbre seed, pacing) reset. Additionally, Gemini may
subtly adapt its speaking style based on the `page_context` injection content,
which users perceive as a voice shift even within a single session.

### Recommendation

**One voice per call, locked at call open.** Decouple voice selection from
persona so a persona switch mid-call changes TONE (system prompt fragment)
but not VOICE (TTS config).

1. **Add `selectedVoice` to the session state** — stored in the session blob
   (`sessionStorage`) and `localStorage` (`liveAgent.voice`). Set once at
   `placeCall()` time from the current persona's default voice (or a user
   override from the settings menu). Never mutated mid-call.

2. **Thread `selectedVoice` through the WS protocol:**
   - `hello` frame: add `selectedVoice: this.selectedVoice`.
   - Server `hello` handler: read `data.selectedVoice` instead of `persona.voice`.
   - `openUpstream()`: use the hello-supplied voice, falling back to
     `persona.voice` only when missing (backwards compat).
   - **Persona switch path** (`case 'persona'`): reopen upstream with the
     SAME `pinnedVoice` that was locked at call start — do NOT re-derive
     from `persona.voice`. Change only the system prompt fragment.

3. **Session resume path:** echo `selectedVoice` in the resume handle blob so
   a reconnect/resume uses the same voice. This minimises perceived TTS shift
   across reconnects.

4. **Settings menu voice picker:** expose a voice dropdown/segmented control
   in the settings sheet. Picker is disabled mid-call (greyed, tooltip: "End
   call to change voice"). Takes effect on next `placeCall()`.

### Rejected Alternatives

- **Pin voice by suppressing reconnects:** Doesn't work — network blips are unavoidable.
- **Send voice on every `page_context`:** Gemini Live's `speechConfig` is session-level; can't change per-turn.
- **Let persona switch change voice mid-call:** The original design. Users perceive it as jarring.

### Code Locations to Touch

| File | Change |
|---|---|
| [js/voice-agent.js](js/voice-agent.js#L1212) | `setPersona`: stop sending `voice` with persona frame. Add `selectedVoice` field, lock in `placeCall()`, include in `hello`. |
| [js/voice-agent.js](js/voice-agent.js#L1389) | `_connect` / hello construction: add `selectedVoice: this.selectedVoice`. |
| [api/live-bridge.js](api/live-bridge.js#L877) | `hello` handler: read `data.selectedVoice`, stash as session-scoped `pinnedVoice`. |
| [api/live-bridge.js](api/live-bridge.js#L556) | `openUpstream`: use `pinnedVoice` instead of `persona.voice`. |
| [api/live-bridge.js](api/live-bridge.js#L1079) | Persona-switch path: pass existing `pinnedVoice` to `openUpstream`. |
| [js/ui.js](js/ui.js#L611) | Add voice picker in settings sheet (disabled mid-call). |
| [css/voice-dock.css](css/voice-dock.css) | Styles for voice picker control. |

---

## Decision 2: Protobuf for the Live Bridge?

### VERDICT: No.

### Rationale

1. **Audio is already binary.** Browser ↔ server audio frames are raw PCM16 over WebSocket binary frames ([live-bridge.js](api/live-bridge.js#L76) uses `ws.send(buf, { binary: true, compress: false })`). Protobuf wouldn't touch the dominant payload.

2. **Control messages are tiny.** JSON text frames for `page_context`, `tool_call`, `state`, `transcript_delta` etc. are 200 B–4 KB. JSON parse/stringify cost <0.1 ms per frame — invisible next to Gemini's 200–800 ms generation latency.

3. **Debugging cost.** JSON is inspectable in DevTools and `wscat`. Protobuf requires a decode step. For an active demo, debuggability > marginal serialization savings.

### What WOULD Move the Needle

If latency or bandwidth becomes a measured bottleneck (it isn't today):

- **ws `perMessageDeflate` for text frames only.** Net: ~40–60% size reduction on `page_context` frames.
- **Delta transcripts.** Send only the new characters + offset.
- **Binary audio frame coalescing.** Batch 2–3 small PCM chunks. Trade-off: +10–30 ms latency.
- **MessagePack** if JSON parsing ever shows in a profile. Drop-in, ~30% smaller. Still not worth it today.

---

## Decision 3: Settings Menu Personality Tile Bug

### Diagnosis

**Root cause: stale `aria-checked` attribute after `personas-ready` rebuild.**

The CSS selector for the active tile matches BOTH attributes
([voice-dock.css](css/voice-dock.css#L1357)):

```css
.persona-seg button[aria-pressed="true"],
.persona-seg button[aria-checked="true"] { /* highlighted */ }
```

Two code paths build the persona buttons and wire click handlers:

| Path | Sets `aria-checked` on click? |
|---|---|
| Initial build ([ui.js](js/ui.js#L714)) | YES — handler sets both `aria-pressed` AND `aria-checked` |
| `personas-ready` rebuild ([ui.js](js/ui.js#L723)) | **NO** — handler sets only `aria-pressed` |

**Sequence producing the bug:**

1. Page load → `buildPersonaButtons` builds tiles. Professional gets `aria-pressed="true"` + `aria-checked="true"`. Others get both `"false"`.
2. `agent.init()` completes → `personas-ready` fires → `buildPersonaButtons` **replaces** all buttons. New click handler only manages `aria-pressed`.
3. User clicks Cheerful → handler sets `aria-pressed="true"` on Cheerful, `"false"` on Professional. But `aria-checked` is untouched — Professional retains `aria-checked="true"` from build step 2.
4. **Result:** Professional matches `[aria-checked="true"]` → still highlighted. Cheerful matches `[aria-pressed="true"]` → also highlighted.

### Recommendation

**Single attribute, single handler.** Fix pattern:

1. **Drop `aria-checked` entirely from persona buttons.** `aria-pressed` is the correct attribute for a toggle/segmented control.
2. **Unify the click callback.** Extract `selectPersonaTile(id)` that calls `agent.setPersona(id)` and sets `aria-pressed` to `"true"` / `"false"` based on `data-persona-id === id`.
3. **Remove `[aria-checked="true"]` from the CSS rule.**
4. **Listen for `persona-changed` in ui.js** to sync visual state when persona changes from a non-click source.

### Code Locations to Touch

| File | Change |
|---|---|
| [js/ui.js](js/ui.js#L611) `buildPersonaButtons` | Remove `aria-checked` setAttribute. |
| [js/ui.js](js/ui.js#L714) initial handler | Use unified `selectPersonaTile`. |
| [js/ui.js](js/ui.js#L723) `personas-ready` handler | Use same unified `selectPersonaTile`. |
| [js/ui.js](js/ui.js#L730) | Add `persona-changed` listener → sync tiles. |
| [css/voice-dock.css](css/voice-dock.css#L1358) | Remove `button[aria-checked="true"]` from the selector. |

---

## Hand-off

### frontend-dev

| File | Task |
|---|---|
| [js/ui.js](js/ui.js) | Fix persona tile bug (Decision 3). Extract `selectPersonaTile`, unify handlers, add `persona-changed` listener. Add voice picker control for Decision 1. |
| [css/voice-dock.css](css/voice-dock.css) | Remove `aria-checked` CSS rule. Style voice picker (disabled mid-call state). |

### ai-engineer

| File | Task |
|---|---|
| [js/voice-agent.js](js/voice-agent.js) | Decision 1: add `selectedVoice` field, lock in `placeCall`, thread through `hello` frame, prevent persona-switch from changing voice mid-call. |
| [api/live-bridge.js](api/live-bridge.js) | Decision 1: read `data.selectedVoice` from hello, stash as `pinnedVoice`, use in `openUpstream` and persona-switch path. |

### Sequencing

1. **Decision 3 first** (persona tile bug) — standalone, < 30 min.
2. **Decision 1** (voice pinning) — touches both frontend-dev and ai-engineer files. Can work in parallel after agreeing on the `hello` frame schema (`selectedVoice: string`).
3. **Decision 2** (protobuf) — no action required.
