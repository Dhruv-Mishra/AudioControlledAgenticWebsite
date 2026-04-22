// STT Controller — main-thread driver for on-device transcription.
//
// Owns the Whisper Web Worker and exposes an EventTarget API that is
// intentionally a drop-in replacement for LocalStt (see js/local-stt.js).
// voice-agent.js can swap one for the other with minimal change.
//
// Responsibilities:
//   - Backend resolution: Whisper (WebGPU/WASM) / Web Speech / none.
//   - VAD gating: drop PCM frames during silence so Whisper doesn't burn
//     CPU on empty audio.
//   - Worker lifecycle: lazy init, auto-restart once on crash, graceful teardown.
//   - Save-data gating: prompt for consent before pulling 40 MB of weights.
//
// See specs/upgrade-stt-contract.md for the frozen wire protocol.

import { LocalStt } from './local-stt.js';

const VAD_RMS_THRESHOLD = 0.02;
const VAD_SILENCE_MS = 400;

function detectWebGPU() {
  return typeof navigator !== 'undefined' && !!navigator.gpu;
}
function detectWasm() {
  return typeof WebAssembly !== 'undefined' && typeof WebAssembly.instantiate === 'function';
}
function hasSpeechRecognition() {
  return typeof window !== 'undefined' && !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}
function isIOsSafari() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const ios = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
  const safari = /^((?!chrome|android|crios|fxios).)*safari/i.test(ua);
  return ios || (safari && /Mobile/.test(ua));
}
function isSlowNetwork() {
  const c = (typeof navigator !== 'undefined' && navigator.connection) || null;
  if (!c) return false;
  if (c.saveData === true) return true;
  if (typeof c.effectiveType === 'string' && /slow-2g|2g/.test(c.effectiveType)) return true;
  return false;
}

export class SttController extends EventTarget {
  /**
   * @param {object} opts
   * @param {boolean} [opts.debug]
   * @param {'whisper'|'web-speech'} [opts.backend]  Preference. Default 'whisper'.
   * @param {() => number} [opts.onPcmMicLevel]  Returns mic RMS (0..1). Used for VAD gate.
   */
  constructor({ debug = false, backend = 'whisper', onPcmMicLevel } = {}) {
    super();
    this.debug = !!debug;
    this._prefer = backend === 'web-speech' ? 'web-speech' : 'whisper';
    this._getMicLevel = typeof onPcmMicLevel === 'function' ? onPcmMicLevel : null;

    this._worker = null;
    this._workerRestartsUsed = 0;
    this._ready = false;
    this._initStarted = false;
    this._needsConsentPending = false;
    this._running = false;
    this._muted = false;

    this.backend = 'none';   // resolved in init()
    this.supported = hasSpeechRecognition() || (detectWasm() || detectWebGPU());

    // VAD state
    this._silentSince = 0;
    this._belowThresholdSince = 0;
    this._gateOpen = true;

    // Fallback instance (Web Speech). Lazily constructed.
    this._fallback = null;
    this._audioSeq = 0;
  }

  _dlog(...args) {
    if (this.debug) {
      // eslint-disable-next-line no-console
      console.log('[stt-controller]', ...args);
    }
  }

  /**
   * Resolve backend and spin up the chosen pipeline.
   * Idempotent. Returns once ready OR rejects with a non-retriable error.
   */
  async init({ acceptLargeDownload = false } = {}) {
    if (this._initStarted && this._ready) return;
    this._initStarted = true;

    // Force web-speech path if ops sets STT_BACKEND=web-speech.
    if (this._prefer === 'web-speech') {
      return this._initWebSpeech('forced');
    }

    // iOS Safari is too slow for WASM Whisper — degrade to Web Speech.
    if (isIOsSafari()) {
      return this._initWebSpeech('ios_safari');
    }

    // Slow/save-data → require consent.
    if (isSlowNetwork() && !acceptLargeDownload) {
      this._needsConsentPending = true;
      this.dispatchEvent(new CustomEvent('needs_consent', { detail: { size: '40MB' } }));
      return;
    }

    const webgpu = detectWebGPU();
    const wasm = detectWasm();
    if (!webgpu && !wasm) {
      if (hasSpeechRecognition()) return this._initWebSpeech('no_wasm');
      this.backend = 'none';
      this.dispatchEvent(new CustomEvent('error', {
        detail: { code: 'no_backend', message: 'No supported STT backend.', retriable: false }
      }));
      return;
    }

    try {
      await this._initWhisper({ deviceHint: webgpu ? 'webgpu' : 'wasm' });
    } catch (err) {
      this._dlog('whisper init failed, trying fallback', err && err.message);
      if (hasSpeechRecognition()) {
        this.dispatchEvent(new CustomEvent('backend_changed', {
          detail: { from: 'whisper', to: 'web-speech', reason: 'whisper_init_failed' }
        }));
        return this._initWebSpeech('whisper_init_failed');
      }
      this.dispatchEvent(new CustomEvent('error', {
        detail: { code: 'model_fetch', message: err && err.message || String(err), retriable: true }
      }));
    }
  }

  async _initWhisper({ deviceHint }) {
    return new Promise((resolve, reject) => {
      let settled = false;

      // Resolve the worker URL in both dev (source tree at /js/stt-worker.js)
      // and prod (build outputs the worker at /js/stt-worker.js via its own
      // entry point — see scripts/build.js jsEntries). We root at the page
      // origin so it works regardless of how deep this module's chunk lives.
      const workerUrl = new URL('/js/stt-worker.js', location.origin);
      const worker = new Worker(workerUrl, { type: 'module' });
      this._worker = worker;

      const forwardError = (payload) => {
        if (!settled) {
          settled = true;
          reject(new Error(payload.message || payload.code || 'worker_error'));
          return;
        }
        // Post-init error — emit via EventTarget.
        this.dispatchEvent(new CustomEvent('error', { detail: payload }));
      };

      worker.addEventListener('message', (e) => {
        const msg = e.data;
        if (!msg || typeof msg !== 'object') return;
        switch (msg.type) {
          case 'progress':
            this.dispatchEvent(new CustomEvent('progress', {
              detail: { loaded: msg.loaded || 0, total: msg.total || 1, stage: msg.stage || 'download' }
            }));
            return;
          case 'ready':
            this._ready = true;
            this.backend = 'whisper';
            if (!settled) {
              settled = true;
              this.dispatchEvent(new CustomEvent('ready', { detail: { backend: 'whisper' } }));
              resolve();
            }
            return;
          case 'partial':
            this.dispatchEvent(new CustomEvent('transcript', {
              detail: { text: msg.text, finished: false, segmentId: msg.segmentId }
            }));
            return;
          case 'final':
            this.dispatchEvent(new CustomEvent('transcript', {
              detail: { text: msg.text, finished: true, segmentId: msg.segmentId }
            }));
            return;
          case 'error':
            forwardError({
              code: msg.code || 'worker_error',
              message: msg.message || 'unknown',
              retriable: msg.retriable !== false
            });
            return;
        }
      });

      worker.addEventListener('error', (ev) => {
        const payload = {
          code: 'worker_crash',
          message: (ev && ev.message) || 'worker error',
          retriable: true
        };
        // Auto-restart once.
        if (this._workerRestartsUsed === 0 && this._ready) {
          this._workerRestartsUsed += 1;
          this._dlog('worker crashed; auto-restarting');
          try { worker.terminate(); } catch {}
          this._worker = null;
          this._ready = false;
          this._initStarted = false;
          // Give the event loop a tick to settle before re-init.
          setTimeout(() => this.init().catch(() => {}), 50);
          return;
        }
        forwardError(payload);
      });

      try {
        worker.postMessage({ type: 'init', deviceHint });
      } catch (err) {
        reject(err);
      }
    });
  }

  _initWebSpeech(reason) {
    if (!hasSpeechRecognition()) {
      this.backend = 'none';
      this.dispatchEvent(new CustomEvent('error', {
        detail: { code: 'no_backend', message: 'No supported STT backend.', retriable: false }
      }));
      return;
    }
    this._fallback = new LocalStt({ debug: this.debug });
    this.backend = 'web-speech';
    this._ready = true;
    this._fallback.addEventListener('transcript', (ev) => {
      const d = ev.detail || {};
      this.dispatchEvent(new CustomEvent('transcript', {
        detail: { text: d.text, finished: !!d.finished, segmentId: d.segmentId || 'ws-seg' }
      }));
    });
    this.dispatchEvent(new CustomEvent('ready', { detail: { backend: 'web-speech' } }));
    this._dlog('web-speech fallback initialised, reason=' + reason);
  }

  start() {
    if (!this._ready) return;
    this._running = true;
    this._muted = false;
    if (this.backend === 'web-speech' && this._fallback) {
      this._fallback.start();
    }
  }

  stop() {
    this._running = false;
    if (this.backend === 'web-speech' && this._fallback) {
      this._fallback.stop();
    }
    if (this._worker) {
      try { this._worker.postMessage({ type: 'flush' }); } catch {}
      try { this._worker.postMessage({ type: 'reset' }); } catch {}
    }
  }

  setMuted(muted) {
    this._muted = !!muted;
    if (this.backend === 'web-speech' && this._fallback) {
      this._fallback.setMuted(muted);
    }
  }

  /**
   * Feed a single PCM frame (Int16Array, 16 kHz mono) from the audio pipeline.
   * Zero-copy: the underlying ArrayBuffer is transferred when forwarded.
   *
   * VAD gate: if mic RMS stays below threshold for > VAD_SILENCE_MS, we stop
   * forwarding frames until it rises again. On resume, we tell the worker
   * that a fresh segment is starting.
   */
  feedPcm(int16) {
    if (!this._running || this._muted) return;
    if (this.backend !== 'whisper') return;
    if (!(int16 instanceof Int16Array) || int16.length === 0) return;

    // VAD gate.
    const level = this._getMicLevel ? this._getMicLevel() : 1;
    const now = Date.now();
    if (level < VAD_RMS_THRESHOLD) {
      if (!this._belowThresholdSince) this._belowThresholdSince = now;
      if (this._gateOpen && now - this._belowThresholdSince >= VAD_SILENCE_MS) {
        this._gateOpen = false;
        this._dlog('vad gate: close');
        // Tell the worker to emit a final for what it has so far.
        try { this._worker && this._worker.postMessage({ type: 'flush' }); } catch {}
      }
    } else {
      this._belowThresholdSince = 0;
      if (!this._gateOpen) {
        this._gateOpen = true;
        this._dlog('vad gate: open');
        try { this._worker && this._worker.postMessage({ type: 'vad_resume' }); } catch {}
      }
    }
    if (!this._gateOpen) return;

    // Copy (pipeline frames are already independent ArrayBuffers — but the
    // caller may reuse; a shallow defensive copy is 3 KB so cheap).
    const copy = new Int16Array(int16.length);
    copy.set(int16);
    this._audioSeq += 1;
    try {
      this._worker.postMessage({ type: 'audio', pcm: copy, seq: this._audioSeq }, [copy.buffer]);
    } catch {
      /* worker terminated */
    }
  }

  async destroy() {
    this._running = false;
    try { this._worker && this._worker.postMessage({ type: 'reset' }); } catch {}
    try { this._worker && this._worker.terminate(); } catch {}
    this._worker = null;
    if (this._fallback) {
      try { this._fallback.stop(); } catch {}
      this._fallback = null;
    }
    this._ready = false;
    this._initStarted = false;
  }
}
