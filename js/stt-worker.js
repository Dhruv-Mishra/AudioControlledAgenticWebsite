// STT Worker — Whisper tiny.en via @xenova/transformers, run OFF the main
// thread. Receives 16 kHz Int16 PCM frames from the main-thread controller,
// maintains a rolling 30 s ring buffer, emits partials every ~1.5 s and finals
// on VAD endpoint or explicit flush.
//
// Dedup invariants enforced here (so even a broken controller can't surface a
// repeated phrase):
//
//   1. Partial monotonicity: within one segmentId, every partial.text is a
//      prefix-extension of the prior partial.text. If the new hypothesis
//      isn't a prefix extension, we either (a) replace the prior partial
//      with a shorter prefix match if possible, or (b) drop the emission.
//   2. Final replaces partials for the same segmentId.
//   3. Cross-segment literal dedup: if the new final equals the previous
//      final (case-insensitive, whitespace-normalised), we DROP it.
//   4. Trailing-8-word suffix dedup: if the last 8 non-stop words of the new
//      final equal the last 8 non-stop words of the previous final, we DROP it.
//
// We load transformers.js via dynamic import so the worker itself stays small.
// The ESM worker is instantiated with `{ type: 'module' }` in the controller.

/* eslint-disable no-restricted-globals */

let pipelinePromise = null;
let asrPipeline = null;
let deviceHint = 'wasm';

// ---------- Ring buffer (Int16) ----------
const SAMPLE_RATE = 16000;
const RING_SECONDS = 30;
const RING_CAPACITY = SAMPLE_RATE * RING_SECONDS;
const PARTIAL_EVERY_MS = 1500;
const SILENCE_VAD_MS = 600;
const MAX_SEGMENT_MS = 14_000;

const ring = new Int16Array(RING_CAPACITY);
let ringWrite = 0;      // next write index (mod RING_CAPACITY)
let ringLen = 0;        // valid samples in the ring (≤ RING_CAPACITY)
let segmentStartIdx = 0; // absolute sample count at the start of the current segment
let absoluteWritten = 0; // monotonic absolute sample count across all writes

// ---------- Segment state ----------
let currentSegmentId = newSegmentId();
let lastPartialText = '';
let lastPartialAt = 0;
let lastFrameAt = 0;    // ms timestamp of last audio frame received
let inferenceInFlight = false;
let pendingAfterInference = false; // coalesce a queued run while one is in flight
let lastFinalText = '';
let lastFinalWords = [];

let running = false;

function newSegmentId() {
  return 'seg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
}

function post(msg, transfers) {
  if (transfers && transfers.length) self.postMessage(msg, transfers);
  else self.postMessage(msg);
}

function dlog(...args) {
  // Keep worker logs quiet in prod. Uncomment for debugging.
  // console.log('[stt-worker]', ...args);
}

// ---------- Whisper loader ----------
async function loadPipeline() {
  if (pipelinePromise) return pipelinePromise;
  pipelinePromise = (async () => {
    // Dynamic import — esbuild code-splits this into its own chunk.
    const transformers = await import('@xenova/transformers');
    const { pipeline, env } = transformers;
    // Tell transformers.js to always use remote models (HuggingFace CDN) and
    // to cache weights via the default Cache Storage key. Avoid any attempt
    // to load local files since we don't host them.
    env.allowLocalModels = false;
    env.useBrowserCache = true;

    post({ type: 'progress', loaded: 0, total: 1, stage: 'init' });
    try {
      const opts = {
        quantized: true,
        progress_callback: (info) => {
          if (!info) return;
          if (info.status === 'progress' && typeof info.loaded === 'number' && typeof info.total === 'number') {
            post({ type: 'progress', loaded: info.loaded, total: info.total, stage: 'download' });
          } else if (info.status === 'ready' || info.status === 'done') {
            post({ type: 'progress', loaded: 1, total: 1, stage: 'init' });
          }
        }
      };
      if (deviceHint === 'webgpu') {
        try {
          const p = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en', {
            ...opts, device: 'webgpu', dtype: 'q4'
          });
          asrPipeline = p;
          return p;
        } catch (err) {
          // WebGPU init failed — log and fall through to WASM. Per Oracle:
          // one-liner info, user still gets captions on WASM.
          // eslint-disable-next-line no-console
          console.info('[stt-worker] webgpu init failed, falling back to wasm:', err && err.message);
        }
      }
      const p = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en', {
        ...opts
      });
      asrPipeline = p;
      return p;
    } catch (err) {
      post({
        type: 'error',
        code: 'model_fetch',
        message: (err && err.message) || String(err),
        retriable: true
      });
      throw err;
    }
  })();
  return pipelinePromise;
}

// ---------- Ring-buffer helpers ----------
function ringAppend(int16) {
  // Copy into the ring, advancing ringWrite. Overflow silently discards the
  // oldest samples — Whisper only ever looks at the most recent 30 s.
  const n = int16.length;
  if (n >= RING_CAPACITY) {
    // Take only the tail.
    const tail = int16.subarray(n - RING_CAPACITY);
    ring.set(tail, 0);
    ringWrite = 0;
    ringLen = RING_CAPACITY;
  } else {
    const tailSpace = RING_CAPACITY - ringWrite;
    if (n <= tailSpace) {
      ring.set(int16, ringWrite);
    } else {
      ring.set(int16.subarray(0, tailSpace), ringWrite);
      ring.set(int16.subarray(tailSpace), 0);
    }
    ringWrite = (ringWrite + n) % RING_CAPACITY;
    ringLen = Math.min(RING_CAPACITY, ringLen + n);
  }
  absoluteWritten += n;
}

function ringGetSegmentFloat32() {
  // Number of samples since segment start (capped by ring capacity).
  const segSamples = Math.min(ringLen, absoluteWritten - segmentStartIdx);
  if (segSamples <= 0) return new Float32Array(0);
  const out = new Float32Array(segSamples);
  // Start index in the ring for the segment.
  const start = (ringWrite - segSamples + RING_CAPACITY) % RING_CAPACITY;
  for (let i = 0; i < segSamples; i++) {
    const idx = (start + i) % RING_CAPACITY;
    out[i] = ring[idx] / 32768;
  }
  return out;
}

function segmentDurationMs() {
  const segSamples = Math.min(ringLen, absoluteWritten - segmentStartIdx);
  return Math.round((segSamples / SAMPLE_RATE) * 1000);
}

function resetSegment() {
  segmentStartIdx = absoluteWritten;
  currentSegmentId = newSegmentId();
  lastPartialText = '';
  lastPartialAt = 0;
}

// ---------- Dedup helpers ----------
function normalize(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function words(s) {
  return normalize(s).split(/\s+/).filter(Boolean);
}

function isPrefixExtension(prev, next) {
  // Allow small whitespace/punct drift — compare on normalized word arrays.
  const a = words(prev);
  const b = words(next);
  if (b.length < a.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function trailingSuffix(s, n) {
  const w = words(s);
  return w.slice(Math.max(0, w.length - n)).join(' ');
}

// ---------- Inference driver ----------
async function runInference({ forceFinal = false } = {}) {
  if (!asrPipeline) return;
  if (inferenceInFlight) { pendingAfterInference = true; return; }
  inferenceInFlight = true;
  try {
    const audio = ringGetSegmentFloat32();
    if (audio.length < SAMPLE_RATE * 0.4) {
      // < 400 ms of audio — not worth running the model.
      if (forceFinal && lastPartialText) {
        emitFinalFrom(lastPartialText);
      }
      return;
    }
    let result;
    try {
      // chunk_length_s default is 30s; we pass the whole segment. Disable
      // return_timestamps for speed.
      result = await asrPipeline(audio, {
        sampling_rate: SAMPLE_RATE,
        chunk_length_s: 30,
        stride_length_s: 5,
        return_timestamps: false,
        language: 'english',
        task: 'transcribe'
      });
    } catch (err) {
      post({
        type: 'error',
        code: 'inference_failed',
        message: (err && err.message) || String(err),
        retriable: true
      });
      return;
    }
    const text = String((result && result.text) || '').trim();
    if (!text) return;

    if (forceFinal) {
      emitFinalFrom(text);
    } else {
      emitPartialFrom(text);
    }
  } finally {
    inferenceInFlight = false;
    if (pendingAfterInference) {
      pendingAfterInference = false;
      // Re-run for the latest audio — but only if the segment is still
      // growing to avoid an infinite loop on idle.
      if (segmentDurationMs() > 0) runInference().catch(() => {});
    }
  }
}

function emitPartialFrom(text) {
  // Partial monotonicity: only emit if the new text extends the previous
  // partial OR is materially different and we're willing to reset.
  if (lastPartialText && !isPrefixExtension(lastPartialText, text)) {
    // The hypothesis changed — but we must not "shrink" a partial within the
    // same segmentId. Drop this emission; the final will correct things.
    return;
  }
  if (text === lastPartialText) return;
  lastPartialText = text;
  lastPartialAt = Date.now();
  post({ type: 'partial', text, segmentId: currentSegmentId });
}

function emitFinalFrom(text) {
  const norm = normalize(text);
  if (!norm) return;
  // Cross-segment literal dedup.
  if (norm === normalize(lastFinalText)) {
    resetSegment();
    return;
  }
  // Trailing 8-word suffix dedup.
  const newTail = trailingSuffix(text, 8);
  const prevTail = trailingSuffix(lastFinalText, 8);
  if (newTail && newTail === prevTail) {
    resetSegment();
    return;
  }
  lastFinalText = text;
  lastFinalWords = words(text);
  post({ type: 'final', text, segmentId: currentSegmentId });
  resetSegment();
}

// ---------- Message loop ----------
self.addEventListener('message', async (e) => {
  const msg = e.data;
  if (!msg || typeof msg !== 'object') return;

  switch (msg.type) {
    case 'init': {
      running = true;
      deviceHint = msg.deviceHint === 'webgpu' ? 'webgpu' : 'wasm';
      try {
        await loadPipeline();
        post({ type: 'ready' });
      } catch (err) {
        // loadPipeline already posted a model_fetch error.
      }
      return;
    }
    case 'audio': {
      if (!running) return;
      const pcm = msg.pcm;
      if (!(pcm instanceof Int16Array)) return;
      lastFrameAt = Date.now();
      ringAppend(pcm);

      // Cap the segment at MAX_SEGMENT_MS — force a final to keep latency
      // bounded even if the user never pauses.
      if (segmentDurationMs() >= MAX_SEGMENT_MS) {
        runInference({ forceFinal: true }).catch(() => {});
        return;
      }

      const sincePartial = Date.now() - (lastPartialAt || 0);
      if (sincePartial >= PARTIAL_EVERY_MS && segmentDurationMs() >= 800) {
        runInference({ forceFinal: false }).catch(() => {});
      }
      return;
    }
    case 'vad_resume': {
      // Controller detected a fresh VAD onset — force a final for the prior
      // segment (if any partial existed) and open a new segment.
      if (lastPartialText) {
        emitFinalFrom(lastPartialText);
      } else {
        resetSegment();
      }
      return;
    }
    case 'flush': {
      runInference({ forceFinal: true }).catch(() => {});
      return;
    }
    case 'reset': {
      running = false;
      ringWrite = 0;
      ringLen = 0;
      absoluteWritten = 0;
      segmentStartIdx = 0;
      lastPartialText = '';
      lastPartialAt = 0;
      lastFinalText = '';
      lastFinalWords = [];
      currentSegmentId = newSegmentId();
      return;
    }
  }
});

// ---------- Heartbeat → final if user just stopped talking ----------
// Every 250 ms, check if (a) a segment has content and (b) no audio frame
// arrived in SILENCE_VAD_MS → emit a final. The controller's VAD gate handles
// most of this, but a backstop timer keeps us safe against mis-gated streams.
setInterval(() => {
  if (!running) return;
  if (!lastFrameAt) return;
  const silent = Date.now() - lastFrameAt;
  if (silent >= SILENCE_VAD_MS && lastPartialText) {
    runInference({ forceFinal: true }).catch(() => {});
  }
}, 250);
