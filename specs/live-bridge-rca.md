# Root cause analysis — "STT gets erased, no audio response"

## Symptom
User reports: "STT text keeps getting ERASED, and there is no audio response at all." Python reference (`GeminiFlashAgentTest/gemini_live_audio.py`) works with the same API key, so the upstream path is healthy. Failure is entirely in our Node/browser layer.

## Investigation

### Hypotheses ranked
1. Node SDK async-iteration vs callback mismatch → **ruled out**. `api/live-bridge.js` lines 213–251 correctly use `callbacks: { onopen, onmessage, onerror, onclose }`.
2. Audio payload not base64 → **ruled out**. Line 455: `audio.toString('base64')`.
3. Transcript delta rendering → **confirmed bug** (see Bug A below).
4. Binary audio framing → **confirmed bug** (see Bug B below).

### Runtime proof of Bug B
```js
// /tmp/ws-binary-proof.js
const ab = new ArrayBuffer(10);
new Int16Array(ab, 1);  // throws RangeError
```
Result:
```
EXPECTED ERROR: RangeError - start offset of Int16Array should be a multiple of 2
```

## Bug A — transcript erasure

Gemini Live streams `inputAudioTranscription` and `outputAudioTranscription` as **deltas**: each `serverContent.inputTranscription.text` is a NEW chunk, not a running total. The server forwarded each delta verbatim to the browser. The browser's `TranscriptLog.updateInterim()` **replaced** the interim row's `textContent` with every delta. Net effect: user sees the line rewrite itself with each fragment ("Hey" → "Jarvis" → "go" → "to" → "pricing"), which looks like erasure.

Cross-reference: canonical `gemini-live-ephemeral-tokens-websocket/frontend/script.js`:
```js
case INPUT_TRANSCRIPTION:
  if (!message.data.finished) {
    addMessage(message.data.text, "user-transcript", (append = true));   // note: append
  }
```
The canonical example **appends**. We overwrote.

Separate contributing cause: the Web Speech API wake-word engine was also emitting interim transcripts for `from: 'user'`, racing against Gemini's interim transcripts on the same row. Two writers, one DOM node, sub-400ms updates — indistinguishable from erasure even with correct delta handling.

## Bug B — no audio playback (proven, reproducible)

The bridge framed outbound audio as `[tag_byte_0x02] + PCM16_bytes`. The client did:
```js
const pcm = new Int16Array(data, 1);   // ← byteOffset = 1
```
`Int16Array(buffer, byteOffset, length)` requires `byteOffset % 2 === 0` by the TypedArray spec. **byteOffset = 1 throws `RangeError` unconditionally.** The exception was swallowed by the `onmessage` handler's implicit try-boundary, so nothing ever reached `enqueuePcm24k()`. Every single audio frame from Gemini was discarded.

Canonical convention (`gemini-live-genai-python-sdk/server.py` + `frontend/main.js`):
- Server → browser binary frames are **raw PCM bytes**. No tag prefix.
- Client handler: `if (typeof event.data === 'string') { JSON } else { playAudio(event.data) }`.
- Inside `playAudio`: `new Int16Array(arrayBuffer)` — offset 0, aligned, works.

## Fix

### 1. Drop binary tag bytes entirely (Bug B)
Binary WS frames are **only ever PCM audio**. Direction is implicit from the socket side. Matches canonical.
- Server → browser: `ws.send(pcmBuffer, { binary: true })` — Buffer directly, no prefix.
- Browser → server: `ws.send(int16.buffer)` — ArrayBuffer, no prefix.
- Server handler: `if (isBinary)` ⇒ treat as 16 kHz PCM from browser.
- Browser handler: `if (data instanceof ArrayBuffer)` ⇒ treat as 24 kHz PCM from server, `new Int16Array(data)` at offset 0.

### 2. Accumulate transcription deltas per turn (Bug A)
Client tracks a per-turn mutable DOM row per role. Each delta APPENDS to the row's textContent. On `turn_complete` or explicit `finished: true`, the row is finalized and future deltas start a new row.

Implementation: rewrite `TranscriptLog` with a simple state-machine:
- `addDelta({from, delta, final})` — appends to the currently-open row for `from`. Opens a row if none exists for this turn.
- `turnBreak()` — closes all open rows so the next delta starts a new row.
- `add({from, text})` — for complete system / tool lines, unchanged behavior.

### 3. Remove Web Speech API as a user-transcript source
Single source of truth per role. Gemini's `inputAudioTranscription` wins for user text. The Web Speech API still serves wake-word detection and logs to `/api/transcript`, but it never writes into the visible transcript panel. Eliminates the race.

### 4. Add DEBUG logging
Server: every `onopen` / `onmessage` / `onclose` / audio forward with byte count / tool call. Gated on `DEBUG=1` env.
Client: every received frame with size and type, every `enqueuePcm24k` call with AudioContext state. Gated on `?debug=1` or `localStorage.setItem('jarvis.debug', '1')`.

### 5. New smoke test — upstream-handshake
Asserts that `ai.live.connect` is called (via log matching) even when the key is invalid. Catches regressions where someone accidentally refactors to async-iteration or removes the SDK call. Does not require a real key.

## What is NOT changed
- SDK config shape (already correct).
- Callback pattern (already correct).
- System prompt (unchanged).
- Tool registry (unchanged).
- AudioPipeline internals (playback graph unchanged).
- Design system (unchanged).

## Verification plan
1. `npm run smoke:invalid-key` — must pass (regression gate).
2. `npm run smoke:upstream-handshake` — new, must pass.
3. Manual E2E with a real key: user should hear voice on the first turn. Server logs (with `DEBUG=1`) must show:
   ```
   [live] upstream connect requested model=gemini-3.1-flash-live-preview
   [live] onopen
   [live] onmessage type=setupComplete
   [live] onmessage type=serverContent
   [live] audio chunk bytes=<N>
   [live] forwarded audio to browser bytes=<N>
   ```
   Browser console (with debug):
   ```
   [audio] received binary frame bytes=<N>
   [audio] ctx.state=running before enqueue
   [audio] scheduled play at offset=<t>
   ```
