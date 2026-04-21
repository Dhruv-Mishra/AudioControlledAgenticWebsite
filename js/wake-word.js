// Wake-word detection using the Web Speech API (Chrome/Edge).
//
// Reliability: Chrome's SpeechRecognition is notoriously flaky on Windows.
// It silently times out every ~60s, stops on tab blur, and throws
// InvalidStateError if `start()` is called too quickly after an `onend`.
// We handle this with a jittered watchdog restart and bucket the error codes.

const DEFAULT_WAKE = ['hey jarvis', 'hi jarvis', 'okay jarvis', 'ok jarvis'];
const RESTART_MIN_MS = 150;
const RESTART_MAX_MS = 400;

export class WakeWordEngine {
  constructor({ wakePhrases = DEFAULT_WAKE, onWake, onTranscript, onError, onStatus, debug = false } = {}) {
    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.supported = !!Ctor;
    this.wakePhrases = wakePhrases.map((p) => p.toLowerCase());
    this.onWake = onWake || (() => {});
    this.onTranscript = onTranscript || (() => {});
    this.onError = onError || (() => {});
    this.onStatus = onStatus || (() => {});
    this.debug = debug;
    this.rec = null;
    this.running = false;
    this.manualStop = false;
    this.detectEnabled = true;
    this.restartTimer = null;
    this.consecutiveErrors = 0;
    if (this.supported) this._buildRecogniser(Ctor);
  }

  _buildRecogniser(Ctor) {
    this.rec = new Ctor();
    this.rec.continuous = true;
    this.rec.interimResults = true;
    this.rec.lang = 'en-US';
    this.rec.onresult = (e) => this._onResult(e);
    this.rec.onerror = (e) => this._onError(e);
    this.rec.onend = () => this._onEnd();
    this.rec.onstart = () => { this._dbg('onstart'); this.consecutiveErrors = 0; };
  }

  _dbg(...args) { if (this.debug) console.log('[wake-word]', ...args); }

  start() {
    if (!this.supported) return;
    if (this.running) return;
    this.manualStop = false;
    this._tryStart();
  }

  stop() {
    this.manualStop = true;
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    if (this.running) { try { this.rec.stop(); } catch {} }
    this.running = false;
  }

  setWakeDetection(on) { this.detectEnabled = !!on; }

  _tryStart() {
    if (this.manualStop || !this.rec) return;
    try {
      this.rec.start();
      this.running = true;
      this._dbg('started');
      this.onStatus({ state: 'listening' });
    } catch (err) {
      // InvalidStateError fires if already started; otherwise genuine error.
      if (err && /already started|invalid state/i.test(err.message || '')) {
        this.running = true;
        return;
      }
      this._dbg('start() failed', err.message || String(err));
      this._scheduleRestart();
    }
  }

  _onResult(evt) {
    let interim = '';
    let finalText = '';
    for (let i = evt.resultIndex; i < evt.results.length; i++) {
      const r = evt.results[i];
      const t = (r[0] && r[0].transcript) || '';
      if (r.isFinal) finalText += t;
      else interim += t;
    }
    const combined = (finalText + ' ' + interim).toLowerCase();
    if (this.detectEnabled) {
      for (const phrase of this.wakePhrases) {
        if (combined.includes(phrase)) {
          this._dbg('wake matched:', phrase);
          try { this.onWake(); } catch {}
          break;
        }
      }
    }
    if (interim.trim()) this.onTranscript({ kind: 'interim', text: interim.trim() });
    if (finalText.trim()) this.onTranscript({ kind: 'final', text: finalText.trim() });
  }

  _onError(e) {
    const err = e && e.error;
    this._dbg('onerror', err);
    this.consecutiveErrors += 1;
    if (err === 'not-allowed') {
      this.running = false;
      this.manualStop = true;
      this.onError(new Error('Microphone access denied.'));
      return;
    }
    if (err === 'audio-capture') {
      this.onError(new Error('No microphone available.'));
      // Don't give up — user may plug in a mic later.
      return;
    }
    // `no-speech`, `network`, `aborted`, `service-not-allowed` — onend will
    // follow, handled there.
  }

  _onEnd() {
    this._dbg('onend, manualStop=' + this.manualStop);
    this.running = false;
    this.onStatus({ state: 'ended' });
    if (this.manualStop) return;
    if (this.consecutiveErrors >= 8) {
      // Too many consecutive failures (likely permission or hardware). Give up;
      // caller can call start() again to retry.
      this._dbg('too many consecutive errors — standing down');
      this.onError(new Error('Wake-word recogniser repeatedly failing.'));
      return;
    }
    this._scheduleRestart();
  }

  _scheduleRestart() {
    if (this.restartTimer) return;
    const jitter = RESTART_MIN_MS + Math.random() * (RESTART_MAX_MS - RESTART_MIN_MS);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.manualStop) this._tryStart();
    }, jitter);
  }
}
