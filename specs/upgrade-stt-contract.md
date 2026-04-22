# STT Contract (Frozen)

**Owner:** ai-engineer  
**Audience:** frontend-dev (drop-in replacement for `LocalStt` in `js/voice-agent.js`)  
**Status:** Frozen 2026-04-22. Any change requires a SendMessage sync.

## Modules

| File | Purpose |
|---|---|
| `js/stt-controller.js` | Main-thread driver. Exposes a `SttController` class that is a drop-in replacement for `LocalStt`. |
| `js/stt-worker.js` | Web Worker that runs Whisper `tiny.en` via `@xenova/transformers`. Never imported from the main thread. |
| `js/local-stt.js` | Web Speech API fallback. `LocalStt` class with dedup. Retained as a last-resort. |

## How to wire it (frontend-dev)

Replace the `import { LocalStt }` line in `js/voice-agent.js` with a lazy import inside `_initLocalStt`. The `SttController` is intentionally API-compatible with `LocalStt`, so the surrounding code in `voice-agent.js` does not need to change except to:

1. Lazily import `stt-controller.js` on first `placeCall` (NOT on page load).
2. Feed PCM frames from `AudioPipeline` into `SttController.feedPcm(int16)` after the controller is ready.
3. On `endCall`, call `SttController.stop()`.

```js
// Lazy construct (inside placeCall, before _openMic)
if (!this.sttController) {
  const { SttController } = await import('./stt-controller.js');
  this.sttController = new SttController({
    debug: DEBUG,
    backend: this.flags.sttBackend || 'whisper',
    onPcmMicLevel: () => this.pipeline.readMicLevel()
  });
  // Optional: listen for progress to show a "Preparing captions…" row.
  this.sttController.addEventListener('progress', (ev) => { /* frontend shows download % */ });
  this.sttController.addEventListener('ready',    (ev) => { /* hide placeholder */ });
  this.sttController.addEventListener('error',    (ev) => { /* show retry row */ });
  this.sttController.addEventListener('transcript', (ev) => {
    const { text, finished } = ev.detail;
    this.transcript.addDelta({ from: 'user', delta: text, finished: !!finished });
    if (finished) this._sendJson({ type: 'transcript_event', kind: 'final', text, at: Date.now() });
  });
  await this.sttController.init();   // kicks model download on first call
}
this.sttController.start();
```

Then feed PCM in the existing `_sendAudio(int16)` path — a single call, added AFTER the WS send:

```js
_sendAudio(int16) {
  // existing body (WS send) untouched …
  // NEW:
  if (this.sttController) this.sttController.feedPcm(int16);
}
```

When the call ends or user mutes:
- `setMuted(true)` → `sttController.setMuted(true)`  (suppresses input).
- `endCall()` → `sttController.stop()`               (flushes + resets segment).

## `SttController` API

```ts
class SttController extends EventTarget {
  constructor(opts: {
    debug?: boolean;
    backend?: 'whisper' | 'web-speech';  // default 'whisper'
    onPcmMicLevel?: () => number;         // 0..1, used for VAD gate
    micStream?: MediaStream;              // only needed for Web-Speech fallback
  });

  readonly supported: boolean;            // true if ANY backend is usable in this browser
  readonly backend: 'whisper' | 'web-speech' | 'none';  // resolved at init()

  init(opts?: { acceptLargeDownload?: boolean }): Promise<void>;
    // - For 'whisper': spins up the worker, calls `{type:'init'}`, returns when
    //   `{type:'ready'}` arrives OR when a non-retriable init error is raised.
    // - For 'web-speech': synchronous no-op.
    // - On `saveData === true` or effectiveType 'slow-2g' emits `needs_consent` and
    //   waits until the caller invokes `init({acceptLargeDownload: true})`.

  start(): void;                          // enable partial/final emission
  stop(): void;                           // flush segment + teardown worker events

  feedPcm(pcm: Int16Array): void;         // zero-copy — VAD-gated in controller

  setMuted(muted: boolean): void;         // pauses feedPcm (but keeps model warm)

  destroy(): Promise<void>;               // terminate worker & release
}
```

## Events (via `addEventListener`)

| Type | `detail` shape | When |
|---|---|---|
| `progress` | `{ loaded: number, total: number, stage: 'download'\|'init' }` | During model fetch/init |
| `ready` | `{ backend: 'whisper'\|'web-speech' }` | When ready to accept audio |
| `needs_consent` | `{ size: '40MB' }` | On slow/save-data network |
| `transcript` | `{ text: string, finished: boolean, segmentId: string }` | Partial (finished=false) or final (finished=true) |
| `error` | `{ code: string, message: string, retriable: boolean }` | Non-recoverable error |
| `backend_changed` | `{ from, to, reason }` | Fallback tree switched backends |

### Error codes

| Code | Meaning | Retriable? |
|---|---|---|
| `model_fetch` | HTTP error fetching model weights | yes |
| `worker_crash` | Worker terminated unexpectedly | yes (one auto-restart inside controller; surfaces after that) |
| `webgpu_init` | WebGPU init failed (logged, controller continues with WASM) | no (informational) |
| `wasm_init` | WASM init failed | no |
| `no_backend` | No supported STT in this browser | no |
| `save_data_declined` | User declined the model download | no |

### Dedup contract (NEVER emit repeated phrases)

- Every emission carries a `segmentId` (string). A segment corresponds to one VAD utterance.
- **Partial monotonicity:** within a single `segmentId`, every emitted `partial.text` is a prefix-extension of the prior `partial.text`. Never emit a partial that shrinks or replaces an earlier partial of the same segment (the worker ensures this; the controller double-checks).
- **Final replaces partials:** a `final` for a given `segmentId` replaces all partials for that segment — frontend should replace the last user line instead of appending.
- **Cross-segment dedup:** the controller tracks `lastFinalByHash` (lowercase + whitespace-normalized) and drops a final that exactly matches the previous final. The worker also refuses to emit a final whose trailing 8-word suffix matches the trailing 8-word suffix of the previous final.

The current `TranscriptLog` in `js/stt-logger.js` already coalesces deltas into the last user row — so `addDelta({from:'user', delta:text, finished})` naturally handles the replace-the-last-line pattern. Frontend-dev should use the `segmentId` to disambiguate: when a new segment arrives, call `transcript.turnBreak()` (or the equivalent) before the first partial so the line is fresh.

### VAD gate (implemented in controller)

- The controller reads `opts.onPcmMicLevel()` once per `feedPcm` call.
- If RMS stays below `0.02` for more than **400 ms** continuously, the controller stops forwarding frames to the worker.
- When RMS rises above the threshold, forwarding resumes, and the controller posts a `{type:'vad_resume'}` to the worker so it marks a fresh segment boundary.

### Backend resolution (`init()` logic)

```
if backend === 'web-speech'      → use Web Speech fallback if supported, else 'none'
else if WebGPU available          → 'whisper' (WebGPU device)
else if WASM available            → 'whisper' (WASM device)
else if Web Speech available      → 'web-speech' (degraded; emit backend_changed once)
else                              → 'none'; emit error code 'no_backend'
```

If init for the `whisper` path fails at model-fetch stage, the controller automatically falls back to Web Speech (if supported) and fires `backend_changed`. Frontend-dev MAY show a toast but it's not required.

## Worker message protocol

Controller → worker:
- `{type:'init', deviceHint: 'webgpu'|'wasm'}`
- `{type:'audio', pcm: Int16Array, seq: number}` (transferable: `[pcm.buffer]`)
- `{type:'vad_resume'}`        — marks a fresh segment on the next audio frame.
- `{type:'flush'}`              — force final emission for the current segment.
- `{type:'reset'}`              — clear the ring buffer and segment state.

Worker → controller:
- `{type:'progress', loaded, total, stage}` — during `init`.
- `{type:'ready'}` — after `init`.
- `{type:'partial', text, segmentId}` — best guess, ~every 1.5 s.
- `{type:'final', text, segmentId}` — VAD endpoint or flush.
- `{type:'error', code, message, retriable}` — fatal.

All messages are JSON (plus the transferable `ArrayBuffer` for audio).

## Browser support

| Browser | Primary backend | Fallback | Notes |
|---|---|---|---|
| Chrome 113+ (desktop) | Whisper · WebGPU | Whisper · WASM | Best path. |
| Edge 113+ | Whisper · WebGPU | Whisper · WASM | Best path. |
| Firefox 115+ | Whisper · WASM | — | No WebGPU; WASM threads fine. |
| Safari 17+ (macOS) | Whisper · WASM | — | No WebGPU yet. |
| Safari iOS | Web Speech (degraded) | — | WASM Whisper is too slow on iOS Safari (<2026 hardware); force Web Speech. |
| Any browser with `saveData=true` | (prompt) | Web Speech if declined | Require explicit opt-in. |

## Memory budget

- Idle (worker loaded, no audio): < 70 MB (model weights).
- Active inference: < 250 MB peak.
- Transformers.js caches weights in Cache Storage automatically (key: the model URL). Second placeCall on the same origin is near-instant.

## Performance targets (Oracle)

- p50 partial latency: < 2.0 s from end of audio chunk.
- p95 final latency: < 3.5 s from VAD endpoint.
- Main-thread bundle for `stt-controller.js`: < 5 KB gzipped.
- Worker bundle (excluding transformers.js): < 20 KB gzipped.

## Failure modes → UI states (for frontend-dev)

| Error code | Recommended UI |
|---|---|
| `model_fetch` | System row: "Couldn't download transcription model. Retry?" + retry button that calls `SttController.init({acceptLargeDownload: true})` again. |
| `worker_crash` | System row: "Transcription worker crashed. Continuing without captions." (After one auto-restart attempt by the controller.) |
| `no_backend` | System row: "Transcription unavailable in this browser." Transcript panel shows user lines empty; hint text lives in `voice-transcript-hint`. |
| `save_data_declined` | System row: "Transcription skipped to save data. Enable in settings to download." |
| `needs_consent` | A one-time prompt in the settings sheet: "Download 40 MB transcription model?" Accepting calls `init({acceptLargeDownload: true})`. |

## Privacy guarantees

- 100% on-device. PCM never leaves the browser for STT purposes.
- Whisper weights are fetched from HuggingFace CDN (via transformers.js). A single HTTPS GET per first-use; weights are then cached in the browser's Cache Storage for subsequent sessions.
- Gemini Live audio frames still travel to Google for the VOICE conversation — that's the call. STT is a separate pipeline that never touches Gemini for transcription (verified: `api/gemini-config.js` gates `inputAudioTranscription` behind `GEMINI_TRANSCRIPTION` which stays `false`).

## Feature toggle (for ops)

`/api/config` now exposes `sttBackend: 'whisper' | 'web-speech'`. Env var `STT_BACKEND` on the server sets the default:
- `STT_BACKEND=whisper` (default) → client tries Whisper first, falls back to Web Speech.
- `STT_BACKEND=web-speech` → client skips Whisper entirely (useful for debugging Firefox/Safari fallback path).

`GEMINI_TRANSCRIPTION` is unchanged and stays `false`. Re-confirmed by grepping `api/`.

## README snippet for deploy notes

```
STT pipeline (browser-side, on-device):
 - Default: Whisper tiny.en via @xenova/transformers in a Web Worker.
 - First call downloads ~40 MB once; cached in the browser.
 - Falls back to Web Speech API if Whisper is unavailable or the user declines
   the download on slow/save-data networks.
 - No audio leaves the browser for transcription purposes.

Gemini server-side transcription (inputAudioTranscription / outputAudioTranscription)
is DISABLED by default and not enabled by this upgrade. Keep GEMINI_TRANSCRIPTION=false.

To force the Web Speech fallback (e.g. for debugging or compatibility):
  STT_BACKEND=web-speech
```
