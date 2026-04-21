# Call UX — Place Call / End Call

The voice agent is gated behind an explicit Place Call gesture. Nothing
opens on page load — no WebSocket, no microphone, no ambient noise. The
user must click the big green "Place Call" button to start talking to
Jarvis. This produces a real phone-call feel, keeps Chrome's autoplay /
gesture policies happy, and eliminates the cold-start races that
plagued the previous "auto-open on boot" UX.

## Button states (single source of truth)

The voice agent's state machine drives the button's label/color/action
every render:

```
VoiceAgent state        ButtonLabel      Variant      Click action
───────────────────────  ──────────────  ───────────  ────────────────
IDLE                     Place Call      primary      → placeCall()
ARMING (wakeword)        Place Call      primary      → placeCall()
DIALING                  Cancel          danger       → cancelDial()
LIVE_OPENING             Cancel          danger       → cancelDial()
LIVE_READY               End Call        danger       → endCall()
MODEL_THINKING           End Call        danger       → endCall()
MODEL_SPEAKING           End Call        danger       → endCall()
TOOL_EXECUTING           End Call        danger       → endCall()
RECONNECTING             End Call        danger+pulse → endCall()
CLOSING                  Ending…         muted+disabled (noop)
ERROR                    Try Again       primary      → placeCall()
```

CSS classes: `call-btn--place`, `call-btn--end`, `call-btn--cancel`,
`call-btn--reconnect`, `call-btn--closing`. All pure token-based
(no hardcoded hex).

Keyboard: the button is native `<button>`, so Enter and Space fire click.
`M` mutes while in-call. `Esc` closes the Settings sheet.

## placeCall() — the happy path

```
click handler (sync)
  ├─ unlockAudioSync()         create + resume AudioContext (gesture-
  │                            lineage MUST stay alive through this)
  ├─ pipeline.setAmbientOn(true, { fadeMs: 140 })
  │                            user HEARS the "dial tone" immediately
  ├─ _setState(DIALING)
  ├─ _armDialTimer()           15s watchdog → ERROR if no setup_complete
  └─ (await)
      ├─ _openMic()            getUserMedia (prompts permission if first time)
      └─ _connect()             open WS → hello with mode=live
           └─ onopen → hello
                └─ (server) buildLiveConfig → ai.live.connect
                     └─ onmessage(setupComplete)
                          ├─ server forwards { type: "setup_complete" }
                          └─ client _onSetupComplete:
                               ├─ _setState(LIVE_READY)
                               ├─ dispatch `{ type: "call_start", page, title }`
                               │    └─ server wraps in <call_initiated>…</call_initiated>
                               │       and sendClientContent({turnComplete: true})
                               ├─ model greets the user (audio streams back)
                               └─ _armLiveIdleTimer (3min silence → auto-end)
```

## cancelDial() / endCall() / _gracefullyEndCall()

Called from CLOSING state:

```
_setState(CLOSING)
├─ pipeline.setAmbientOn(false, { fadeMs: 300 })   fade ambient out
├─ pipeline.flushPlayback()                         cut any remaining agent audio
├─ _sendJson({ type: "call_end" })                  server closes upstream
├─ _closeMic()                                      mic paused
├─ pipeline.stopCapture()                           mic track released
├─ ws.close()                                       WS released
├─ reset flags (setupComplete, greetingSent, …)
├─ transcript.add("Call ended.")
└─ _setState(IDLE or ARMING if wake-word persisted)
```

The server's `call_end` handler closes the upstream Gemini session but
leaves the browser WS alive — not strictly necessary (the browser just
closed its WS anyway) but explicit, which makes subsequent future
Place Calls on the same browser session possible without any WS churn.

## Greeting injection — exactly once per call

The model needs a prompt to greet the user. Without one it would just
wait for the user's first utterance. We inject a delimited block the
FIRST time `setup_complete` fires after a placeCall:

```
<call_initiated>
The user just placed a call and is now connected. They are on /carriers.html ("Carriers — Dhruv FreightOps").
Greet them ONCE, briefly, in one short sentence — introduce yourself as Jarvis from Dhruv FreightOps and ask how you can help. Start speaking immediately; do not wait for them. Keep your persona. End with a question.
</call_initiated>
```

System-prompt rule #9 teaches the model to respond to this block with
exactly one greeting, in-persona, ending with a question.

Client-side enforcement: `_greetingSent` boolean is set to `true` when
the `call_start` frame is sent. Reset to `false` on `_tearDownCall()`
and `_gracefullyEndCall()`. Mid-call navigation (router's
`handleRouteChange`) does NOT re-trigger it — navigation uses
`<page_context>` instead, rule #8.

Server-side enforcement: the server logs `call_initiated_injected` on
success or `call_start ignored — upstream not ready` if the browser
somehow sends it before setup_complete (shouldn't happen; the client
only sends in `_onSetupComplete`).

## Ambient noise — single-invariant state-machine

**Invariant: ambient ON ⟺ `VoiceAgent.isInCall()` returns true AND the
user hasn't picked noiseMode=off.** One rule. No per-state exceptions.

Concretely, `CALL_ACTIVE_STATES` is:

```
{ DIALING, LIVE_OPENING, LIVE_READY, MODEL_THINKING, MODEL_SPEAKING,
  TOOL_EXECUTING, RECONNECTING }
```

`isInCall()` is the ONE public predicate that wraps membership in this
set. `_updateAmbient()` is the ONE private method that maps the
predicate to `AudioPipeline.setAmbientOn()`. `_setState()` calls
`_updateAmbient()` on every transition — no other code path in the
agent touches ambient directly.

Fade-in on call start = 220 ms. Fade-out on end/error = 300 ms.
Transitions BETWEEN active states ramp at 40 ms (near-instant) because
the target is unchanged — the setTargetAtTime anchor stays at 1 and
the gain stays pinned at 1 the whole time. No pumping, no gaps, no
re-creation of the BufferSource.

`setAmbientOn(true)` lazily starts the noise source if one hasn't been
built yet — for the "Place Call is the user's first gesture" path, the
AudioContext came up in the same tick and no other code has called
`setNoiseMode` yet. `setNoiseMode` is idempotent: if the mode hasn't
changed AND a source is already running, it's a no-op (no click from
stop-restart).

Noise plays through an INDEPENDENT branch (`noiseSource → noiseBusGain
→ noiseEnvelopeGain → ctx.destination`) so it survives agent silence
and isn't coloured by the phone-line bandpass. Muting your mic does
NOT affect ambient — it's the room you're sitting in, not the line
you're talking over.

### Why this replaces the previous "per-state set" approach

The previous implementation kept a separate `AMBIENT_ON_STATES` set
and sprinkled `setAmbientOn` calls across `placeCall`, `_gracefullyEndCall`,
`_tearDownCall`, and `setPersona`. Any new state (or any state the
set didn't explicitly list) silenced the ambient. The user reported
drops during `USER_SPEAKING` / `MODEL_THINKING`. Now there is exactly
one rule, one predicate, one driver.

## Mute mic (call-scoped)

Mute is only meaningful during a call. The mic button is hidden outside
IN_CALL / DIALING / LIVE_OPENING / RECONNECTING states. `setMuted` is a
no-op when not in a call. Mute state is NOT persisted across calls —
each new call starts with muted=false.

## Mode toggle (Place Call vs Wake Word) — settings-only

Mode is now an advanced setting inside the gear overlay, not a primary
control. Wake Word is a niche power-user option; Place Call is the
default path and the only one visible in the primary dock.

- Default mode is `live` (Place Call) unless the user has previously
  explicitly chosen Wake Word.
- `setMode` is a no-op during an active call; user must End Call first.
- iOS Safari: Wake Word is disabled (SpeechRecognition is unreliable);
  UI falls back to `live` silently.

## Reconnection

Network blips mid-call: the client's reconnect ladder (5 tries,
1s/2s/4s/8s/16s with 0.5–1.5× jitter) runs as before. Ambient STAYS ON
during reconnection because the user still perceives the call as live;
the button stays "End Call" with a soft pulse animation. If all 5
retries fail, we emit `ERROR:ws_disconnected` and tear the call down.

## Resumption handle — now only for blips / reloads

The session-resumption handle (`sessionResumption: { handle }`) is still
captured and persisted in `sessionStorage['jarvis.session']`. With the
Place Call UX:

- SPA navigation during a call: NO use for the handle — the WS stays up.
- Network blip: on reconnect we pass the handle so Gemini restores prior
  history. Transparent to the user.
- Full tab reload mid-call: the user re-places a call and we re-attempt
  resumption — they see the prior transcript immediately and the model
  remembers context.
- Persona or mode switch: handle is cleared (config mismatch).

## Wire additions

Client → Server (new):
```
{ type: "call_start",  page: "/carriers.html", title: "Carriers — Dhruv FreightOps" }
{ type: "call_end" }
```

Server → Client: no new frames. Greeting arrives over the normal audio
stream once the model emits it.

## Smoke coverage

- `npm run smoke:cold-start-live` — Place Call wire protocol (single
  upstream, no reconnect churn, defensive audio drop).
- `npm run smoke:greeting-injection` — `call_start` wired and guarded
  when upstream not ready.

## Verification matrix

| Viewport | Place Call visible | Tap ≥ 48 px | Status "Not connected" |
|---|---|---|---|
| 375×812 (iPhone) | yes | 351×56 | yes |
| 768×1024 (tablet) | yes | 306×56 | yes |
| 1280×800 (desktop) | yes | 346×56 | yes |

All verified with Playwright headless.
