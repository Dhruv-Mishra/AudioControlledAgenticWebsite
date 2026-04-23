// Audio pipeline: capture (AudioWorklet → PCM16 16 kHz chunks to caller),
// playback of 24 kHz PCM16 chunks, and call-audio choreography (call-open
// chime, background ambience loop, call-close chime) driven off three
// HTMLAudioElement instances.
//
// audio-flow: The procedural noise-bed / human-call-layer systems that
// previously lived here have been removed. Phone-line compression has
// been re-introduced as an opt-in Web Audio sub-graph applied to the
// agent playback chain. The three <audio> elements remain:
//
//   • callOpen   — one-shot ring-then-pickup; covers dialling / setup.
//   • background — loops at low volume for the duration of the call.
//   • callClose  — one-shot hangup-then-disconnect; plays during teardown.
//
// HTMLAudioElement is intentional: it obeys the OS volume mixer, costs
// nothing to keep loaded, and doesn't need the Web Audio graph (which is
// still used for PCM capture + Gemini voice playback).
//
// Design notes:
//   • Single AudioContext for BOTH mic capture and Gemini playback.
//   • `unlockAudioSync()` creates + resumes the ctx synchronously inside a
//     user gesture (Chrome autoplay policy).
//   • The Place Call click also primes the three <audio> elements via
//     `unlockCallAudio()` so Safari / iOS honours the first `.play()`.
//   • No ScriptProcessorNode anywhere.

/** Encode an Int16Array of PCM samples into an AudioBuffer for playback. */
function int16ToAudioBuffer(ctx, int16, sampleRate) {
  const buf = ctx.createBuffer(1, int16.length, sampleRate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < int16.length; i++) ch[i] = int16[i] / 32768;
  return buf;
}

// audio-flow: volume constants for the three HTMLAudioElement layers.
// BACKGROUND_VOLUME is tuned quiet so it sits under Gemini's voice and
// doesn't force the user to keep turning the OS volume down.
const BACKGROUND_VOLUME = 0.15;
const START_END_VOLUME = 0.85;
// audio-flow: safety cap on how long we wait for callOpen / callClose
// clips to finish before we move on. A missing or corrupt file must never
// block the call flow — we log and continue.
//   • callOpen cap: 6000ms — the combined ring-then-pickup asset is
//     ~5s; the 6s cap gives the pickup a moment of slack while still
//     bounding the greet delay if the asset is corrupt.
//   • callClose cap: 3000ms — combined hangup-then-disconnect is ~2.4s.
const START_AUDIO_MAX_MS = 6000;
const END_AUDIO_MAX_MS = 3000;

// audio-flow: candidate asset paths. We probe <audio>.canPlayType for
// Opus-in-WebM up-front; if it returns a non-empty string we use .webm,
// otherwise we fall back to .mp3. This keeps download size down on
// modern browsers while keeping iOS Safari working.
//   • callOpen  = startCall (ring) + phonePick concatenated.
//   • callClose = phoneCut + endCall concatenated.
const CALL_AUDIO_SOURCES = {
  callOpen:   { webm: '/audio/callOpen.webm',   mp3: '/audio/callOpen.mp3' },
  background: { webm: '/audio/background.webm', mp3: '/audio/background.mp3' },
  callClose:  { webm: '/audio/callClose.webm',  mp3: '/audio/callClose.mp3' }
};

let _webmOpusProbeResult = null;
function canPlayWebmOpus() {
  if (_webmOpusProbeResult !== null) return _webmOpusProbeResult;
  try {
    // audio-flow: one-shot probe. We test an HTMLAudioElement (not a
    // MediaSource) because the former matches the runtime we'll use.
    // Cached so we don't spin up a throwaway element per clip.
    const probe = new Audio();
    const result = typeof probe.canPlayType === 'function'
      ? probe.canPlayType('audio/webm;codecs=opus')
      : '';
    _webmOpusProbeResult = !!(result && result !== '');
  } catch {
    _webmOpusProbeResult = false;
  }
  return _webmOpusProbeResult;
}

function pickCallAudioSrc(kind) {
  const pair = CALL_AUDIO_SOURCES[kind];
  if (!pair) return null;
  return canPlayWebmOpus() ? pair.webm : pair.mp3;
}

/** audio-flow: call-audio choreography. Owns three HTMLAudioElement
 *  instances (callOpen / background / callClose) and exposes a small
 *  imperative API the VoiceAgent drives off call-lifecycle transitions.
 *
 *  background-loop watchdog: HTMLAudioElement's `loop=true` occasionally
 *  no-ops on Chrome when the media element is paused-then-resumed across
 *  tabs or when a short/corrupt file triggers `ended` before `loop` is
 *  evaluated. We defensively listen for `ended` and, if we still believe
 *  the ambience should be running, rewind + play again. A warn is logged
 *  so the root cause surfaces in DevTools. */
class CallAudioController {
  constructor({ onStateChange } = {}) {
    this._onStateChange = typeof onStateChange === 'function' ? onStateChange : () => {};
    this._backgroundEnabled = true; // default ON; VoiceAgent overrides from localStorage

    this.openAudio = this._buildAudio('callOpen', { loop: false, volume: START_END_VOLUME });
    this.backgroundAudio = this._buildAudio('background', { loop: true, volume: BACKGROUND_VOLUME });
    this.closeAudio = this._buildAudio('callClose', { loop: false, volume: START_END_VOLUME });

    this._unlocked = false;
    this._openPlaying = false;
    this._backgroundPlaying = false;
    this._closePlaying = false;

    // audio-flow: watchdog for the background loop. If the browser ever
    // fires `ended` while we still want ambience playing, rewind and
    // restart. Covers: (a) Chrome bug where loop=true is dropped after
    // pause+resume, (b) a corrupt short file that terminates before
    // metadata resolves, (c) media element recycling across tab blurs.
    this.backgroundAudio.addEventListener('ended', () => {
      if (this._backgroundEnabled && this._backgroundPlaying) {
        // eslint-disable-next-line no-console
        console.warn('[audio-flow] background ended while loop expected; restarting');
        try { this.backgroundAudio.currentTime = 0; } catch {}
        const p = this.backgroundAudio.play();
        if (p && typeof p.catch === 'function') p.catch(() => { this._backgroundPlaying = false; });
      }
    });
  }

  _buildAudio(kind, { loop, volume }) {
    const el = new Audio();
    el.preload = 'auto';
    el.loop = !!loop;
    el.volume = volume;
    const src = pickCallAudioSrc(kind);
    if (src) el.src = src;
    // Failed loads must not block the call. Log + swallow.
    el.addEventListener('error', () => {
      // eslint-disable-next-line no-console
      console.warn(`[audio-flow] failed to load ${kind} audio src=${el.src}`);
    });
    return el;
  }

  /** audio-flow: call once from inside the first user-gesture event
   *  handler. Silently nudges each element so Safari/iOS marks them as
   *  user-activated. Idempotent. */
  unlock() {
    if (this._unlocked) return;
    this._unlocked = true;
    // audio-flow: synchronous unlock. A muted play() followed by an
    // immediate pause() inside the same gesture tick counts as
    // user-activated playback on Safari/iOS without stealing the
    // element from a subsequent playCallOpen() in the same gesture.
    // Doing the pause inside p.then() caused a race: the promise
    // resolved AFTER playCallOpen() had already called play(), and the
    // late pause() cancelled the real playback. See audio-pipeline
    // warning "The play() request was interrupted by a call to pause()".
    for (const el of [this.openAudio, this.backgroundAudio, this.closeAudio]) {
      try {
        el.muted = true;
        const p = el.play();
        try { el.pause(); } catch {}
        try { el.currentTime = 0; } catch {}
        el.muted = false;
        // Swallow the rejection from the interrupted muted play —
        // pausing before the promise settles is expected here.
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch {}
    }
  }

  /** audio-flow: play the call-open clip (ring + pickup). Resolves when
   *  playback ends or after START_AUDIO_MAX_MS as a safety cap. Never
   *  rejects. */
  playCallOpen() {
    this._openPlaying = true;
    return this._playOneShot(this.openAudio, 'callOpen', START_AUDIO_MAX_MS).then((outcome) => {
      this._openPlaying = false;
      return outcome;
    });
  }

  /** audio-flow: play the call-close clip (hangup + disconnect). Resolves
   *  when playback ends or after END_AUDIO_MAX_MS. Never rejects. */
  playCallClose() {
    this._closePlaying = true;
    return this._playOneShot(this.closeAudio, 'callClose', END_AUDIO_MAX_MS).then((outcome) => {
      this._closePlaying = false;
      return outcome;
    });
  }

  _playOneShot(el, label, maxMs) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (why) => {
        if (done) return;
        done = true;
        try { el.removeEventListener('ended', onEnded); } catch {}
        try { el.removeEventListener('error', onError); } catch {}
        clearTimeout(t);
        resolve({ ok: why === 'ended', reason: why });
      };
      const onEnded = () => finish('ended');
      const onError = () => finish('error');
      const t = setTimeout(() => finish('timeout'), maxMs);
      try {
        el.addEventListener('ended', onEnded, { once: true });
        el.addEventListener('error', onError, { once: true });
        try { el.currentTime = 0; } catch {}
        const p = el.play();
        if (p && typeof p.catch === 'function') {
          p.catch((err) => {
            // eslint-disable-next-line no-console
            console.warn(`[audio-flow] ${label} play rejected`, err && err.message);
            finish('reject');
          });
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[audio-flow] ${label} play threw`, err && err.message);
        finish('throw');
      }
    });
  }

  /** audio-flow: start looping the background ambience. No-op if the
   *  toggle is off or background is already playing.
   *
   *  bug-fix: `loop=true` is re-asserted here (in addition to
   *  `_buildAudio`) because some browsers drop the property when the
   *  element is pause-resumed after an unlock() gesture. Belt-and-
   *  braces against the "background never loops" regression. */
  startBackground() {
    if (!this._backgroundEnabled) return;
    if (this._backgroundPlaying) return;
    this._backgroundPlaying = true;
    try {
      this.backgroundAudio.loop = true;
      this.backgroundAudio.volume = BACKGROUND_VOLUME;
      try { this.backgroundAudio.currentTime = 0; } catch {}
      const p = this.backgroundAudio.play();
      if (p && typeof p.catch === 'function') {
        p.catch((err) => {
          // eslint-disable-next-line no-console
          console.warn('[audio-flow] background play rejected', err && err.message);
          this._backgroundPlaying = false;
        });
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[audio-flow] background play threw', err && err.message);
      this._backgroundPlaying = false;
    }
    this._onStateChange({ backgroundPlaying: true });
  }

  /** audio-flow: stop the background loop if it's running. Idempotent. */
  stopBackground() {
    const wasPlaying = this._backgroundPlaying;
    this._backgroundPlaying = false;
    try { this.backgroundAudio.pause(); } catch {}
    try { this.backgroundAudio.currentTime = 0; } catch {}
    if (wasPlaying) this._onStateChange({ backgroundPlaying: false });
  }

  /** audio-flow: toggle the user's background preference. When called
   *  mid-call, take effect immediately. */
  setBackgroundEnabled(on) {
    const next = !!on;
    const changed = this._backgroundEnabled !== next;
    this._backgroundEnabled = next;
    if (!next && this._backgroundPlaying) {
      this.stopBackground();
    }
    return changed;
  }

  isBackgroundEnabled() { return this._backgroundEnabled; }
  isBackgroundPlaying() { return this._backgroundPlaying; }

  /** audio-flow: stop everything and detach listeners. Called on full
   *  pipeline close. */
  destroy() {
    for (const el of [this.openAudio, this.backgroundAudio, this.closeAudio]) {
      try { el.pause(); } catch {}
      try { el.removeAttribute('src'); el.load(); } catch {}
    }
    this._openPlaying = false;
    this._backgroundPlaying = false;
    this._closePlaying = false;
  }
}

export class AudioPipeline extends EventTarget {
  constructor() {
    super();
    // Single AudioContext for both capture and playback. Created lazily
    // (or eagerly via unlockAudioSync) and never destroyed across route
    // changes.
    this.ctx = null;
    this.capture = null;           // { micStream, worklet, source, track }
    this.onPcmFrame = null;        // (Int16Array) => void
    this.capturePaused = true;
    this.muted = false;            // orthogonal to paused — user-controlled
    this.activePlaybackSources = new Set();

    // Playback graph pieces.
    this.nextStartTime = 0;
    this.playbackGain = null;      // agent volume only
    this.outputVolume = 1.0;

    // audio-flow: phone-line compression sub-graph. Optional, crossfaded.
    // Default OFF (bypass). Owned by pipeline; toggled via
    // setPhoneCompression(). Graph:
    //   playbackGain ──┬─ _cleanGain ─────────────────────────────┐
    //                  │                                           ├─> destination
    //                  └─ _phoneIn → HP → LP → Comp → Makeup ─────┘
    // _cleanGain and _phoneIn (which feeds through to _phoneOut at the
    // end of the chain) have their gains crossfaded so there's no click.
    this._phoneCompressionOn = false;
    this._cleanGain = null;
    this._phoneIn = null;
    this._phoneHP = null;
    this._phoneLP1 = null;
    this._phoneLP2 = null;
    this._phoneComp = null;
    this._phoneMakeup = null;

    // audio-flow: call-audio controller owns the three lifecycle clips.
    // It's independent from the Web Audio graph so it keeps working even
    // if the ctx is suspended — the browser drives <audio> scheduling.
    this.callAudio = new CallAudioController({
      onStateChange: (ev) => this.dispatchEvent(new CustomEvent('call-audio-changed', { detail: ev }))
    });

    this._analyser = null;
    this._micAnalyser = null;

    // Keep-alive watchdog — periodically resume the context if Chrome
    // decides to suspend it while idle.
    this._keepAliveTimer = null;

    // Visibility-resume listener so tabs returning from background unlock
    // the shared context without requiring a click.
    this._onVisibility = () => this._onVisibilityChange();
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this._onVisibility);
    }
  }

  _onVisibilityChange() {
    if (typeof document === 'undefined') return;
    if (document.visibilityState !== 'visible') return;
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
  }

  // ----- Context bootstrap -----

  /**
   * SYNCHRONOUS context creation + resume. MUST be called from inside a
   * user-gesture event handler stack (e.g. click, keydown) BEFORE any
   * `await`. Chrome's autoplay policy only honours resume() while the
   * gesture activation is alive — one sync call wide.
   *
   * Idempotent. Safe to call many times.
   */
  unlockAudioSync() {
    if (!this.ctx) {
      const ctor = (typeof window !== 'undefined') && (window.AudioContext || window.webkitAudioContext);
      if (!ctor) return null;
      this.ctx = new ctor({ latencyHint: 'interactive', sampleRate: 48000 });
      this._buildPlaybackGraph();
      this._startKeepAlive();
    }
    // Note: `resume()` returns a promise, but the CRITICAL part — Chrome
    // marking the context as unblocked — happens synchronously when the
    // call originates from an active user gesture.
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    // audio-flow: mirror the unlock onto the HTMLAudioElement layer so
    // the first playCallOpen() doesn't get blocked by Safari's autoplay
    // policy.
    try { this.callAudio.unlock(); } catch {}
    return this.ctx;
  }

  /** Async variant. Safe to call outside a gesture but cannot unlock a
   *  suspended context on Chrome without one. */
  async ensureCtx() {
    if (!this.ctx) this.unlockAudioSync();
    if (this.ctx && this.ctx.state === 'suspended') {
      try { await this.ctx.resume(); } catch { /* will retry on enqueue */ }
    }
    return this.ctx;
  }

  /** True when the AudioContext is blocked by Chrome's autoplay policy. */
  isPlaybackBlocked() {
    return !this.ctx || this.ctx.state === 'suspended';
  }

  _buildPlaybackGraph() {
    const ctx = this.ctx;

    // Agent-output chain with an opt-in phone-line compression branch.
    // Base chain (default, compression OFF):
    //   sources → playbackGain → _cleanGain → destination
    // Phone chain (when ON, crossfaded in):
    //   playbackGain → _phoneIn → HP(300Hz) → LP(3400Hz) → LP(3400Hz)
    //               → DynamicsCompressor → makeupGain → destination
    // Both gain paths are mixed into destination; we crossfade
    // _cleanGain.gain vs _phoneIn.gain with a 50ms exponential ramp.
    this.playbackGain = ctx.createGain();
    this.playbackGain.gain.value = this.outputVolume;

    // Clean path.
    this._cleanGain = ctx.createGain();
    this._cleanGain.gain.value = 1.0; // default: clean ON (bypass phone)

    // Phone path.
    this._phoneIn = ctx.createGain();
    this._phoneIn.gain.value = 0.0; // default: phone OFF (bypassed)

    // 300Hz high-pass then 3400Hz low-pass cascaded twice for a steeper
    // roll-off that better evokes the POTS bandwidth.
    this._phoneHP = ctx.createBiquadFilter();
    this._phoneHP.type = 'highpass';
    this._phoneHP.frequency.value = 300;
    this._phoneHP.Q.value = 0.707;

    this._phoneLP1 = ctx.createBiquadFilter();
    this._phoneLP1.type = 'lowpass';
    this._phoneLP1.frequency.value = 3400;
    this._phoneLP1.Q.value = 0.707;

    this._phoneLP2 = ctx.createBiquadFilter();
    this._phoneLP2.type = 'lowpass';
    this._phoneLP2.frequency.value = 3400;
    this._phoneLP2.Q.value = 0.707;

    // Soft compressor to simulate a carrier's dynamics processing.
    this._phoneComp = ctx.createDynamicsCompressor();
    this._phoneComp.threshold.value = -18;
    this._phoneComp.ratio.value = 3;
    this._phoneComp.attack.value = 0.010;
    this._phoneComp.release.value = 0.200;
    this._phoneComp.knee.value = 6;

    // +6 dB makeup to restore loudness lost to bandpass + compression.
    this._phoneMakeup = ctx.createGain();
    this._phoneMakeup.gain.value = 2.0; // ~+6 dB

    // Wire phone chain.
    this._phoneIn.connect(this._phoneHP);
    this._phoneHP.connect(this._phoneLP1);
    this._phoneLP1.connect(this._phoneLP2);
    this._phoneLP2.connect(this._phoneComp);
    this._phoneComp.connect(this._phoneMakeup);
    this._phoneMakeup.connect(ctx.destination);

    // Wire parallel paths off playbackGain.
    this.playbackGain.connect(this._cleanGain);
    this._cleanGain.connect(ctx.destination);
    this.playbackGain.connect(this._phoneIn);

    // Analyser on agent audio (for VU meter). Tap playbackGain so the
    // reading is unaffected by the phone/clean crossfade.
    this._analyser = ctx.createAnalyser();
    this._analyser.fftSize = 256;
    this.playbackGain.connect(this._analyser);
  }

  /** audio-flow: enable/disable the phone-line compression sub-graph.
   *  Crossfades the clean vs. phone path with a 50ms exponential ramp
   *  to avoid clicks. Safe to call before the AudioContext exists (will
   *  be applied next time the graph is built, but in practice the graph
   *  is built during placeCall's unlock so this is a no-op edge). */
  setPhoneCompression(on) {
    const next = !!on;
    this._phoneCompressionOn = next;
    if (!this.ctx || !this._cleanGain || !this._phoneIn) return next;
    const now = this.ctx.currentTime;
    const RAMP = 0.050;
    const EPS = 0.0001; // exponentialRamp can't target 0
    try {
      // Cancel any pending schedules so toggling fast doesn't stack.
      this._cleanGain.gain.cancelScheduledValues(now);
      this._phoneIn.gain.cancelScheduledValues(now);
      // Set starting values explicitly (cancel doesn't — it just clears
      // the automation curve). Read current value before ramping.
      this._cleanGain.gain.setValueAtTime(Math.max(this._cleanGain.gain.value, EPS), now);
      this._phoneIn.gain.setValueAtTime(Math.max(this._phoneIn.gain.value, EPS), now);
      if (next) {
        // Phone ON: clean fades to EPS, phone fades to 1.
        this._cleanGain.gain.exponentialRampToValueAtTime(EPS, now + RAMP);
        this._phoneIn.gain.exponentialRampToValueAtTime(1.0, now + RAMP);
      } else {
        this._phoneIn.gain.exponentialRampToValueAtTime(EPS, now + RAMP);
        this._cleanGain.gain.exponentialRampToValueAtTime(1.0, now + RAMP);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[audio-flow] setPhoneCompression crossfade threw', err && err.message);
      // Fallback: hard set.
      this._cleanGain.gain.value = next ? 0.0 : 1.0;
      this._phoneIn.gain.value = next ? 1.0 : 0.0;
    }
    return next;
  }

  isPhoneCompressionOn() { return !!this._phoneCompressionOn; }

  /** Gentle watchdog: resumes the AudioContext if Chrome suspends it while
   *  we think a call is active. Tiny CPU cost. */
  _startKeepAlive() {
    if (this._keepAliveTimer) return;
    this._keepAliveTimer = setInterval(() => {
      if (!this.ctx) return;
      if (this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {});
      }
    }, 2000);
  }
  _stopKeepAlive() {
    if (this._keepAliveTimer) clearInterval(this._keepAliveTimer);
    this._keepAliveTimer = null;
  }

  // ----- Playback -----

  enqueuePcm24k(int16) {
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    const buffer = int16ToAudioBuffer(this.ctx, int16, 24000);
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.playbackGain);
    const t = Math.max(this.ctx.currentTime, this.nextStartTime);
    src.start(t);
    this.nextStartTime = t + buffer.duration;
    this.activePlaybackSources.add(src);
    src.onended = () => {
      try { src.disconnect(); } catch {}
      this.activePlaybackSources.delete(src);
    };
  }

  /** Hard flush: stop all in-flight scheduled sources immediately. */
  flushPlayback() {
    for (const src of this.activePlaybackSources) {
      try { src.stop(); } catch {}
      try { src.disconnect(); } catch {}
    }
    this.activePlaybackSources.clear();
    this.nextStartTime = this.ctx ? this.ctx.currentTime : 0;
  }

  setOutputVolume(v) {
    this.outputVolume = Math.max(0, Math.min(1.5, v));
    if (this.playbackGain) this.playbackGain.gain.value = this.outputVolume;
  }

  // ----- Capture -----

  async startCapture({ onPcmFrame }) {
    this.onPcmFrame = onPcmFrame;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('getUserMedia not supported by this browser.');
    }
    // Use the shared AudioContext for capture too.
    if (!this.ctx) this.unlockAudioSync();
    if (!this.ctx) throw new Error('AudioContext unavailable.');

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    if (this.ctx.state === 'suspended') await this.ctx.resume();

    // Register the worklet module once per context.
    try {
      await this.ctx.audioWorklet.addModule('/js/audio-worklets/pcm-capture.js');
    } catch (err) {
      // Swallow if already added; first add on some browsers throws on re-add.
      if (!/already|registered/i.test(err && err.message || '')) throw err;
    }

    const source = this.ctx.createMediaStreamSource(stream);
    const worklet = new AudioWorkletNode(this.ctx, 'pcm-capture', {
      processorOptions: { outputSampleRate: 16000, frameMs: 40 }
    });
    source.connect(worklet);
    // DO NOT connect worklet to destination — we never want to play back the mic.

    // Mic-side analyser for the VU meter.
    this._micAnalyser = this.ctx.createAnalyser();
    this._micAnalyser.fftSize = 256;
    source.connect(this._micAnalyser);

    worklet.port.onmessage = (e) => {
      if (this.capturePaused || this.muted) return;
      if (typeof this.onPcmFrame !== 'function') return;
      const int16 = new Int16Array(e.data);
      this.onPcmFrame(int16);
    };

    // Detect if the mic track dies (USB sleep, another app grabs it).
    const track = stream.getAudioTracks()[0];
    if (track) {
      track.addEventListener('ended', () => {
        this.dispatchEvent(new CustomEvent('mic-ended', {}));
      });
      track.addEventListener('mute', () => {
        this.dispatchEvent(new CustomEvent('mic-hw-mute', { detail: { muted: true } }));
      });
      track.addEventListener('unmute', () => {
        this.dispatchEvent(new CustomEvent('mic-hw-mute', { detail: { muted: false } }));
      });
    }

    this.capture = { micStream: stream, worklet, source, track };
    this.capturePaused = true;
    worklet.port.postMessage({ type: 'mute', value: true });
  }

  setCapturePaused(paused) {
    this.capturePaused = !!paused;
    if (this.capture?.worklet) {
      this.capture.worklet.port.postMessage({ type: 'mute', value: !!paused });
    }
  }

  /** User-facing mute toggle. Disables the MediaStreamTrack so even if a
   *  stray frame sneaks through our `muted` check, nothing gets captured at
   *  the device level. */
  setMuted(muted) {
    this.muted = !!muted;
    if (this.capture && this.capture.track) {
      try { this.capture.track.enabled = !this.muted; } catch {}
    }
    if (this.capture?.worklet) {
      this.capture.worklet.port.postMessage({ type: 'mute', value: this.muted || this.capturePaused });
    }
  }

  isMuted() { return !!this.muted; }
  isMicEnded() { return !!(this.capture && this.capture.track && this.capture.track.readyState === 'ended'); }

  /** Read an analyser on the mic itself (not playback). Used by Live mode UI. */
  readMicLevel() {
    if (!this._micAnalyser) return 0;
    const arr = new Uint8Array(this._micAnalyser.frequencyBinCount);
    this._micAnalyser.getByteTimeDomainData(arr);
    let peak = 0;
    for (let i = 0; i < arr.length; i++) {
      const v = Math.abs(arr[i] - 128);
      if (v > peak) peak = v;
    }
    return peak / 128;
  }

  stopCapture() {
    if (!this.capture) return;
    try { this.capture.worklet.disconnect(); } catch {}
    try { this.capture.source.disconnect(); } catch {}
    try { this.capture.micStream.getTracks().forEach((t) => t.stop()); } catch {}
    this.capture = null;
  }

  // ----- VU meter -----
  readVuLevel() {
    if (!this._analyser) return 0;
    const arr = new Uint8Array(this._analyser.frequencyBinCount);
    this._analyser.getByteTimeDomainData(arr);
    let peak = 0;
    for (let i = 0; i < arr.length; i++) {
      const v = Math.abs(arr[i] - 128);
      if (v > peak) peak = v;
    }
    return peak / 128;
  }

  async close() {
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this._onVisibility);
    }
    this._stopKeepAlive();
    this.stopCapture();
    // audio-flow: stop the call-audio layer before tearing down the ctx.
    try { this.callAudio.destroy(); } catch {}
    if (this.ctx) { try { await this.ctx.close(); } catch {} this.ctx = null; }
  }
}
