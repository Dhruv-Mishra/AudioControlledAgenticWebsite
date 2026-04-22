// Audio pipeline: capture (AudioWorklet → PCM16 16 kHz chunks to caller),
// playback of 24 kHz PCM16 chunks with optional phone-line band-pass
// compression, and procedural ambient noise as an *independent*
// always-connected branch to ctx.destination.
//
// Design notes (from specs/live-implementation-audit.md):
//
//   • Single AudioContext for BOTH capture and playback. Two contexts was
//     an accident of history and made the first-click gesture-lineage
//     flaky because only the playback one was unlocked synchronously.
//   • Noise branch connects DIRECTLY to ctx.destination via its own gain
//     node — it is NOT routed through `playbackGain` (agent output), so
//     ambient noise plays continuously during the call even when Gemini
//     is silent.
//   • Phone-line compression filters the AGENT path only. Ambient noise
//     bypasses it — a real phone line only compresses what's travelling
//     across the line, not the room you're sitting in.
//   • Noise state machine: `setAmbientOn(true/false, { fadeMs })`. Caller
//     (VoiceAgent) drives it off session state transitions.
//   • `unlockAudioSync()` creates+resumes the ctx in the same synchronous
//     task as the user click, so Chrome honours the gesture activation.
//
// No ScriptProcessorNode anywhere.

/** Encode an Int16Array of PCM samples into an AudioBuffer for playback. */
function int16ToAudioBuffer(ctx, int16, sampleRate) {
  const buf = ctx.createBuffer(1, int16.length, sampleRate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < int16.length; i++) ch[i] = int16[i] / 32768;
  return buf;
}

/** Sized white noise -> 1/f-ish pink via IIR low-pass approximation. */
function makeNoiseBuffer(ctx, durationSec, type = 'pink') {
  const sr = ctx.sampleRate;
  const len = Math.round(durationSec * sr);
  const buf = ctx.createBuffer(1, len, sr);
  const data = buf.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < len; i++) {
    const white = Math.random() * 2 - 1;
    if (type === 'pink') {
      // Paul Kellet pink noise filter
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.96900 * b2 + white * 0.1538520;
      b3 = 0.86650 * b3 + white * 0.3104856;
      b4 = 0.55000 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.0168980;
      const pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
      b6 = white * 0.115926;
      data[i] = pink * 0.11;
    } else if (type === 'brown') {
      b0 = (b0 + 0.02 * white) / 1.02;
      data[i] = b0 * 3.5;
    } else {
      data[i] = white * 0.5;
    }
  }
  return buf;
}

/** Phone-line hiss: brown-ish noise under a narrow band-pass. */
function buildPhoneHissGraph(ctx, destGain) {
  const src = ctx.createBufferSource();
  src.buffer = makeNoiseBuffer(ctx, 8, 'brown');
  src.loop = true;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 1400;
  bp.Q.value = 0.6;
  const g = ctx.createGain();
  g.gain.value = 0.35;
  src.connect(bp).connect(g).connect(destGain);
  return { start: () => src.start(), stop: () => { try { src.stop(); } catch {} } };
}

/** Static: loud white with periodic crackle. */
function buildStaticGraph(ctx, destGain) {
  const src = ctx.createBufferSource();
  src.buffer = makeNoiseBuffer(ctx, 4, 'white');
  src.loop = true;
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 600;
  const g = ctx.createGain();
  g.gain.value = 0.22;
  src.connect(hp).connect(g).connect(destGain);
  return { start: () => src.start(), stop: () => { try { src.stop(); } catch {} } };
}

/** Office chatter: many overlapping detuned oscillators + filtered noise. */
function buildChatterGraph(ctx, destGain) {
  const nodes = [];
  const noise = ctx.createBufferSource();
  noise.buffer = makeNoiseBuffer(ctx, 6, 'pink');
  noise.loop = true;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 1800;
  const g = ctx.createGain();
  g.gain.value = 0.25;
  noise.connect(lp).connect(g).connect(destGain);
  nodes.push(noise);

  // Slow amplitude wobble so it breathes like a room.
  const lfo = ctx.createOscillator();
  const lfoGain = ctx.createGain();
  lfo.frequency.value = 0.18;
  lfoGain.gain.value = 0.06;
  lfo.connect(lfoGain).connect(g.gain);
  nodes.push(lfo);

  // Modulated carriers to hint at far-off voices.
  for (let i = 0; i < 4; i++) {
    const carrier = ctx.createOscillator();
    carrier.type = 'sine';
    carrier.frequency.value = 180 + i * 53;
    const modGain = ctx.createGain();
    modGain.gain.value = 0.012;
    const ring = ctx.createOscillator();
    ring.type = 'triangle';
    ring.frequency.value = 0.9 + i * 0.25;
    const ringGain = ctx.createGain();
    ringGain.gain.value = 8;
    ring.connect(ringGain).connect(carrier.frequency);
    carrier.connect(modGain).connect(destGain);
    nodes.push(carrier, ring);
  }

  return {
    start() { nodes.forEach((n) => { try { n.start(); } catch {} }); },
    stop()  { nodes.forEach((n) => { try { n.stop();  } catch {} }); }
  };
}

const NOISE_FACTORIES = {
  off:      () => null,
  phone:    buildPhoneHissGraph,
  office:   buildChatterGraph,
  static:   buildStaticGraph
};

const FADE_MS_DEFAULT = 220;

// Compression strength ladder (Oracle Decision 3). Indexed rows; we
// linearly interpolate between them for any strength in [0..100].
// HP 0 / LP 20000 / threshold 0 / ratio 1 / shaper=linear → pass-through at 0.
const COMPRESSION_LADDER = [
  { strength:   0, hp:    0, lp: 20000, threshold:   0, ratio: 1.0, attack: 0.003, release: 0.25, drive: 0.0 },
  { strength:  25, hp:  200, lp:  6000, threshold: -12, ratio: 2.5, attack: 0.004, release: 0.22, drive: 1.1 },
  { strength:  50, hp:  300, lp:  3400, threshold: -18, ratio: 4.5, attack: 0.006, release: 0.18, drive: 1.8 },
  { strength:  75, hp:  360, lp:  3300, threshold: -22, ratio: 6.5, attack: 0.008, release: 0.14, drive: 2.4 },
  { strength: 100, hp:  400, lp:  3200, threshold: -24, ratio: 8.0, attack: 0.010, release: 0.10, drive: 2.8 }
];

function lerp(a, b, t) { return a + (b - a) * t; }

/** Linear-interpolate ladder params for strength s in [0..100]. */
function interpolateCompressionParams(s) {
  const clamped = Math.max(0, Math.min(100, Number(s) || 0));
  for (let i = 0; i < COMPRESSION_LADDER.length - 1; i++) {
    const a = COMPRESSION_LADDER[i];
    const b = COMPRESSION_LADDER[i + 1];
    if (clamped >= a.strength && clamped <= b.strength) {
      const t = (clamped - a.strength) / (b.strength - a.strength);
      return {
        hp:        lerp(a.hp,        b.hp,        t),
        lp:        lerp(a.lp,        b.lp,        t),
        threshold: lerp(a.threshold, b.threshold, t),
        ratio:     lerp(a.ratio,     b.ratio,     t),
        attack:    lerp(a.attack,    b.attack,    t),
        release:   lerp(a.release,   b.release,   t),
        drive:     lerp(a.drive,     b.drive,     t)
      };
    }
  }
  // Out-of-range: clamp to endpoints.
  return clamped <= 0 ? COMPRESSION_LADDER[0] : COMPRESSION_LADDER[COMPRESSION_LADDER.length - 1];
}

/** 1024-sample tanh soft-clip curve. `drive` 0 = linear (pass-through). */
function makeSaturationCurve(drive) {
  const n = 1024;
  const curve = new Float32Array(n);
  const d = Math.max(0, Number(drive) || 0);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = d <= 0.001 ? x : Math.tanh(d * x);
  }
  return curve;
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
    this.agentGain = null;         // ALWAYS connects through bandPass chain now
    this.bandPass = null;          // persistent compression/filter graph
    this.bandPassEnabled = false;  // derived from compressionStrength > 0
    this.compressionStrength = 50; // 0..100 — default phone sound
    this._lastShaperBucket = -1;
    this.outputVolume = 1.0;

    // Noise graph (INDEPENDENT — connects directly to ctx.destination):
    //   noiseSource → noiseBusGain → noiseEnvelopeGain → ctx.destination
    // noiseBusGain  = user volume (slider).
    // noiseEnvelopeGain = state-machine fade gain (0 when off, bus-val when on).
    this.noiseBusGain = null;
    this.noiseEnvelopeGain = null;
    this.noiseMode = 'off';
    this.noiseNode = null;          // the current factory's node bundle
    this.noiseVolume = 0.5;
    this.ambientOn = false;

    // Human-call layer (Oracle Decision 2). SIBLING branch to destination,
    // independent of noiseBusGain and playbackGain. Runs continuously while
    // isInCall(), layered under whichever primary noiseMode is selected.
    //   [muffle/wind/breath sources] → humanLayerBusGain → humanLayerEnvelopeGain → ctx.destination
    this.humanLayerBusGain = null;
    this.humanLayerEnvelopeGain = null;
    this.humanLayerVolume = 0.6;
    this.humanLayerOn = false;
    this.humanLayer = null;         // { muffle, wind, breathBuffer, muffleFilter, windFilter, windGain, windLFO, windLFOGain }
    this._breathTimer = null;

    this._analyser = null;
    this._micAnalyser = null;

    // Keep-alive watchdog — periodically resume the context if Chrome
    // decides to suspend it while idle. Bound in unlockAudioSync().
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

    // Agent-output chain: agentGain → HP → LP → Compressor → WaveShaper → compOut → playbackGain → destination
    // ALL nodes are persistent. setCompressionStrength(0) interpolates them
    // to transparent pass-through; setCompressionStrength(100) to heavy
    // walkie-talkie. No reconnects on strength changes — just param ramps.
    this.playbackGain = ctx.createGain();
    this.playbackGain.gain.value = this.outputVolume;
    this.playbackGain.connect(ctx.destination);

    // Analyser on agent audio (for VU meter).
    this._analyser = ctx.createAnalyser();
    this._analyser.fftSize = 256;
    this.playbackGain.connect(this._analyser);

    this.agentGain = ctx.createGain();
    this.agentGain.gain.value = 1;

    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 0;
    hp.Q.value = 0.7;

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 20000;
    lp.Q.value = 0.7;

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = 0;
    comp.ratio.value = 1;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;
    comp.knee.value = 24;

    const shaper = ctx.createWaveShaper();
    shaper.curve = makeSaturationCurve(0); // linear at strength 0

    const compOut = ctx.createGain();
    compOut.gain.value = 1;

    this.agentGain.connect(hp).connect(lp).connect(comp).connect(shaper).connect(compOut).connect(this.playbackGain);
    this.bandPass = { hp, lp, comp, shaper, out: compOut };
    this._lastShaperBucket = 0;

    // NOISE: fully independent branch, direct to ctx.destination.
    //   noiseSource.node → noiseBusGain (user volume) → noiseEnvelopeGain (fade) → destination
    this.noiseBusGain = ctx.createGain();
    this.noiseBusGain.gain.value = this.noiseVolume;
    this.noiseEnvelopeGain = ctx.createGain();
    this.noiseEnvelopeGain.gain.value = 0; // starts muted — VoiceAgent fades it in
    this.noiseBusGain.connect(this.noiseEnvelopeGain).connect(ctx.destination);

    // HUMAN-CALL LAYER: sibling branch. Lazy-built on first setHumanLayerOn(true).
    this.humanLayerBusGain = ctx.createGain();
    this.humanLayerBusGain.gain.value = this.humanLayerVolume;
    this.humanLayerEnvelopeGain = ctx.createGain();
    this.humanLayerEnvelopeGain.gain.value = 0;
    this.humanLayerBusGain.connect(this.humanLayerEnvelopeGain).connect(ctx.destination);

    // Apply any persisted compression strength NOW that the graph exists.
    this.setCompressionStrength(this.compressionStrength);
  }

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
    src.connect(this.agentGain);
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

  // ----- Noise (ambient) -----

  setNoiseVolume(v) {
    this.noiseVolume = Math.max(0, Math.min(1, v));
    if (this.noiseBusGain) this.noiseBusGain.gain.value = this.noiseVolume;
  }

  /** Backwards-compat shim. Binary callers map to strength 50 (default
   *  phone sound) or 0 (pass-through). The persistent graph means no
   *  reconnects happen — we just ramp the nodes' params. */
  setBandPassEnabled(on) {
    this.setCompressionStrength(on ? 50 : 0);
    this.bandPassEnabled = !!on;
  }

  /** Interpolate compression params for strength 0..100. Applied via
   *  setTargetAtTime with 50 ms time constant so slider drags produce
   *  smooth audible changes and zero clicks. */
  setCompressionStrength(strength) {
    const s = Math.max(0, Math.min(100, Number(strength) || 0));
    this.compressionStrength = s;
    this.bandPassEnabled = s > 0;
    if (!this.bandPass || !this.ctx) return;
    const p = interpolateCompressionParams(s);
    const now = this.ctx.currentTime;
    const tau = 0.05;
    try { this.bandPass.hp.frequency.setTargetAtTime(p.hp, now, tau); } catch {}
    try { this.bandPass.lp.frequency.setTargetAtTime(p.lp, now, tau); } catch {}
    try { this.bandPass.comp.threshold.setTargetAtTime(p.threshold, now, tau); } catch {}
    try { this.bandPass.comp.ratio.setTargetAtTime(p.ratio, now, tau); } catch {}
    try { this.bandPass.comp.attack.setTargetAtTime(p.attack, now, tau); } catch {}
    try { this.bandPass.comp.release.setTargetAtTime(p.release, now, tau); } catch {}
    // Regenerate the saturation curve only when crossing a 10% bucket.
    const bucket = Math.floor(s / 10);
    if (bucket !== this._lastShaperBucket) {
      try { this.bandPass.shaper.curve = makeSaturationCurve(p.drive); } catch {}
      this._lastShaperBucket = bucket;
    }
  }

  getCompressionStrength() { return this.compressionStrength; }

  // ----- Human-call layer (muffle + wind + breath) -----

  /** Build the three procedural components once. Lazy — only on first
   *  setHumanLayerOn(true). If the user never places a call, no
   *  allocation happens. */
  _buildHumanLayer() {
    if (this.humanLayer || !this.ctx || !this.humanLayerBusGain) return;
    const ctx = this.ctx;

    // 1. Muffle: brown noise loop → lowpass 200 Hz → gain 0.12.
    const muffleSrc = ctx.createBufferSource();
    muffleSrc.buffer = makeNoiseBuffer(ctx, 10, 'brown');
    muffleSrc.loop = true;
    const muffleLp = ctx.createBiquadFilter();
    muffleLp.type = 'lowpass';
    muffleLp.frequency.value = 200;
    muffleLp.Q.value = 0.5;
    const muffleGain = ctx.createGain();
    muffleGain.gain.value = 0.12;
    muffleSrc.connect(muffleLp).connect(muffleGain).connect(this.humanLayerBusGain);

    // 2. Wind: pink noise loop → bandpass 300 Hz Q 1.2 → gain 0.08.
    //    LFO 0.08 Hz on gain adds slow breathing.
    const windSrc = ctx.createBufferSource();
    windSrc.buffer = makeNoiseBuffer(ctx, 10, 'pink');
    windSrc.loop = true;
    const windBp = ctx.createBiquadFilter();
    windBp.type = 'bandpass';
    windBp.frequency.value = 300;
    windBp.Q.value = 1.2;
    const windGain = ctx.createGain();
    windGain.gain.value = 0.08;
    windSrc.connect(windBp).connect(windGain).connect(this.humanLayerBusGain);
    const windLfo = ctx.createOscillator();
    windLfo.type = 'sine';
    windLfo.frequency.value = 0.08;
    const windLfoGain = ctx.createGain();
    windLfoGain.gain.value = 0.06;
    windLfo.connect(windLfoGain).connect(windGain.gain);

    // 3. Breath: pre-render a 0.3s pink-noise burst with baked ADSR.
    const breathBuffer = this._makeBreathBuffer(ctx);

    try { muffleSrc.start(); } catch {}
    try { windSrc.start(); } catch {}
    try { windLfo.start(); } catch {}

    this.humanLayer = {
      muffleSrc, muffleLp, muffleGain,
      windSrc, windBp, windGain, windLfo, windLfoGain,
      breathBuffer
    };
  }

  /** 0.3 s pink-noise burst with exp attack (30 ms) + exp decay (270 ms).
   *  Shape baked into the buffer so runtime playback needs no gain ramps. */
  _makeBreathBuffer(ctx) {
    const sr = ctx.sampleRate;
    const dur = 0.3;
    const len = Math.round(dur * sr);
    const buf = ctx.createBuffer(1, len, sr);
    const data = buf.getChannelData(0);
    const attackSamples = Math.round(0.03 * sr);
    const decaySamples = len - attackSamples;
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.96900 * b2 + white * 0.1538520;
      b3 = 0.86650 * b3 + white * 0.3104856;
      b4 = 0.55000 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.0168980;
      const pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
      b6 = white * 0.115926;
      // ADSR envelope: exp attack, exp decay to zero.
      let env;
      if (i < attackSamples) {
        const t = i / attackSamples;
        env = 1 - Math.exp(-3 * t);
      } else {
        const t = (i - attackSamples) / decaySamples;
        env = Math.exp(-3 * t);
      }
      data[i] = pink * 0.11 * env;
    }
    return buf;
  }

  _scheduleBreath() {
    if (!this.humanLayer || !this.humanLayerOn || !this.ctx) return;
    // Jittered interval 4000..8000 ms. setTimeout drift at these scales is
    // inaudible; the layer is garnish, not load-bearing.
    const nextMs = 4000 + Math.random() * 4000;
    this._breathTimer = setTimeout(() => {
      this._breathTimer = null;
      if (!this.humanLayer || !this.humanLayerOn || !this.ctx) return;
      try {
        const src = this.ctx.createBufferSource();
        src.buffer = this.humanLayer.breathBuffer;
        const lp = this.ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 900;
        lp.Q.value = 0.4;
        const g = this.ctx.createGain();
        g.gain.value = 0.03;
        src.connect(lp).connect(g).connect(this.humanLayerBusGain);
        const offset = Math.random() * 0.05;
        src.start(this.ctx.currentTime + 0.02 + offset);
        src.onended = () => {
          try { src.disconnect(); } catch {}
          try { lp.disconnect(); } catch {}
          try { g.disconnect(); } catch {}
        };
      } catch {}
      this._scheduleBreath();
    }, nextMs);
  }

  /** Toggle the muffle + wind + breath layer with a short fade. Mirrors
   *  setAmbientOn; a mid-call re-assert is a cheap no-op ramp. */
  setHumanLayerOn(on, { fadeMs = FADE_MS_DEFAULT } = {}) {
    if (!this.ctx || !this.humanLayerEnvelopeGain) {
      this.humanLayerOn = !!on;
      return;
    }
    if (on && !this.humanLayer) {
      try { this._buildHumanLayer(); } catch {}
    }
    this.humanLayerOn = !!on;
    const gain = this.humanLayerEnvelopeGain.gain;
    const now = this.ctx.currentTime;
    try { gain.cancelScheduledValues(now); } catch {}
    gain.setValueAtTime(gain.value, now);
    const target = on ? 1 : 0;
    const timeConst = Math.max(0.01, (fadeMs / 1000) / 3);
    gain.setTargetAtTime(target, now, timeConst);
    // Scheduler lifecycle: start when turning on (if not already running);
    // clear on turn-off.
    if (on) {
      if (!this._breathTimer) this._scheduleBreath();
    } else {
      if (this._breathTimer) { clearTimeout(this._breathTimer); this._breathTimer = null; }
    }
  }

  setHumanLayerVolume(v) {
    this.humanLayerVolume = Math.max(0, Math.min(1, Number(v) || 0));
    if (this.humanLayerBusGain) this.humanLayerBusGain.gain.value = this.humanLayerVolume;
  }

  setNoiseMode(mode) {
    const next = String(mode || 'off');
    if (!this.ctx) {
      this.noiseMode = next;   // remember for when ctx comes up
      return;
    }
    // Idempotent: if mode hasn't changed and a source is already running,
    // don't stop/rebuild. Re-creation would produce a tiny click when the
    // envelope happens to be > 0 and the user re-applies their effective
    // setting (e.g. on first gesture restoring persisted prefs).
    if (next === this.noiseMode && (this.noiseNode || next === 'off')) {
      return;
    }
    // Stop any currently-playing source cleanly. The ENVELOPE gain
    // controls whether the user hears it; stopping the source just
    // releases the oscillators under the hood.
    if (this.noiseNode) { try { this.noiseNode.stop(); } catch {} this.noiseNode = null; }
    this.noiseMode = next;
    const factory = NOISE_FACTORIES[this.noiseMode];
    if (!factory) return;
    const node = factory(this.ctx, this.noiseBusGain);
    if (node) { node.start(); this.noiseNode = node; }
  }

  /**
   * Toggle ambient playback with a short fade. Called by VoiceAgent on
   * session state transitions (LIVE_OPENING → on, IDLE/ERROR → off).
   *
   * The source (if present) keeps running under the hood; only the
   * envelope gain ramps. Fade avoids clicks/pops and matches a real
   * phone-call background's in/out.
   */
  setAmbientOn(on, { fadeMs = FADE_MS_DEFAULT } = {}) {
    if (!this.ctx || !this.noiseEnvelopeGain) {
      this.ambientOn = !!on;
      return;
    }
    // Lazy: if the user wants ambient on but we haven't instantiated the
    // noise source yet, build it now. This covers the "user clicks Place
    // Call as their first gesture" path — unlockAudioSync created the ctx
    // and graph, but setNoiseMode was never called.
    if (on && !this.noiseNode && this.noiseMode && this.noiseMode !== 'off') {
      const factory = NOISE_FACTORIES[this.noiseMode];
      if (factory) {
        const node = factory(this.ctx, this.noiseBusGain);
        if (node) { node.start(); this.noiseNode = node; }
      }
    }
    // If the user picked 'off', keep envelope at 0.
    const targetLevel = (!on || this.noiseMode === 'off') ? 0 : 1;
    this.ambientOn = !!on;
    const gain = this.noiseEnvelopeGain.gain;
    const now = this.ctx.currentTime;
    // Cancel any scheduled ramp and set the "from" value explicitly so
    // setTargetAtTime starts from the actual current gain.
    try { gain.cancelScheduledValues(now); } catch {}
    gain.setValueAtTime(gain.value, now);
    // Exponential-like approach using setTargetAtTime; time constant ~
    // fadeMs/3 gives ~95% travel in fadeMs.
    const timeConst = Math.max(0.01, (fadeMs / 1000) / 3);
    gain.setTargetAtTime(targetLevel, now, timeConst);
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
    if (this._breathTimer) { clearTimeout(this._breathTimer); this._breathTimer = null; }
    this.humanLayerOn = false;
    if (this.humanLayer) {
      try { this.humanLayer.muffleSrc.stop(); } catch {}
      try { this.humanLayer.windSrc.stop(); } catch {}
      try { this.humanLayer.windLfo.stop(); } catch {}
      this.humanLayer = null;
    }
    if (this.noiseNode) { try { this.noiseNode.stop(); } catch {} this.noiseNode = null; }
    if (this.ctx) { try { await this.ctx.close(); } catch {} this.ctx = null; }
  }
}
