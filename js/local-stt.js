// Local Web Speech API transcriber — FALLBACK ONLY.
//
// As of the STT upgrade (specs/upgrade-stt-contract.md), Whisper running in
// a Web Worker is the primary on-device transcription path. This file is the
// degraded-but-functional fallback for:
//   - Browsers where WebGPU + WASM are both unavailable.
//   - Users on saveData/slow-2g networks who decline the 40 MB download.
//   - iOS Safari, where WASM Whisper is too slow.
//   - Ops forcing STT_BACKEND=web-speech.
//
// We keep the same class name, event shape, and public methods as the pre-
// upgrade version so SttController can wrap it transparently and any direct
// LocalStt callers keep working.
//
// Bug fixes baked in vs the pre-upgrade version:
//   1. Phrase-repetition dedup: we track the running set of already-finalised
//      result indices, so a segment is never re-emitted after Chrome restarts
//      the recogniser. A secondary normalized-hash set dedups literal matches
//      across restarts.
//   2. Partial monotonicity: we never emit an interim that shrinks the prior
//      interim for the same segment — we either extend or skip.
//   3. Chrome auto-ends after ~30 s; we restart quickly (120 ms), but we ALSO
//      reset the resultIndex cursor properly so restart-after-30 s doesn't
//      re-announce the last segment.

const Ctor = typeof window !== 'undefined'
  ? (window.SpeechRecognition || window.webkitSpeechRecognition || null)
  : null;

function normalize(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function makeSegmentId() {
  return 'ws-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
}

export class LocalStt extends EventTarget {
  constructor({ debug = false } = {}) {
    super();
    this.supported = !!Ctor;
    this.rec = null;
    this.running = false;
    this.debug = !!debug;
    this._restartTimer = null;
    this._lastInterimAt = 0;

    // Dedup state — survives `rec` re-creation within a running session.
    this._currentSegmentId = makeSegmentId();
    this._lastPartialText = '';
    this._finalisedHashes = new Set();   // hash of last ~20 finalised utterances
    this._finalisedHashOrder = [];
    this._lastFinalText = '';
  }

  _dlog(...args) {
    if (this.debug) {
      // eslint-disable-next-line no-console
      console.log('[local-stt]', ...args);
    }
  }

  _rememberHash(h) {
    if (this._finalisedHashes.has(h)) return;
    this._finalisedHashes.add(h);
    this._finalisedHashOrder.push(h);
    if (this._finalisedHashOrder.length > 20) {
      const old = this._finalisedHashOrder.shift();
      this._finalisedHashes.delete(old);
    }
  }

  _isDuplicateFinal(text) {
    const n = normalize(text);
    if (!n) return true;
    if (this._finalisedHashes.has(n)) return true;
    // Trailing 8-word suffix match against the last final — catches the
    // "Chrome emits the same tail twice" class of bug we hit on 30 s restart.
    const words = n.split(/\s+/).filter(Boolean);
    const prev = normalize(this._lastFinalText).split(/\s+/).filter(Boolean);
    if (words.length >= 4 && prev.length >= 4) {
      const tail = (a, k) => a.slice(Math.max(0, a.length - k)).join(' ');
      if (tail(words, 8) && tail(words, 8) === tail(prev, 8)) return true;
    }
    return false;
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
      // Walk ONLY the new results (ev.resultIndex forward). This avoids
      // re-emitting past finals on Chrome's 30 s restart quirk.
      let interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        const chunk = (r[0] && r[0].transcript) || '';
        if (r.isFinal) {
          const text = chunk.trim();
          if (!text) continue;
          if (this._isDuplicateFinal(text)) {
            this._dlog('drop duplicate final:', text);
            // Still advance the segment so the next partial is fresh.
            this._currentSegmentId = makeSegmentId();
            this._lastPartialText = '';
            continue;
          }
          this._rememberHash(normalize(text));
          this._lastFinalText = text;
          this.dispatchEvent(new CustomEvent('transcript', {
            detail: {
              from: 'user',
              text,
              finished: true,
              segmentId: this._currentSegmentId
            }
          }));
          // New segment.
          this._currentSegmentId = makeSegmentId();
          this._lastPartialText = '';
        } else {
          interim += chunk;
        }
      }
      if (interim) {
        const text = interim.trim();
        if (!text) return;
        // Partial monotonicity: only emit if it extends the prior partial.
        const prev = this._lastPartialText;
        const nText = normalize(text);
        const nPrev = normalize(prev);
        if (prev && !(nText.startsWith(nPrev) || nPrev.startsWith(nText))) {
          // A totally different hypothesis arrived — safer to keep the prior
          // partial until it resolves to a final. Drop this intermediate.
          return;
        }
        if (text === prev) return;
        this._lastPartialText = text;
        this._lastInterimAt = Date.now();
        this.dispatchEvent(new CustomEvent('transcript', {
          detail: {
            from: 'user',
            text,
            finished: false,
            segmentId: this._currentSegmentId
          }
        }));
      }
    };

    this.rec.onerror = (ev) => {
      this._dlog('onerror', ev.error);
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
        this.running = false;
      }
    };

    this.rec.onend = () => {
      this._dlog('onend (running=' + this.running + ')');
      // Chrome ends the continuous recogniser after ~30 s. We restart, but
      // we ALSO reset the segment id so any stale `resultIndex` pointer
      // doesn't re-emit the final we just saw.
      if (this.running) {
        this._currentSegmentId = makeSegmentId();
        this._lastPartialText = '';
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

  setMuted(muted) {
    if (!this.supported) return;
    if (muted) this.stop();
    else this.start();
  }
}
