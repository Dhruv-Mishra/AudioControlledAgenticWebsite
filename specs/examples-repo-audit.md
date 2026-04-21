# Examples-Repo Audit

Cross-reference of our `HappyRobotFreightOps` implementation against the official
Gemini Live examples at https://github.com/google-gemini/gemini-live-api-examples.

Sources inspected (all at `main` as of 2026-04-21):

| Source | Role |
|---|---|
| `command-line/node/main.mts` | **Canonical Node.js SDK pattern.** Most relevant to our `api/live-bridge.js`. |
| `command-line/node/package.json` | Pins `@google/genai ^1.43.0` (we pin `^1.50.1` — same major). |
| `gemini-live-genai-python-sdk/gemini_live.py` | Canonical server-proxy pattern (Python, but same SDK config shape). |
| `gemini-live-genai-python-sdk/main.py` | FastAPI WebSocket proxy — our architectural twin. |
| `gemini-live-genai-python-sdk/frontend/main.js` | Browser-side client to server-proxy. |
| `gemini-live-genai-python-sdk/frontend/media-handler.js` | Browser audio capture + playback (Pattern B: main-thread resample). |
| `gemini-live-genai-python-sdk/frontend/pcm-processor.js` | Minimal capture worklet (buffers floats, posts to main thread). |
| `gemini-live-ephemeral-tokens-websocket/frontend/geminilive.js` | Raw-WS browser client (direct-to-Gemini with ephemeral tokens). |
| `gemini-live-ephemeral-tokens-websocket/frontend/mediaUtils.js` | Alternative audio streamer (Pattern A: AudioContext forced to 16 kHz). |
| `gemini-live-ephemeral-tokens-websocket/frontend/audio-processors/{capture,playback}.worklet.js` | Worklet-side buffering + playback at fixed rates. |
| `gemini-live-ephemeral-tokens-websocket/frontend/script.js` | Tool-call round-trip pattern. |
| `gemini-live-ephemeral-tokens-websocket/server.py` | Token minting, not WS bridging. |

---

## 1. SDK usage

**Examples repo says:**
- Node constructor: `const ai = new GoogleGenAI({})` (picks up `GEMINI_API_KEY` env).
- `const session = await ai.live.connect({ model, config, callbacks: { onopen, onmessage, onerror, onclose } })`.
- `session.sendRealtimeInput({ audio: { data: base64, mimeType: "audio/pcm;rate=16000" } })`.
- Python analogue uses `types.FunctionResponse(name, id, response={"result": result})` — the JS analogue is `session.sendToolResponse({ functionResponses: [{ id, name, response: { result } }] })`.

**Our code** (`api/live-bridge.js`, `api/gemini-config.js`):
- `new GoogleGenAI({ apiKey })` — explicit. ✓
- `await genai.live.connect({ model, config, callbacks: { onopen, onmessage, onerror, onclose } })` — identical. ✓
- `upstream.sendRealtimeInput({ audio: { data: audio.toString('base64'), mimeType: 'audio/pcm;rate=16000' } })` — identical. ✓
- `upstream.sendToolResponse({ functionResponses: [{ id, name, response: payload }] })` — same call, but payload shape diverged (see §4).

**Action: keep.** SDK usage is 1:1 aligned. No fix.

---

## 2. Config shape

**Examples repo (composite: canonical Node example + Python SDK example):**
```js
// command-line/node/main.mts (minimal)
const config = {
  responseModalities: [Modality.AUDIO],
  systemInstruction: "You are a helpful and friendly AI assistant.",
};
```
```py
# gemini-live-genai-python-sdk/gemini_live.py (production-ish)
config = LiveConnectConfig(
  response_modalities=[Modality.AUDIO],
  speech_config=SpeechConfig(voice_config=VoiceConfig(
    prebuilt_voice_config=PrebuiltVoiceConfig(voice_name="Puck"))),
  system_instruction=Content(parts=[Part(text=...)]),
  input_audio_transcription=AudioTranscriptionConfig(),
  output_audio_transcription=AudioTranscriptionConfig(),
  realtime_input_config=RealtimeInputConfig(turn_coverage="TURN_INCLUDES_ONLY_ACTIVITY"),
  tools=self.tools,
)
```

**Our code** (`api/gemini-config.js :: buildLiveConfig`):
```js
{
  responseModalities: ['AUDIO'],
  speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
  systemInstruction: { parts: [{ text: systemInstruction }] },
  thinkingConfig: { thinkingLevel: 'MINIMAL' },
  contextWindowCompression: { slidingWindow: {}, triggerTokens: '80000' },
  realtimeInputConfig: {
    automaticActivityDetection: { silenceDurationMs: 700, prefixPaddingMs: 20 }
  },
  inputAudioTranscription: {},
  outputAudioTranscription: {},
  tools: [{ functionDeclarations }],
}
```

Per-field verdict:
| Field | Examples repo | Ours | Verdict |
|---|---|---|---|
| `responseModalities` | `[Modality.AUDIO]` (enum) | `['AUDIO']` (string) | **Keep.** `Modality.AUDIO === 'AUDIO'` in the SDK (verified in `genai.d.ts`). Functionally identical. |
| `speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName` | same (camelCase in JS) | identical | **Keep.** ✓ |
| `systemInstruction` | `{ parts: [{ text }] }` | identical | **Keep.** ✓ |
| `thinkingConfig.thinkingLevel` | **not set** in either example | `'MINIMAL'` | **Keep.** Valid optional field on `gemini-3.1-flash-live-preview` (per our SDK inspection). Lowers latency. Not wrong. |
| `contextWindowCompression` | **not set** in either example | `{ slidingWindow: {}, triggerTokens: '80000' }` | **Keep.** User's Python prototype sets this explicitly (see `gemini_live_audio.py`). Valid optional field. |
| `realtimeInputConfig.automaticActivityDetection` | default in examples | `silenceDurationMs 700, prefixPaddingMs 20` | **Keep.** Matches user's prototype; tuned for dispatcher-style quick turns. |
| `realtimeInputConfig.turnCoverage` | canonical sets `TURN_INCLUDES_ONLY_ACTIVITY` | **unset** | **Keep (documented).** Default is `TURN_INCLUDES_ONLY_ACTIVITY` per the SDK; we'd get the same behavior. Could set explicitly for clarity. |
| `inputAudioTranscription` / `outputAudioTranscription` | `AudioTranscriptionConfig()` (empty) | `{}` (JS equivalent empty object) | **Keep.** ✓ |
| `tools: [{ functionDeclarations }]` | identical | identical | **Keep.** ✓ |

**Action: keep.** All field names and nesting match the canonical pattern. The two extra knobs we set (`thinkingConfig`, `contextWindowCompression`) come from the user's own prototype and are documented optional SDK fields — not blockers.

---

## 3. Audio framing

**Examples repo:**
- **Node canonical** (`command-line/node/main.mts`): mic at 16 kHz → `session.sendRealtimeInput({ audio: { data: base64, mimeType: "audio/pcm;rate=16000" } })`. **Rate in MIME is required.**
- **Browser canonical** (`gemini-live-ephemeral-tokens-websocket/frontend/geminilive.js`): `sendAudioMessage(base64)` → `sendRealtimeInputMessage(base64, "audio/pcm")` — **no rate**. But that is because the WS setup already established 16 kHz via the session setup; we're looking at the raw-WS protocol level, not the SDK level.
- **Python SDK** (`gemini_live.py`): `Blob(data=chunk, mime_type=f"audio/pcm;rate={self.input_sample_rate}")` — **rate included**.
- **Input:** mono, int16 little-endian, 16 kHz, chunks ~20–40 ms (the capture worklet in `audio-processors/capture.worklet.js` buffers 512 float samples = 32 ms at 16 kHz).
- **Output:** mono, int16 little-endian, 24 kHz PCM, decoded from `part.inlineData.data` (base64).

**Our code** (`api/live-bridge.js`, `js/audio-worklets/pcm-capture.js`):
- Upstream call: `{ audio: { data: audio.toString('base64'), mimeType: 'audio/pcm;rate=16000' } }` — matches canonical SDK usage. ✓
- Capture worklet emits 40 ms frames of int16 at 16 kHz (downsampled from the AudioContext's 48 kHz via linear interp) — falls within the 20–40 ms recommended window. ✓
- Playback: `audioContext.createBuffer(1, n, 24000)` + scheduled `source.start(nextStartTime)` — identical to `media-handler.js` line-for-line. ✓

**Action: keep.** MIME string matches the canonical SDK pattern. Chunk size is in the recommended window. Sample rates and PCM encoding are byte-for-byte identical.

**Suggestion (not applied):** The ephemeral-tokens example takes **Pattern A** — force `AudioContext({ sampleRate: 16000 })` so no resampling is needed. Simpler and avoids any aliasing / quality loss from our linear-interp downsampler. Our Pattern B (resample in worklet) is closer to the genai-python-sdk example, works fine, and keeps the capture context decoupled from the playback context (which we need at 48 kHz for the procedural noise + phone-line WaveShaper graph to sound right). **Do not flip to Pattern A** — it would force the capture context to 16 kHz, which is fine, but won't interact with the playback graph and already isn't. Net-net: leaving both contexts as-is is correct.

---

## 4. Tool-call handling

**Examples repo:**
- Incoming tool call on `serverContent`-less message: `message.toolCall.functionCalls[]` where each has `{ name, id, args }`. Cross-references `server_content` and `tool_call` as **independent top-level fields**.
- Cancellation: `message.toolCallCancellation.ids[]`.
- Response shape (browser `script.js`):
  ```js
  {
    id: functionCallId,
    name: functionName,
    response: { result: result ?? "ok" }     // success path
  }
  // or on error:
  { id, name, response: { error: err.message } }
  ```
  The Python SDK example uses `response={"result": result}` — **no `ok` or `error` key when the call succeeds**. Errors are reported inside the result string (`result = f"Error: {e}"`).
- `session.sendToolResponse({ functionResponses: [...] })` — one call per model turn, batch all function responses.

**Our code** (`api/live-bridge.js`):
- Reading tool calls: `msg.toolCall.functionCalls[]` with `{ name, id, args }` — identical. ✓
- Handling cancellations: `msg.toolCallCancellation.ids[]` — ✓.
- Sending response shape:
  ```js
  {
    id, name,
    response: { ok, result, error }  // our custom schema
  }
  ```

**Divergence:** we send an `{ ok, result, error }` object. The canonical pattern is `{ result }` on success, `{ error }` on failure.

Why it matters: the Gemini model has seen the canonical pattern during pre-training — when it encounters `ok: false` plus `error: "..."`, it may parse either shape, but it absolutely knows `{ error: "..." }` means failure. Aligning saves tokens (one fewer key on every response) and de-risks any tooling that reads the transcript later.

**Action: FIX.** Align our outgoing `FunctionResponse.response` to the canonical shape: `{ result: <success value> }` on ok, `{ error: <msg> }` on failure. Client-side `tool_result` envelope keeps its `ok/result/error` keys (internal contract between browser and server), but the server → Gemini payload gets normalised.

---

## 5. Session lifecycle

**Examples repo:**
- `onopen`: connection established. SDK's `connect()` promise resolves here.
- First server message: `setupComplete` (empty payload). Examples log it and move on.
- Normal turns: `serverContent.modelTurn.parts[]` + `inputTranscription` + `outputTranscription` + `interrupted` + `turnComplete` — **all checked independently in one message** (not else-if chain). The raw-WS `geminilive.js` explicitly comments: `// Audio data AND transcription can coexist in the same message`.
- `goAway`: warning logged; canonical does not auto-reconnect.
- `sessionResumptionUpdate`: logged only in canonical; not wired into a reconnect handle.
- Close: `session.close()` on shutdown; no explicit graceful-close handshake.
- Error classification: canonical just logs; doesn't bucket errors into user-facing codes.

**Our code** (`api/live-bridge.js`):
- `onopen` → emits `connecting` until first real message, THEN moves to `listening`. (Fixed in the first review pass; correct vs canonical "log and move on" — we also track `upstreamEverProducedData` so a close-before-data-arrives becomes `invalid_key`. That's strictly richer.)
- Independent-field parsing on `serverContent`: identical pattern, matches `parseResponseMessages` in `geminilive.js`. ✓
- `goAway` → emits `'reconnecting'` state (we don't implement reconnect yet; UI surfaces it). ✓ richer-than-canonical.
- `sessionResumptionUpdate`: **not handled.** We don't pass `sessionResumption` in the config. This matches the canonical examples (they don't use it either).
- Close: browser WS close → we call `upstream.close()`. Persona switch → close + reopen. ✓
- Error classification: our `isErrorEphemeral()` buckets into `invalid_key`, `model_unavailable`, `rate_limited`, `refusal`, `network`, `upstream_error` — richer than canonical.

**Action: keep.** Our lifecycle is a strict superset of the canonical pattern. No fix.

**Suggestion (not applied):** session resumption (`sessionResumption: { handle, transparent: true }`) would let conversations span page navigations. Worth adding as a follow-up — noted in README under "Known limitations." The canonical examples don't demonstrate it.

---

## 6. Browser architecture

**Examples repo offers two patterns:**

- **(A) Server-proxy** (`gemini-live-genai-python-sdk`): Browser ⇄ our server (WS) ⇄ Gemini Live (WS via SDK). API key lives on the server.
- **(B) Ephemeral tokens + direct** (`gemini-live-ephemeral-tokens-websocket`): Browser → our server's `/api/token` (POST) → mints short-lived token. Browser opens its own WS to `generativelanguage.googleapis.com` using that token. Zero-latency data plane; server only mints tokens.

**Our code:** Pattern A (server-proxy). Identical architecture to the `gemini-live-genai-python-sdk` reference.

**Action: keep.** Pattern A is explicitly documented in the repo as the server-proxy choice and is architecturally identical to our bridge. Pattern B trades one fewer hop for a token-minting endpoint and ships the SDK (or raw-WS client) to the browser — already documented as a future upgrade in our README.

---

## 7. Misc findings

- **Model pin**: canonical (`command-line/node/main.mts` + `gemini-live-genai-python-sdk/main.py`) both default to `gemini-3.1-flash-live-preview`. Identical to ours. ✓
- **Voice default**: canonical defaults to `"Puck"` (browser) or `"Puck"` (Python SDK); ours defaults to `"Kore"` for the Professional persona. Purely stylistic; both are documented prebuilt voices.
- **`sendText` vs `sendClientContent`**: the `main.js` browser example sends text via `geminiClient.sendText(text)` → raw `{ text: "..." }` JSON frame → the Python server turns it into `session.send_realtime_input(text=...)`. That's equivalent to our SDK's `session.sendRealtimeInput({ text })` **or** `session.sendClientContent({ turns: [...] })`. We do **not** expose a text-input channel in our UI (voice-first demo), so no call-site to align. Not an issue.
- **`audioStreamEnd: true`** on PTT release: canonical doesn't demonstrate this (their examples use VAD end-of-speech detection). We send it to force deterministic turn-end on PTT release. Documented as valid in the SDK types (`LiveClientRealtimeInput.audioStreamEnd`). Keeps.
- **ErrorEvent.code / CloseEvent.reason on the onclose callback**: canonical's `onclose: (e) => console.log('Closed:', e.reason)` — they read `.reason`. We read both `evt.code` and `evt.reason`. ✓

---

## Summary

**Critical fixes to apply:**
1. **Tool response payload shape** — switch from `{ ok, result, error }` to canonical `{ result }` / `{ error }` on the Gemini-facing side (internal client ↔ server envelope keeps its schema).

**Deliberate non-changes (documented above):**
- `responseModalities: ['AUDIO']` string vs `Modality.AUDIO` enum — identical at runtime.
- Extra `thinkingConfig` / `contextWindowCompression` fields — valid SDK options, not present in canonical but match the user's prototype.
- Binary-frame tagging (`0x01`/`0x02`) vs canonical raw-binary-is-audio — ours is explicit about direction; no functional loss.
- Audio Pattern B (main-thread resample) vs Pattern A (16 kHz AudioContext) — both are in the examples repo. Ours is compatible with our playback graph (which needs 48 kHz for the noise + phone-line chain).
- Session resumption — not demonstrated in canonical; noted as a future upgrade.
- Pattern A (server-proxy) vs Pattern B (ephemeral tokens) — ours matches the canonical server-proxy example; ephemeral tokens noted as a future upgrade.
