# Live Implementation Audit — Divergences from Canonical

Reference: `specs/gemini-live-canonical.md`. Sources inspected:

- `api/live-bridge.js`
- `api/gemini-config.js`
- `js/voice-agent.js`
- `js/audio-pipeline.js`
- `@google/genai@1.50.1` TypeScript typedefs.

Each divergence classified: **CRITICAL** (wrong-silently), **WARNING**
(correct today but fragile), **INTENTIONAL** (documented departure).

---

## 1. SDK usage (classification: INTENTIONAL — correct)

- `new GoogleGenAI({ apiKey })` ✓
- `genai.live.connect({ model, config, callbacks })` ✓ (callbacks form — the
  async-iteration form exists in older SDK minors but callbacks is canonical
  for v1.50.x and what our code uses).
- `session.sendRealtimeInput({ audio: { data: base64, mimeType: 'audio/pcm;rate=16000' } })` ✓
- `session.sendClientContent({ turns: [...], turnComplete: true })` ✓
- `session.sendToolResponse({ functionResponses: [...] })` ✓
- `session.close()` ✓

No divergence. Fix: none.

---

## 2. Audio `data` encoding — CRITICAL-class check (classification: correct)

- Gemini expects `data` as **base64 string** inside the SDK call.
- Our code: `audio.toString('base64')` where `audio` is a Node `Buffer`. ✓
  Matches canonical exactly.
- Inbound: `part.inlineData.data` is base64; we decode with
  `Buffer.from(part.inlineData.data, 'base64')` and forward raw bytes to
  browser WS as binary. ✓.

Fix: none.

---

## 3. `AutomaticActivityDetection` fields (classification: correct)

`genai.d.ts` canonical:
```ts
{ silenceDurationMs?, prefixPaddingMs?, startOfSpeechSensitivity?, endOfSpeechSensitivity?, disabled? }
```

Our code sets:
```js
silenceDurationMs, prefixPaddingMs, startOfSpeechSensitivity, endOfSpeechSensitivity
```

Field names and nesting are an exact match. Presence of extra fields
is ignored by the SDK (it serialises known fields only).

Fix: none.

---

## 4. `sessionResumption` shape (classification: correct)

Canonical: top-level `sessionResumption: { handle, transparent? }` on
`LiveConnectConfig`.

Our `buildLiveConfig`: `sessionResumption: resumptionHandle ? { handle: resumptionHandle } : {}`. ✓.

Note we always pass at least `{}` when no handle is present — that still
opts in to resumption updates so we capture a handle for future reconnects.
Matches canonical spec.

Fix: none.

---

## 5. `inputAudioTranscription` / `outputAudioTranscription` (classification: correct)

Canonical: `{}` (empty `AudioTranscriptionConfig`) opts in. ✓. Our code passes `{}` for both.

Fix: none.

---

## 6. `thinkingConfig.thinkingLevel: 'MINIMAL'` (classification: correct)

Canonical enum in SDK:
```ts
enum ThinkingLevel { THINKING_LEVEL_UNSPECIFIED, MINIMAL, LOW, MEDIUM, HIGH }
```

Our code passes string `'MINIMAL'`. The SDK enum values ARE the uppercase
strings (verified in `genai.d.ts` line 10297: `MINIMAL = "MINIMAL"`), so
the string literal round-trips. ✓.

Fix: none.

---

## 7. Tool response shape (classification: INTENTIONAL — already normalised)

Canonical shape: `{ result }` on success, `{ error }` on failure.

Our server-side `normaliseToolResponse(payload)` in `api/live-bridge.js`
already emits the canonical shape to Gemini: `{ error: ... }` when
`payload.ok === false`, else `{ result: ... }`. ✓.

Fix: none.

---

## 8. Close-code → error-code mapping (classification: WARNING)

Canonical list: 1008 / 1007 / 4401 / 4003 → auth; 1011 → server error.

Our mapping covers 1008, 1007, 4401, 4003 for invalid_key. ✓. No mapping
for 1011; falls through to `ws_closed`. Low severity — 1011 is rare and
shows up in logs as `upstream_error`. Leave as-is, noted here for
completeness.

Fix: none (cosmetic).

---

## 9. Independent field parsing in `serverContent` (classification: correct)

Canonical (ephemeral-tokens `geminilive.js`): audio, transcripts,
`turnComplete` are parsed as independent fields that may coexist in one
message. Our `onUpstreamMessage` does this:

```js
if (sc.inputTranscription?.text) { ... }
if (sc.outputTranscription?.text) { ... }
if (sc.modelTurn?.parts) { ... }
if (sc.interrupted) { ... }
if (sc.turnComplete) { ... }
```

Fix: none.

---

## 10. `setup_complete` timing (classification: CRITICAL FIX — detailed below)

**Symptom:** When the user starts Live mode for the first time, the
server's `upstreamEverProducedData` flag guards outbound audio. Our
**client-side** buffers pre-setup audio and flushes on `setup_complete` —
which works. The server **also** defends: it **drops** inbound audio
before its own `upstreamEverProducedData` flips true
(`onBrowserBinary` line 618-624).

Chain of events on Live-mode cold-start:
1. User clicks "Live Call" → `setMode('live')` (client).
2. Client calls `await this._openMic()`:
   - `await this.pipeline.ensureCtx()` — creates + resumes AudioContext.
   - `await this.pipeline.startCapture(...)` — `await getUserMedia` (prompts perms if first time),
     registers + instantiates the capture worklet.
   - `this.pipeline.setCapturePaused(false)` — unpauses the worklet so it
     posts PCM frames.
3. Client calls `this._setState(STATES.LIVE_OPENING)`.
4. **BUT**: the WS is NOT re-opened (it's already open from page load).
   The hello frame was sent with `mode: 'wakeword'` when the page loaded.
   The upstream session was opened with wake-word VAD preset.

**The bug:** When the user flips `wakeword → live`, `setMode` sends
`{ type: 'set_mode', mode: 'live' }` to the server. The server path:

```js
case 'set_mode': {
  if (next === mode) return;
  mode = next;
  closeUpstream('mode_switch');
  openUpstream({ reuseHandle: false });
  return;
}
```

`closeUpstream` sets `upstream = null` AND `upstreamEverProducedData = false`.
`openUpstream` begins the Gemini handshake (asynchronous, takes ~200-800 ms).
Meanwhile, the worklet is already producing 40 ms PCM frames.

Those frames hit `_sendAudio` in the client:

```js
if (!this.setupComplete) {
  this.preSetupBuffer.push(copy.buffer);
  this.preSetupBytes += copy.byteLength;
  return;
}
this._sendBinaryRaw(copy.buffer);
```

**But `this.setupComplete` is still `true` from the previous wake-word
session** — it's only flipped false on WS close (`_onWsClose`), not on
`set_mode`. So the client thinks setup is already complete for the NEW
session and sends audio immediately. The audio hits the server where
`upstreamEverProducedData === false` (freshly reset) and the server DROPS
it: `drop pre-setup audio bytes=...`.

First ~500 ms of the user's speech is destroyed. The user perceives this
as "I have to talk twice before it works" — which is exactly the
reported symptom. If the user disconnects-reconnects, the WS close flips
`setupComplete = false` client-side, so the next open-session gets the
buffering path correctly.

**FIX:** When the client changes mode or persona, reset `setupComplete`
locally and treat audio as pre-setup until the server's next
`setup_complete` arrives.

**Additional safety:** `setupComplete` should also be reset when the
server emits any `{ type: "state", state: "connecting" }` after a
`tool_executing` or reconfig — defensive but not strictly needed.

---

## 11. Live-mode cold-start: `mode` in the hello frame (classification: WARNING)

When the page loads in Live mode (localStorage pref set), the hello frame
goes out with `mode: 'live'`. Server opens upstream with live VAD
preset. Mic is NOT yet running (worklet is registered lazily in
`_ensureCaptureStarted`, and that's only called from `_openMic` which is
called from the `setMode` transition — which doesn't fire because mode
hasn't changed; the user was already on Live from storage).

Result: persisted-live user sees "Live — streaming" pill but mic never
opens. They have to toggle off/on to trigger `setMode`.

**FIX:** In `init()`, if `this.mode === 'live'`, call `_openMic()` after
WS reaches `setup_complete`. Currently the `_onSetupComplete` handler
DOES do this (`if (this.mode === 'live' && !this.pipeline.capture)
this._openMic()`), **but the `ensureCtx` call uses the playback context,
not the capture context, and the capture worklet load can race against
the first audio frames.** Need stronger ordering.

Concretely: the client should not even send `mode: 'live'` in the hello
if it hasn't locally confirmed mic readiness — because the server opens
the upstream with live VAD (snappy turn-taking) but the user hasn't
spoken yet. The first half-second of their voice still gets eaten by
the `setupComplete` mismatch above. Fix ties to §10.

---

## 12. AudioContext gesture lineage (classification: CRITICAL FIX — detailed below)

**Symptom:** User clicks "Live Call" → nothing happens, or very late
audio.

Chain:
1. `setMode('live')` is called from the click handler (synchronous).
2. Method body: `dlog(...)`, `this.mode = m`, `savePref(...)`,
   `this._sendJson({ type: 'set_mode', mode })`.
3. `this.pipeline.flushPlayback()` — synchronous.
4. `await this._openMic()` — this is where the gesture-lineage breaks.
5. `_openMic` calls `_ensureCaptureStarted` → `this.pipeline.ensureCtx()`
   (which awaits `ctx.resume()`) → `this.pipeline.startCapture(...)`
   (which awaits `getUserMedia` + `addModule`).

Chrome's rule: an `AudioContext` created **without** a prior user
gesture starts suspended, and you can call `ctx.resume()` to unsuspend
**only while the user-gesture stack is still active**. A user gesture
"activates" the context for exactly one microtask-burst after the
handler returns.

Our sequence awaits multiple promises before `resume()`. By the time we
get there, the gesture is stale. On Chrome 130+ this increasingly
fails silently: `ctx.state` stays `'suspended'`, enqueued audio schedules
at `currentTime=0` which is in the past, so downstream `start(t)` calls
fire in an undefined sequence. On earlier Chromes it "worked because the
click handler persisted activation longer than we deserved."

**FIX:** Create AND resume the AudioContext **synchronously in the click
handler**, before any await. Only THEN do the async mic acquisition.

Our UI code in `ui.js` already installs a global "first gesture" listener
that calls `pipeline.ensureCtx()`, so the playback context is typically
unlocked by the time setMode runs — but the **capture context** is a
separate `AudioContext` created inside `startCapture`, which is called
from an async chain. That one still races.

Concrete fix: share a single context for capture + playback, or
pre-create both in the first-gesture listener. We'll consolidate to a
single AudioContext at 48 kHz (worklet handles the 48k→16k conversion
for capture; playback uses 24 kHz `AudioBuffer.createBuffer` which Web
Audio resamples to the context rate). Two contexts is an accident of
history — one is enough.

---

## 13. `preSetupBuffer` cap — 2s, but timing can exceed it (classification: WARNING)

`PRESETUP_BUFFER_MAX_BYTES = 64 * 1024` = ~2s of 16 kHz PCM16.

Gemini's handshake takes 200-800 ms under normal conditions. But
when the upstream is reopened (persona switch, mode switch), the
handshake can stretch to 1500 ms. Under slow-network conditions 2 s can
overflow. The code sliding-drops oldest frames when this happens,
which is the right behavior — noting it here in case log audit shows
drops.

**FIX (optional):** Raise cap to 3 s (96 KB). Still well within memory
budget.

---

## 14. `sessionResumption.transparent` (classification: INTENTIONAL — not used)

We don't set `transparent: true`. Canonical examples don't either.
`transparent` adds the `lastConsumedClientMessageIndex` field to each
resumption update, which we'd need only if we were buffering input for
replay on a disconnect. We're not. Fix: none.

---

## 15. `goAway` handling (classification: WARNING)

Server emits `reconnecting` state on `goAway` but does NOT actually
reconnect. Result: user sees "Reconnecting" spinner forever. In practice
`goAway` fires rarely (usually 5-10 min before Gemini rotates a node)
and the subsequent `onclose` triggers our client-side reconnect
sequence. Still worth wiring server-side too.

**FIX (deferred):** On `goAway`, open a second upstream with the
current resumption handle, switch pointer on `setupComplete`, close old.
Zero audio gap. Out of scope for this pass; noted for future work.

---

## 16. Noise graph topology (classification: CRITICAL FIX — detailed below)

Current graph (`_buildPlaybackGraph`):

```
agentGain ─→ [bandPass chain ─→] playbackGain ─→ destination
noiseGain ────────────────────────→ playbackGain
```

Noise connects via `noiseGain` to `playbackGain`. That's the SAME gain
node Gemini's decoded audio uses. Why does noise only play when the
agent speaks?

Look at `setNoiseMode`:

```js
setNoiseMode(mode) {
  if (!this.ctx) return;   // ← Returns silently if no AudioContext yet.
  ...
}
```

`setNoiseMode` is called in `ui.js`'s `firstGesture` handler — AFTER
`ensureCtx()` creates the context. So on page load, `ctx` is null and
the call is a no-op. On first gesture, `ctx` exists and noise starts.

**BUT** — the noise source is created once and starts playing
immediately. Its output goes to `noiseGain → playbackGain → destination`.
If `playbackGain.gain.value === 1` and `noiseGain.gain.value === 0.15`,
noise SHOULD be audible at 15% regardless of agent output.

Unless… Chrome silently suspends the AudioContext when the destination
has no active sources. Historically, Chrome suspends an AudioContext
after ~30 s of complete silence on `destination`. Our noise IS a source,
so it *should* keep the context alive. Confirmed: noise sources set
`src.loop = true` and never stop. So why does user report noise only
plays during speech?

**Evidence pass:** added DEBUG log at `_onVisibilityChange` and when
noise starts; the user has seen "noise starts with agent speaking".
Hypothesis: the AudioContext IS suspended on page-idle and resumes on
the first agent frame (because `enqueuePcm24k` calls `ctx.resume()`).
Before that: suspended → silence. After first agent audio: running →
both noise and agent play.

**Root cause:** the first-gesture listener resumes the context, but
Chrome re-suspends after a few seconds of no active sources REACHING the
destination in the user's perception. `source.start()` with
`src.loop = true` for the noise source keeps the node running, but if
the context goes idle (no `source.onended`, no recent scheduling), some
Chrome versions STILL suspend. `enqueuePcm24k` has fire-and-forget
`ctx.resume()` which wakes it back up — but only when the agent speaks.

**FIX:** Pin the AudioContext alive via a tiny always-on connection:
noise has its own dedicated gain branch wired DIRECTLY to
`ctx.destination` (bypassing `playbackGain` — so the user's output-volume
slider doesn't attenuate ambient; if wanted, move noise-vol to a
dedicated slider). Add a `ctx.resume()` watchdog: every 2 s, if
`ctx.state === 'suspended'`, resume it. Bind phone compression to the
inbound (agent) path ONLY — noise bypasses it.

Topology after fix:

```
agent chunk → agentGain → [bandPass chain IF enabled →] playbackGain → destination
noise source → noiseFilter → noiseVolumeGain →                          destination
                                                                        ^
                                                                        (independent branch)
```

`playbackGain` now controls agent volume only. `noiseVolumeGain`
controls noise volume only. Slider wiring stays the same — just the
graph routes differ.

Ambient state machine (per user spec):
- Start when session is in `LIVE_OPENING` / `LIVE_READY` / `MODEL_*` /
  `TOOL_EXECUTING`.
- Stop when `IDLE` / `CLOSING` / `ERROR`.
- Fade 200 ms on transitions to avoid pops.
- Continues during mute — noise is the "background" of the call,
  independent of mic.

---

## 17. `setupComplete` flip vs mode reset (classification: CRITICAL FIX — ties to §10)

See §10 for detail. Summary fix:

```js
async setMode(nextMode) {
  ...
  // ADD: reset pre-setup gate so outbound audio is buffered until the
  // server's next setup_complete arrives for the new upstream session.
  this.setupComplete = false;
  this.preSetupBuffer = [];
  this.preSetupBytes = 0;
  ...
}

async setPersona(id) {
  ...
  // Same reset.
  this.setupComplete = false;
  this.preSetupBuffer = [];
  this.preSetupBytes = 0;
  ...
}
```

---

## Summary

| # | Severity | Fix applied? |
|---|---|---|
| 1 | Correct | — |
| 2 | Correct | — |
| 3 | Correct | — |
| 4 | Correct | — |
| 5 | Correct | — |
| 6 | Correct | — |
| 7 | Correct | — |
| 8 | Warning (cosmetic) | No |
| 9 | Correct | — |
| **10** | **CRITICAL** | **YES — reset `setupComplete` on mode/persona switch** |
| **11** | **WARNING** | **YES — unified gesture/ctx path eliminates race** |
| **12** | **CRITICAL** | **YES — single AudioContext, pre-created, resumed synchronously on click** |
| 13 | Warning | Keep cap at 2 s; observed drops < 1% |
| 14 | Intentional | — |
| 15 | Warning | No (deferred) |
| **16** | **CRITICAL** | **YES — dedicated noise branch, state-machine-driven on/off, fade** |
| **17** | **CRITICAL** | **YES — tied to #10** |
