// Audio-DSP smoke. Behavioural-only — no real audio synthesis.
//
// What we assert (Oracle v2 decisions 2 + 3):
//   1. Ambient continuity: during a scripted in-call state sequence, the
//      primary ambient envelope AND the human-call layer envelope never
//      have their setTargetAtTime target drop below the steady-state
//      target of 1. (Mid-call re-asserts must be no-op ramps.)
//   2. Compression ladder monotonicity: as strength steps 0 → 50 → 100,
//      the highpass frequency target must be non-decreasing and the
//      lowpass target must be non-increasing.
//   3. Breath scheduler: never schedules two bursts closer than 2 s.
//
// How it runs in Node: we shim the Web Audio API with param recorders.
// Every AudioParam tracks its setTargetAtTime / setValueAtTime history
// so we can diff after a state sequence. We DO NOT actually generate
// audio or run oscillators.
//
// Usage:
//   node evals/audio-dsp-smoke.js   (no server required)

'use strict';

const path = require('path');
const { pathToFileURL } = require('url');

let FAIL = 0;
function assert(cond, msg) {
  if (cond) { console.log(`PASS  ${msg}`); }
  else      { console.error(`FAIL  ${msg}`); FAIL += 1; }
}

// ---------- Fake Web Audio ----------

let now = 0;
const advanceClock = (seconds) => { now += seconds; };

class FakeParam {
  constructor(label, initial) {
    this.label = label;
    this.value = initial;
    this.history = [{ kind: 'init', t: 0, value: initial }];
  }
  setValueAtTime(v, t)       { this.value = v; this.history.push({ kind: 'setValue',       t, value: v }); return this; }
  setTargetAtTime(v, t, tau) { this.value = v; this.history.push({ kind: 'setTargetAtTime', t, value: v, tau }); return this; }
  linearRampToValueAtTime(v, t) { this.value = v; this.history.push({ kind: 'linearRamp',   t, value: v }); return this; }
  exponentialRampToValueAtTime(v, t) { this.value = v; this.history.push({ kind: 'expRamp', t, value: v }); return this; }
  cancelScheduledValues(t)   { this.history.push({ kind: 'cancel', t }); return this; }
}

let nodeId = 0;
class FakeNode {
  constructor(kind) { this.__kind = kind; this.__id = ++nodeId; this.__inputs = []; this.__outputs = []; }
  connect(dest)    { this.__outputs.push(dest); if (dest && dest.__inputs) dest.__inputs.push(this); return dest; }
  disconnect()     { this.__outputs = []; }
}
class FakeGainNode extends FakeNode     { constructor() { super('gain'); this.gain = new FakeParam('gain', 1); } }
class FakeBiquad       extends FakeNode { constructor() { super('biquad'); this.type = 'lowpass'; this.frequency = new FakeParam('freq', 350); this.Q = new FakeParam('Q', 1); this.gain = new FakeParam('biquad.gain', 0); } }
class FakeCompressor   extends FakeNode { constructor() { super('compressor'); this.threshold = new FakeParam('threshold', 0); this.ratio = new FakeParam('ratio', 1); this.attack = new FakeParam('attack', 0.003); this.release = new FakeParam('release', 0.25); this.knee = new FakeParam('knee', 24); } }
class FakeWaveShaper   extends FakeNode { constructor() { super('shaper'); this._curve = null; } get curve() { return this._curve; } set curve(c) { this._curve = c; this.__curveSetCount = (this.__curveSetCount || 0) + 1; } }
class FakeOscillator   extends FakeNode { constructor() { super('osc'); this.frequency = new FakeParam('osc.freq', 0); this.type = 'sine'; this.__started = false; } start() { this.__started = true; } stop() { this.__started = false; } }
class FakeBufferSource extends FakeNode { constructor() { super('bufsrc'); this.loop = false; this.buffer = null; this.__started = false; } start(t) { this.__started = true; this.__startedAt = t; } stop() { this.__started = false; } }
class FakeAnalyser     extends FakeNode { constructor() { super('analyser'); this.fftSize = 2048; this.frequencyBinCount = 1024; } getByteTimeDomainData(arr) { arr.fill(128); } }
class FakeBuffer {
  constructor(channels, length, sr) { this.numberOfChannels = channels; this.length = length; this.sampleRate = sr; this._data = new Float32Array(length); }
  getChannelData() { return this._data; }
}

class FakeAudioContext {
  constructor() { this.state = 'running'; this.sampleRate = 48000; this.destination = new FakeNode('destination'); }
  get currentTime() { return now; }
  createGain()              { return new FakeGainNode(); }
  createBiquadFilter()      { return new FakeBiquad(); }
  createDynamicsCompressor(){ return new FakeCompressor(); }
  createWaveShaper()        { return new FakeWaveShaper(); }
  createOscillator()        { return new FakeOscillator(); }
  createBufferSource()      { return new FakeBufferSource(); }
  createAnalyser()          { return new FakeAnalyser(); }
  createBuffer(ch, len, sr) { return new FakeBuffer(ch, len, sr); }
  resume() { this.state = 'running'; return Promise.resolve(); }
  close()  { this.state = 'closed';  return Promise.resolve(); }
}

// ---------- setTimeout spy for breath scheduler ----------

const scheduledDelays = [];
let nextTimerId = 1;
const pendingTimers = new Map(); // id -> { fn, fireAt }
const realSetTimeout = global.setTimeout;
const realClearTimeout = global.clearTimeout;
function installTimerSpy() {
  global.setTimeout = function (fn, ms) {
    scheduledDelays.push(ms);
    const id = nextTimerId++;
    pendingTimers.set(id, { fn, ms });
    return id;
  };
  global.clearTimeout = function (id) {
    pendingTimers.delete(id);
  };
}
function uninstallTimerSpy() {
  global.setTimeout = realSetTimeout;
  global.clearTimeout = realClearTimeout;
}
function runOnePendingTimer() {
  const [id, entry] = pendingTimers.entries().next().value || [];
  if (!entry) return false;
  pendingTimers.delete(id);
  try { entry.fn(); } catch {}
  return true;
}

// ---------- Install globals and import the ESM module ----------

global.window = { AudioContext: FakeAudioContext, webkitAudioContext: FakeAudioContext };
// document is used by AudioPipeline visibility listener — give it a stub.
global.document = {
  addEventListener() {}, removeEventListener() {}, visibilityState: 'visible'
};

async function main() {
  installTimerSpy();
  try {
    const modUrl = pathToFileURL(path.resolve(__dirname, '..', 'js', 'audio-pipeline.js')).href;
    const mod = await import(modUrl);
    if (!mod || typeof mod.AudioPipeline !== 'function') {
      console.error('FAIL  could not import AudioPipeline from js/audio-pipeline.js');
      process.exit(2);
    }
    const { AudioPipeline } = mod;

    // Test 1: Ambient continuity invariant during a call-active sequence.
    await testAmbientContinuity(AudioPipeline);

    // Test 2: Compression ladder monotonicity.
    await testCompressionMonotonic(AudioPipeline);

    // Test 3: Breath scheduler never schedules overlapping bursts closer than 2 s.
    await testBreathScheduler(AudioPipeline);

    if (FAIL === 0) {
      console.log(`\nAll audio-DSP smoke checks passed.`);
      process.exit(0);
    }
    console.error(`\n${FAIL} failure(s).`);
    process.exit(1);
  } finally {
    uninstallTimerSpy();
  }
}

async function testAmbientContinuity(AudioPipeline) {
  console.log('\n--- ambient continuity ---');
  now = 0;
  const p = new AudioPipeline();
  p.unlockAudioSync();

  // Simulate VoiceAgent's drive: set noise mode then flip layers on.
  p.setNoiseMode('office');
  p.setAmbientOn(true, { fadeMs: 220 });
  p.setHumanLayerOn(true, { fadeMs: 220 });

  // Record the steady targets.
  const ambientHistory0 = p.noiseEnvelopeGain.gain.history.filter((e) => e.kind === 'setTargetAtTime').slice();
  const humanHistory0   = p.humanLayerEnvelopeGain.gain.history.filter((e) => e.kind === 'setTargetAtTime').slice();

  // Simulate six mid-call state re-asserts (_updateAmbient on every _setState).
  // Each is a wasActive=true scenario → fadeMs=40, target=1.
  for (let i = 0; i < 6; i++) {
    advanceClock(0.05);
    p.setAmbientOn(true, { fadeMs: 40 });
    p.setHumanLayerOn(true, { fadeMs: 40 });
  }

  // Assertion: no setTargetAtTime call on either envelope ever dropped
  // target below 1 during the in-call sequence.
  const ambientTargets = p.noiseEnvelopeGain.gain.history.filter((e) => e.kind === 'setTargetAtTime').map((e) => e.value);
  const humanTargets   = p.humanLayerEnvelopeGain.gain.history.filter((e) => e.kind === 'setTargetAtTime').map((e) => e.value);

  const ambientOK = ambientTargets.length >= 1 && ambientTargets.every((v) => v === 1);
  const humanOK   = humanTargets.length   >= 1 && humanTargets.every((v) => v === 1);
  assert(ambientOK, `ambient envelope never dipped (targets=${JSON.stringify(ambientTargets)})`);
  assert(humanOK,   `human-layer envelope never dipped (targets=${JSON.stringify(humanTargets)})`);

  // On end-of-call, both should ramp to 0.
  advanceClock(0.1);
  p.setAmbientOn(false, { fadeMs: 300 });
  p.setHumanLayerOn(false, { fadeMs: 300 });
  const lastAmb = p.noiseEnvelopeGain.gain.history.filter((e) => e.kind === 'setTargetAtTime').pop();
  const lastHum = p.humanLayerEnvelopeGain.gain.history.filter((e) => e.kind === 'setTargetAtTime').pop();
  assert(lastAmb && lastAmb.value === 0, 'ambient ramps to 0 on call end');
  assert(lastHum && lastHum.value === 0, 'human layer ramps to 0 on call end');
}

async function testCompressionMonotonic(AudioPipeline) {
  console.log('\n--- compression ladder monotonicity ---');
  now = 0;
  const p = new AudioPipeline();
  p.unlockAudioSync();

  const samples = [];
  for (const s of [0, 25, 50, 75, 100]) {
    advanceClock(0.05);
    p.setCompressionStrength(s);
    samples.push({ s, hp: p.bandPass.hp.frequency.value, lp: p.bandPass.lp.frequency.value, ratio: p.bandPass.comp.ratio.value });
  }
  console.log('  samples:', JSON.stringify(samples));

  // HP frequency must be non-decreasing (tighter band as strength rises).
  let hpMono = true;
  for (let i = 1; i < samples.length; i++) if (samples[i].hp < samples[i - 1].hp) hpMono = false;
  assert(hpMono, `highpass frequency non-decreasing with strength`);

  // LP frequency must be non-increasing.
  let lpMono = true;
  for (let i = 1; i < samples.length; i++) if (samples[i].lp > samples[i - 1].lp) lpMono = false;
  assert(lpMono, `lowpass frequency non-increasing with strength`);

  // Ratio must be non-decreasing (more compression as strength rises).
  let ratioMono = true;
  for (let i = 1; i < samples.length; i++) if (samples[i].ratio < samples[i - 1].ratio) ratioMono = false;
  assert(ratioMono, `compression ratio non-decreasing with strength`);

  // At strength 0 the graph must be pass-through-ish: HP 0, LP 20000, ratio 1.
  const zero = samples[0];
  assert(zero.hp === 0 && zero.lp === 20000 && zero.ratio === 1, 'strength 0 is pass-through');

  // Sub-range: setting strength 50 twice in a row should be idempotent
  // (same target) and produce NO reconnect (no disconnect on agentGain).
  // We verify by checking the bandPass nodes are the same references.
  const hpBefore = p.bandPass.hp;
  p.setCompressionStrength(50);
  advanceClock(0.02);
  p.setCompressionStrength(50);
  assert(p.bandPass.hp === hpBefore, 'setCompressionStrength does not rewire the agent chain');
}

async function testBreathScheduler(AudioPipeline) {
  console.log('\n--- breath scheduler ---');
  now = 0;
  scheduledDelays.length = 0;
  pendingTimers.clear();
  const p = new AudioPipeline();
  p.unlockAudioSync();
  p.setHumanLayerOn(true, { fadeMs: 40 });

  // Run 50 rescheduled fires to sample enough jitter.
  for (let i = 0; i < 50; i++) {
    if (!runOnePendingTimer()) break;
  }
  // Every scheduled delay should be ≥ 4000 ms (so inter-burst gap ≥ 4 s,
  // which is well above the 2-s "no overlap" threshold Oracle called out).
  const minDelay = scheduledDelays.length ? Math.min(...scheduledDelays) : Infinity;
  assert(scheduledDelays.length >= 10, `breath scheduler fired ${scheduledDelays.length} times (want ≥10)`);
  assert(minDelay >= 4000, `breath inter-burst delay ≥ 4000 ms (min=${minDelay})`);
  assert(minDelay < 9000,  `breath inter-burst delay < 9000 ms (min=${minDelay})`); // 8000 upper bound + slack

  // setHumanLayerOn(false) must clear the timer so no more delays queue.
  const beforeOff = scheduledDelays.length;
  p.setHumanLayerOn(false, { fadeMs: 40 });
  // If a timer was pending, it's cleared — running the runner should return false.
  const hadPending = pendingTimers.size > 0;
  assert(!hadPending, 'breath scheduler cleared on setHumanLayerOn(false)');

  // No new delays appended after off.
  const afterOff = scheduledDelays.length;
  assert(afterOff === beforeOff, 'no new breath reschedule after off');
}

main().catch((err) => {
  console.error('ERROR', err && (err.stack || err.message || err));
  process.exit(1);
});
