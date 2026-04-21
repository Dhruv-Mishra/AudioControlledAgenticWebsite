# Oracle Spec

## Decision 1: Demo scenario

### Recommendation
**HappyRobot FreightOps** — a mock freight dispatch & carrier-relations portal. The agent is "Jarvis," a dispatch co-pilot on a call-center seat. Three pages:

1. **Dispatch Board** (`/`) — live table of in-transit loads, a map panel placeholder, quick-action toolbar ("Assign carrier", "Request status update", "Escalate"). Filters, search, row click-through.
2. **Carrier Directory** (`/carriers.html`) — searchable list of carriers (name, MC number, lanes, rating, availability). Detail cards, contact buttons.
3. **Rate Negotiation** (`/negotiate.html`) — active quote form (pickup, dropoff, commodity, weight, target rate, counter rate) with submit/counter/accept controls, a live "conversation log" that the agent writes into as it negotiates.

Plus a secondary **Contact / Support** (`/contact.html`) to exercise fill/submit tool-calls.

### Rationale
HappyRobot's named verticals (https://www.happyrobot.ai): **negotiation, dispatch, customer service**. This scenario checks all three in one artefact:
- Dispatch Board = dispatch workflow
- Rate Negotiation = negotiation (their flagship demo)
- Contact / Support = CS/ticketing
- Carrier Directory = realistic data surface for tool-call "lookup" behaviour

The mock is specific (not Lorem Ipsum), feels like software a dispatcher would actually have open, and gives the voice agent meaningful actions to take. A hiring team at HappyRobot will immediately recognise the positioning.

### Rejected alternatives
- **Generic portfolio site (About/Projects/Contact)**: Does not speak HappyRobot's language. Rejected.
- **Customer-support-only (tickets UI)**: Too narrow; negotiation is HappyRobot's most-quoted use case.
- **Retail checkout demo**: Off-brand; they don't sell there.

### Implementation notes
- All data is static JSON in `data/*.json`, loaded by the client. No backend DB needed for the demo.
- Every interactive element gets a `data-agent-id` in the shape `page.region.element` (e.g. `dispatch.filters.status`, `negotiate.form.target_rate`).
- The "submit quote" and "assign carrier" tool calls mutate local JSON state held on the page, surfacing optimistic UI changes and returning a structured result the model can read back.

---

## Decision 2: Audio pipeline topology

### Recommendation
- **Wire format between browser and Node:** raw PCM 16 kHz mono int16 carried inside binary WebSocket frames. **Do NOT compress with Opus**. The compression savings (speech at 16 kHz ≈ 256 kbit/s raw vs. 24 kbit/s opus ≈ 10×) are outweighed by (a) Opus encoder in the browser going through `MediaRecorder` gives you chunks of webm-muxed audio, which needs de-muxing server-side before it can be decoded, (b) no pure-JS Node Opus decoder is maintenance-clean in 2026, and (c) Gemini Live requires raw PCM at 16 kHz anyway. 256 kbit/s is trivially sustainable on LAN/Wi-Fi and Chrome LAN-loopback dev.
- **Hand-off server → Gemini:** Node opens a single upstream `ai.live.connect({...})` per browser session. Browser sends a binary PCM frame → server re-encodes to base64 Blob → `session.sendRealtimeInput({ audio: { data, mimeType: 'audio/pcm;rate=16000' } })`.
- **Wake word location:** **client-side**. Run a lightweight STT (Web Speech API `SpeechRecognition`) to detect "Hey Jarvis" locally. No audio flows to the server while idle. Push-to-talk button bypasses wake word.
- **Noise mixing location:** **inbound (playback side)**. The agent's 24 kHz reply is decoded to an AudioBuffer; before playback we mix in an ambient loop + optional compression/bandpass so the user hears a "noisy call." Outbound audio stays clean so Gemini's STT/VAD performs best. Provide a "Realistic call mode" toggle that also injects noise outbound.
- **Parallel STT:** Use the same `SpeechRecognition` instance that handles wake word to also log interim+final transcripts to a client-side log and POST them to `/api/transcript` for server-side logging. This gives us a text fallback channel for free.

### Rationale
Minimises moving parts. No Opus toolchain on server. Single STT engine handles wake word + transcript. Noise on playback side only is honest — the model never hears garbage.

### Rejected alternatives
- **Opus-encoded upstream**: rejected as noted above (toolchain pain).
- **Server-side wake word (send audio always, server gates Gemini)**: wastes upstream bandwidth and gives the user no battery/privacy upside. Rejected.
- **Porcupine / Picovoice WASM wake word**: better accuracy but requires a key (per CLAUDE.md-style restriction: no third-party keys without sign-off) and complicates the demo setup. Rejected; flagged as a future upgrade path.

### Implementation notes
- `AudioWorkletProcessor` downsamples from whatever the AudioContext gives us (typically 48 kHz) to 16 kHz. No `ScriptProcessorNode`.
- WebSocket binary messages for audio. Control messages (tool responses, persona-switch, etc.) are JSON text frames. Simple tag byte at frame[0]: `0x01 = audio`, or use path/subprotocol separation. Chose: JSON envelope for control, binary-prefixed-with-single-byte-tag for audio chunks so they share one socket.
- Server `/api/live` WS per-IP rate limit: max 1 concurrent upstream Gemini session per IP, 60 new sessions per hour per IP.

---

## Decision 3: Model pin location

### Recommendation
Single constant `LIVE_MODEL_ID` in `api/gemini-config.js` (server) re-exported as build-time JSON at `/api/config` for the client to display. User-requested model: `gemini-3.1-flash-live-preview`. If the Gemini endpoint rejects this, document a fallback to `gemini-live-2.5-flash-preview` (SDK-example-known value) in the error handler.

### Rationale
Per CLAUDE.md: pin the model ID in one place. Future upgrades are a one-line change.

---

## Decision 4: Key management

### Recommendation
- `GEMINI_API_KEY` lives in `.env` on the server, loaded via `dotenv` (or `process.env` directly).
- **Ephemeral tokens: not used in v1.** The browser talks to our Node WS; Node talks to Gemini. Ephemeral tokens would let the browser talk to Gemini directly (lower latency) but require us to expose a token-mint endpoint and ship the SDK to the browser. v1's server-proxy model is strictly safer for an API key we haven't rotated yet.
- Ship `.env.example` with `GEMINI_API_KEY=your_key_here` and instructions in README.
