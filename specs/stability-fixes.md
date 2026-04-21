# Stability fixes — inconsistency pass

Each fix maps to an observed failure mode. Each has a verification path.

## 1. Audio sent before Gemini setup completes

**Symptom:** First ~200ms of a user utterance is lost. "Hey Jarvis" triggers
an upstream session open; the user starts talking before the session setup
message arrives; those PCM chunks are dispatched to the SDK which forwards
them to Gemini before it's actually ready. Gemini silently drops them.

**Root cause:** The client had no notion of "upstream ready." It started
sending audio the moment the mic opened.

**Fix:**
- Server emits `{ type: "setup_complete" }` on the first upstream message.
- Client gates `_sendAudio()` on `this.setupComplete`. While false, chunks go
  into a sliding ring buffer (`preSetupBuffer`) capped at `PRESETUP_BUFFER_MAX_BYTES`
  (~2s @ 16 kHz). On `setup_complete`, the buffer is flushed in order.
- Server also defends: `onBrowserBinary` drops audio before `upstreamEverProducedData`
  and logs the drop so future regressions are visible.

**Verification:**
- `npm run smoke:upstream-handshake` — exercises the gate.
- Manual: start session, watch DEBUG log. Before setup: `[jarvis] state -> live_opening`
  and no server `sendRealtimeInput` calls. After setup: `[live <sid>] first message — handshake OK`
  then the buffer drains.

## 2. Wake-word recogniser flakiness / InvalidStateError on restart

**Symptom:** Wake word stops responding after ~60s idle or after tab blur;
occasional `DOMException: recognition has already started`.

**Root cause:** `onend` handler called `this.rec.start()` synchronously. Chrome
throws `InvalidStateError` if `start()` races with the end event. Also, the
`not-allowed` / `audio-capture` errors fell through the same restart path and
spun forever.

**Fix (js/wake-word.js):**
- Jittered 150–400ms restart timer (not a synchronous `.start()`).
- Error bucketing: `not-allowed` → permanent stop with `onError`; `audio-capture`
  → soft-fail (user may plug in a mic); generic transient errors → auto-restart.
- Consecutive-error counter: after 8 failures in a row we stand down with a
  clear `onError` instead of looping forever.
- `onstart` resets the counter.

**Verification:** Wake-word log trail visible under DEBUG (`[wake-word] onstart`,
`[wake-word] onend, manualStop=false`, `[wake-word] wake matched: hey jarvis`).

## 3. AudioContext re-suspended on tab background

**Symptom:** User tabs away during a session; on return, Jarvis speaks but no
audio plays.

**Root cause:** Chrome suspends AudioContexts when the tab is hidden. Our
`enqueuePcm24k` does fire-and-forget `resume()`, but the first chunk after
return lands against a still-suspended context and is scheduled at a past
`currentTime`, so subsequent chunks stack up with huge delays.

**Fix (js/audio-pipeline.js):**
- `document.addEventListener('visibilitychange', ...)` resumes both the
  playback and capture AudioContexts when the tab becomes visible again.
- `flushPlayback()` now hard-stops in-flight scheduled sources (not just
  resets `nextStartTime`), preventing stale schedules from queuing up after
  a suspend/resume cycle.

**Verification:** Tab-blur then tab-focus during a speech turn — audio resumes
without gap. Metrics panel (`?debug=1`) shows `ctx=running` post-resume.

## 4. Mic track dies silently (USB sleep / another app grab)

**Symptom:** Mic stops capturing. Wake word and Live mode both go deaf.

**Root cause:** `MediaStreamTrack.ended` event was never listened to.

**Fix (js/audio-pipeline.js):**
- Listen for `track.ended`, `track.mute`, `track.unmute` on the active
  audio track.
- `AudioPipeline` is now an `EventTarget` and dispatches `mic-ended` /
  `mic-hw-mute`. `VoiceAgent` hears the first and transitions to
  `ERROR:mic_ended` with a Retry in the banner.

**Verification:** Unplug / sleep the mic mid-session; state goes to error with
the correct surface.

## 5. Persona / mode switch: in-flight audio keeps playing

**Symptom:** Switching persona while Jarvis was speaking: the old persona's
voice kept coming out for 2–3 seconds from queued chunks, then the new
persona interjected mid-word.

**Root cause:** `session.close()` upstream tore down the WS, but AudioBufferSourceNodes
already scheduled on the client continued to play out.

**Fix:**
- `VoiceAgent.setPersona()` and `setMode()` now call `pipeline.flushPlayback()`
  and `transcript.turnBreak()` before sending the server message.
- `AudioPipeline.flushPlayback()` now actually `stop()`s every source in the
  active set, not just reset `nextStartTime`.

**Verification:** Switch persona during a reply — old voice cuts off instantly,
new session opens cleanly.

## 6. VAD field names (verified correct — NOT a bug)

**Hypothesis:** `silenceDurationMs` vs `silence_duration_ms` field-name
mismatch silently accepted by SDK, falling back to defaults.

**Evidence:** Read `@google/genai@1.50.1` typedefs
(`AutomaticActivityDetection`): fields ARE camelCase `silenceDurationMs`,
`prefixPaddingMs`, `startOfSpeechSensitivity`, `endOfSpeechSensitivity`.
Our config matches. No fix needed.

**But:** We now expose distinct VAD presets for wake-word vs live mode
(`api/gemini-config.js :: VAD_PRESETS`):
- wakeword: silence 700ms, low sensitivity (forgiving of pauses after "Hey Jarvis").
- live: silence 500ms, high sensitivity (snappy turn-taking).

## 7. Reconnect loop infinite

**Symptom:** After network drop: endless reconnect attempts; state stuck
at "reconnecting".

**Root cause:** Counter compared `> delays.length` which was off-by-one.

**Fix:** Explicit `MAX_RECONNECTS = 5` constant with jitter (0.5–1.5× base
delay). After 5 attempts: `ERROR:ws_disconnected` with Retry button, not
another reconnect.

**Verification:** Kill the server mid-session. Client emits five `reconnecting`
states, then `error:ws_disconnected`. Start server and click Retry — fresh
session.

## 8. Session resumption groundwork

**Symptom:** Persona switch or reconnect drops conversation context.

**Fix:** Server now captures `sessionResumptionUpdate.newHandle` and passes
it into subsequent `buildLiveConfig(..., resumptionHandle)` calls when the
reopen reason is "resumable" (explicit client `reconnect` messages). Persona
and mode switches intentionally do NOT reuse the handle because the session
config (voice, VAD) differs.

## 9. Tool-call concurrency with audio

**Hypothesis:** Tool execution > a few hundred ms causes audio gaps.

**Measurement:** Added `[live <sid>] tool_call` log with args + a `tool_result`
log with ok flag. In practice tools resolve in ~50ms (pure DOM ops), well
below the audio schedule horizon. **No observed gap.** Leaving DEBUG logs in
place so any future regression is visible.

## 10. Debug visibility

Added a debug metrics panel in the dock, hidden unless `?debug=1`:
- state, mode, mute, WS state, AudioContext state, frames in/out, tool calls,
  reconnect count, live session elapsed time.

Plus DEBUG-gated console and server logs at every state transition.
