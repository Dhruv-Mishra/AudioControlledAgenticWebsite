// Local Web Speech API transcriber — USER SIDE ONLY.
//
// Used when GEMINI_TRANSCRIPTION=false AND SHOW_TEXT=true: we don't pay
// Gemini for server-side transcription, but the user still wants to see
// WHAT THEY SAID rendered in the transcript panel. The browser's native
// SpeechRecognition does a good-enough job for that.
//
// We never transcribe the AGENT audio this way — the agent's PCM is
// decoded straight to the speakers and doesn't pass through a
// SpeechRecognition-compatible path. When the agent side is hidden,
// the transcript panel shows only user lines plus a subtle hint.
//
// The underlying SpeechRecognition instance is started whenever the
// voice agent is in a call and muted = false. Muting or ending the call
// stops it. The engine is recreated on each `start()` to avoid the
// stuck-state quirks we see in Chrome after ~30 seconds.
//
// Graceful-degradation: if SpeechRecognition is missing (Firefox, iOS
// Safari, older browsers), `supported` returns false; the caller just
// skips local STT and lets the transcript panel stay empty on that side.

const Ctor = typeof window !== 'undefined'
  ? (window.SpeechRecognition || window.webkitSpeechRecognition || null)
  : null;

export class LocalStt extends EventTarget {
  constructor({ debug = false } = {}) {
    super();
    this.supported = !!Ctor;
    this.rec = null;
    this.running = false;
    this.debug = !!debug;
    this._restartTimer = null;
    this._lastInterimAt = 0;
  }

  _dlog(...args) {
    if (this.debug) {
      // eslint-disable-next-line no-console
      console.log('[local-stt]', ...args);
    }
  }

  start() {
    if (!this.supported) return;
    if (this.running) return;
    this._start();
  }

  _start() {
    this.rec = new Ctor();
    this.rec.continuous = true;
    this.rec.interimResults = true;
    this.rec.lang = 'en-US';
    this.rec.maxAlternatives = 1;

    this.rec.onresult = (ev) => {
      let interim = '';
      let finalText = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        const chunk = (r[0] && r[0].transcript) || '';
        if (r.isFinal) finalText += chunk;
        else interim += chunk;
      }
      if (finalText) {
        this.dispatchEvent(new CustomEvent('transcript', {
          detail: { from: 'user', text: finalText.trim(), finished: true }
        }));
      }
      if (interim) {
        this._lastInterimAt = Date.now();
        this.dispatchEvent(new CustomEvent('transcript', {
          detail: { from: 'user', text: interim.trim(), finished: false }
        }));
      }
    };

    this.rec.onerror = (ev) => {
      this._dlog('onerror', ev.error);
      // Most errors are transient (no-speech, audio-capture). Clear the
      // instance so onend triggers a restart.
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
        this.running = false;
      }
    };

    this.rec.onend = () => {
      this._dlog('onend (running=' + this.running + ')');
      // If we're still supposed to be running, rearm after a short delay —
      // Chrome auto-ends after ~30 s idle on the continuous recogniser.
      if (this.running) {
        clearTimeout(this._restartTimer);
        this._restartTimer = setTimeout(() => {
          if (this.running) {
            try { this._start(); } catch (err) { this._dlog('restart err', err); }
          }
        }, 120);
      }
    };

    try {
      this.rec.start();
      this.running = true;
      this._dlog('started');
    } catch (err) {
      this._dlog('start threw', err);
      this.running = false;
    }
  }

  stop() {
    this.running = false;
    clearTimeout(this._restartTimer);
    this._restartTimer = null;
    if (this.rec) {
      try { this.rec.stop(); } catch {}
      try { this.rec.abort(); } catch {}
      this.rec = null;
    }
    this._dlog('stopped');
  }

  /** Pause/resume without tearing down the engine object. */
  setMuted(muted) {
    if (!this.supported) return;
    if (muted) this.stop();
    else this.start();
  }
}
