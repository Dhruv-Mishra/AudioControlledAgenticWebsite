// audio-flow: call-audio smoke. Behavioural — no real audio synthesis.
//
// What we assert after the audio-choreography refactor:
//   1. CallAudioController preloads THREE distinct HTMLAudioElement
//      instances (callOpen / background / callClose) with either
//      `.webm` or `.mp3` sources depending on canPlayType probe.
//   2. `playCallOpen` resolves on `ended`, on `error`, or after the 6 s
//      safety cap — never rejects and never stalls indefinitely.
//   3. `startBackground` + `stopBackground` are idempotent and tied to
//      the `backgroundEnabled` toggle — a disabled controller is a
//      no-op.
//   4. `playCallClose` resolves under the same rules as `playCallOpen`.
//   5. A background `'ended'` event while the loop is expected triggers
//      an auto-restart (watchdog for browsers that drop `loop=true`).
//   6. Phone-line compression is OFF by default and can be toggled with
//      `setPhoneCompression()` without throwing.
//
// How it runs in Node: shim Web Audio + HTMLAudioElement with tiny
// behavioural fakes. No real audio, no real DOM.

'use strict';

const path = require('path');
const { pathToFileURL } = require('url');

let FAIL = 0;
function assert(cond, msg) {
  if (cond) { console.log(`PASS  ${msg}`); }
  else      { console.error(`FAIL  ${msg}`); FAIL += 1; }
}

// ---------- Fake Web Audio (minimal — just what AudioPipeline needs) ----------

let now = 0;

class FakeParam {
  constructor(initial) { this.value = initial; }
  setValueAtTime(v)       { this.value = v; return this; }
  setTargetAtTime(v)      { this.value = v; return this; }
  linearRampToValueAtTime(v) { this.value = v; return this; }
  exponentialRampToValueAtTime(v) { this.value = v; return this; }
  cancelScheduledValues() { return this; }
}

class FakeNode {
  constructor(kind) { this.__kind = kind; }
  connect(dest)    { return dest; }
  disconnect()     {}
}
class FakeGainNode extends FakeNode { constructor() { super('gain'); this.gain = new FakeParam(1); } }
class FakeBiquadFilter extends FakeNode {
  constructor() { super('biquad'); this.type = 'lowpass'; this.frequency = new FakeParam(350); this.Q = new FakeParam(1); this.gain = new FakeParam(0); }
}
class FakeCompressor extends FakeNode {
  constructor() {
    super('compressor');
    this.threshold = new FakeParam(-24);
    this.knee = new FakeParam(30);
    this.ratio = new FakeParam(12);
    this.attack = new FakeParam(0.003);
    this.release = new FakeParam(0.25);
  }
}
class FakeBufferSource extends FakeNode {
  constructor() { super('bufsrc'); this.__started = false; }
  start()        { this.__started = true; }
  stop()         { this.__started = false; }
  set onended(_) {}
}
class FakeAnalyser extends FakeNode {
  constructor() { super('analyser'); this.fftSize = 256; this.frequencyBinCount = 128; }
  getByteTimeDomainData(arr) { arr.fill(128); }
}
class FakeBuffer {
  constructor(ch, len, sr) { this.numberOfChannels = ch; this.length = len; this.sampleRate = sr; this._data = new Float32Array(len); }
  getChannelData() { return this._data; }
}

class FakeAudioContext {
  constructor() { this.state = 'running'; this.sampleRate = 48000; this.destination = new FakeNode('destination'); }
  get currentTime() { return now; }
  createGain()      { return new FakeGainNode(); }
  createAnalyser()  { return new FakeAnalyser(); }
  createBufferSource() { return new FakeBufferSource(); }
  createBuffer(ch, len, sr) { return new FakeBuffer(ch, len, sr); }
  createBiquadFilter() { return new FakeBiquadFilter(); }
  createDynamicsCompressor() { return new FakeCompressor(); }
  resume()          { this.state = 'running'; return Promise.resolve(); }
  close()           { this.state = 'closed'; return Promise.resolve(); }
}

// ---------- Fake HTMLAudioElement ----------

const createdAudios = [];
class FakeAudio {
  constructor() {
    this.src = '';
    this.preload = 'none';
    this.loop = false;
    this.volume = 1;
    this.muted = false;
    this.currentTime = 0;
    this.paused = true;
    this._listeners = {};
    this._playCount = 0;
    this._pauseCount = 0;
    createdAudios.push(this);
  }
  addEventListener(type, fn, opts) {
    (this._listeners[type] = this._listeners[type] || []).push({ fn, opts });
  }
  removeEventListener(type, fn) {
    if (!this._listeners[type]) return;
    this._listeners[type] = this._listeners[type].filter((l) => l.fn !== fn);
  }
  dispatchEvent(type) {
    const list = (this._listeners[type] || []).slice();
    for (const { fn, opts } of list) {
      try { fn({ type }); } catch {}
      if (opts && opts.once) this.removeEventListener(type, fn);
    }
  }
  play() {
    this._playCount += 1;
    this.paused = false;
    return Promise.resolve();
  }
  pause() { this._pauseCount += 1; this.paused = true; }
  load()  {}
  canPlayType(mime) {
    // Default: we CAN play webm+opus (modern Chromium/Firefox path).
    if (/webm/i.test(mime) && /opus/i.test(mime)) return 'probably';
    if (/mpeg/i.test(mime)) return 'probably';
    return '';
  }
  removeAttribute(k) { this[k] = ''; }
}

// audio-flow: swap canPlayType behaviour per test to verify the
// mp3-fallback branch still works on Safari-ish browsers.
function installWebmCapableAudio() {
  global.Audio = class extends FakeAudio {
    canPlayType(mime) {
      if (/webm/i.test(mime) && /opus/i.test(mime)) return 'probably';
      if (/mpeg/i.test(mime)) return 'probably';
      return '';
    }
  };
  global.document = {
    createElement: (tag) => (tag === 'audio') ? new global.Audio() : { addEventListener() {}, removeEventListener() {} },
    addEventListener() {}, removeEventListener() {}, visibilityState: 'visible'
  };
}

function installMp3OnlyAudio() {
  global.Audio = class extends FakeAudio {
    canPlayType(mime) {
      if (/mpeg/i.test(mime)) return 'probably';
      return '';
    }
  };
  global.document = {
    createElement: (tag) => (tag === 'audio') ? new global.Audio() : { addEventListener() {}, removeEventListener() {} },
    addEventListener() {}, removeEventListener() {}, visibilityState: 'visible'
  };
}

// ---------- Install globals + import ----------

global.window = { AudioContext: FakeAudioContext, webkitAudioContext: FakeAudioContext };

async function main() {
  installWebmCapableAudio();
  const modUrl = pathToFileURL(path.resolve(__dirname, '..', 'js', 'audio-pipeline.js')).href;
  // Force re-import per test by appending a cache-busting query — critical
  // because audio-pipeline caches `canPlayWebmOpus` at module scope.
  async function freshImport() {
    createdAudios.length = 0;
    const mod = await import(modUrl + '?t=' + Math.random() + '_' + Date.now());
    if (!mod || typeof mod.AudioPipeline !== 'function') {
      throw new Error('could not import AudioPipeline');
    }
    return mod.AudioPipeline;
  }

  await testPreloadWebm(await freshImport());
  await testPreloadMp3Fallback(await (async () => { installMp3OnlyAudio(); const r = await freshImport(); installWebmCapableAudio(); return r; })());
  await testPlayCallOpenResolvesOnEnded(await freshImport());
  await testPlayCallOpenResolvesOnTimeout(await freshImport());
  await testBackgroundToggle(await freshImport());
  await testBackgroundStartStopIdempotent(await freshImport());
  await testBackgroundLoopWatchdog(await freshImport());
  await testPlayCallCloseResolves(await freshImport());
  await testPhoneCompressionToggle(await freshImport());
  await testNoLegacyNoiseSurface(await freshImport());

  if (FAIL === 0) {
    console.log(`\nAll audio-flow smoke checks passed.`);
    process.exit(0);
  }
  console.error(`\n${FAIL} failure(s).`);
  process.exit(1);
}

async function testPreloadWebm(AudioPipeline) {
  console.log('\n--- preload: webm branch ---');
  installWebmCapableAudio();
  createdAudios.length = 0;
  const p = new AudioPipeline();

  // audio-flow: the controller also runs a one-shot canPlayType probe on
  // a throwaway Audio element, so we may see 1 extra entry with empty
  // src. Filter to only the real lifecycle clips for the main asserts.
  const clips = createdAudios.filter((a) => typeof a.src === 'string' && a.src.length > 0);
  assert(clips.length === 3, `exactly three clip Audio elements created (got ${clips.length})`);
  const srcs = clips.map((a) => a.src);
  assert(srcs.some((s) => /callOpen\.webm/.test(s)),   `callOpen.webm preloaded (${JSON.stringify(srcs)})`);
  assert(srcs.some((s) => /background\.webm/.test(s)), `background.webm preloaded`);
  assert(srcs.some((s) => /callClose\.webm/.test(s)),  `callClose.webm preloaded`);
  // preload='auto' so the browser downloads eagerly.
  assert(clips.every((a) => a.preload === 'auto'), 'all clips have preload="auto"');
  // Background must loop; open/close must NOT.
  const bg = clips.find((a) => /background/.test(a.src));
  const open = clips.find((a) => /callOpen/.test(a.src));
  const close = clips.find((a) => /callClose/.test(a.src));
  assert(bg && bg.loop === true, 'background loops');
  assert(open && open.loop === false, 'callOpen does NOT loop');
  assert(close && close.loop === false, 'callClose does NOT loop');
  await p.close();
}

async function testPreloadMp3Fallback(AudioPipeline) {
  console.log('\n--- preload: mp3 fallback branch ---');
  // Caller ensures this test's AudioPipeline was fresh-imported while the
  // Mp3-only Audio shim was installed, so canPlayWebmOpus cached `false`.
  installMp3OnlyAudio();
  createdAudios.length = 0;
  const p = new AudioPipeline();
  const clips = createdAudios.filter((a) => typeof a.src === 'string' && a.src.length > 0);
  const srcs = clips.map((a) => a.src);
  assert(srcs.some((s) => /callOpen\.mp3/.test(s)),   `callOpen.mp3 used when webm unsupported (got ${JSON.stringify(srcs)})`);
  assert(srcs.some((s) => /background\.mp3/.test(s)), `background.mp3 used when webm unsupported`);
  assert(srcs.some((s) => /callClose\.mp3/.test(s)),  `callClose.mp3 used when webm unsupported`);
  await p.close();
}

async function testPlayCallOpenResolvesOnEnded(AudioPipeline) {
  console.log('\n--- playCallOpen: resolves on ended ---');
  installWebmCapableAudio();
  createdAudios.length = 0;
  const p = new AudioPipeline();
  p.unlockAudioSync();
  const promise = p.callAudio.playCallOpen();
  // Simulate the audio finishing quickly.
  setTimeout(() => {
    const openEl = createdAudios.find((a) => /callOpen/.test(a.src));
    openEl.dispatchEvent('ended');
  }, 20);
  const r = await promise;
  assert(r && r.ok === true && r.reason === 'ended', `playCallOpen resolved on 'ended' (r=${JSON.stringify(r)})`);
  await p.close();
}

async function testPlayCallOpenResolvesOnTimeout(AudioPipeline) {
  console.log('\n--- playCallOpen: falls back to timeout ---');
  installWebmCapableAudio();
  createdAudios.length = 0;
  // Override the play() behaviour so the promise never resolves naturally.
  global.Audio = class extends FakeAudio {
    canPlayType(m) { return /webm/i.test(m) ? 'probably' : ''; }
    // Don't fire ended; let the safety cap do its job.
  };
  // Swap in a small-timeout variant — we don't want to wait 6 s.
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms) => realSetTimeout(fn, Math.min(ms, 40));
  try {
    const p = new AudioPipeline();
    p.unlockAudioSync();
    const r = await p.callAudio.playCallOpen();
    assert(r && r.reason === 'timeout', `playCallOpen resolved on timeout when 'ended' never fires (r=${JSON.stringify(r)})`);
    await p.close();
  } finally {
    global.setTimeout = realSetTimeout;
  }
  installWebmCapableAudio();
}

async function testBackgroundToggle(AudioPipeline) {
  console.log('\n--- background toggle: enable/disable ---');
  installWebmCapableAudio();
  createdAudios.length = 0;
  const p = new AudioPipeline();
  p.unlockAudioSync();

  const bg = createdAudios.find((a) => /background/.test(a.src));
  // audio-flow: unlock() primes every clip with a muted play/pause. Snapshot
  // the baseline so the assertions below measure only playback initiated
  // by startBackground().
  const baselinePlays = bg._playCount;

  // Toggle off; startBackground must be a no-op.
  p.callAudio.setBackgroundEnabled(false);
  p.callAudio.startBackground();
  assert(bg._playCount === baselinePlays, `startBackground does nothing when toggle is off (plays=${bg._playCount} baseline=${baselinePlays})`);
  assert(p.callAudio.isBackgroundPlaying() === false, 'isBackgroundPlaying false while disabled');

  // Toggle on; startBackground plays.
  p.callAudio.setBackgroundEnabled(true);
  p.callAudio.startBackground();
  assert(bg._playCount === baselinePlays + 1, `startBackground plays once when toggle is on (plays=${bg._playCount})`);
  assert(p.callAudio.isBackgroundPlaying() === true, 'isBackgroundPlaying true after start');

  // Flipping toggle off mid-play must stop the loop.
  const pausesBefore = bg._pauseCount;
  p.callAudio.setBackgroundEnabled(false);
  assert(bg._pauseCount > pausesBefore, 'disabling background mid-play calls pause()');
  assert(p.callAudio.isBackgroundPlaying() === false, 'isBackgroundPlaying false after disable');
  await p.close();
}

async function testBackgroundStartStopIdempotent(AudioPipeline) {
  console.log('\n--- background: idempotent start/stop ---');
  installWebmCapableAudio();
  createdAudios.length = 0;
  const p = new AudioPipeline();
  p.unlockAudioSync();
  p.callAudio.setBackgroundEnabled(true);

  const bg = createdAudios.find((a) => /background/.test(a.src));
  const baselinePlays = bg._playCount;

  p.callAudio.startBackground();
  p.callAudio.startBackground();
  p.callAudio.startBackground();
  assert(bg._playCount === baselinePlays + 1, `startBackground idempotent — only one play() call after baseline (got ${bg._playCount}, baseline=${baselinePlays})`);

  p.callAudio.stopBackground();
  p.callAudio.stopBackground();
  assert(p.callAudio.isBackgroundPlaying() === false, 'stopBackground idempotent');
  await p.close();
}

async function testPlayCallCloseResolves(AudioPipeline) {
  console.log('\n--- playCallClose: resolves on ended ---');
  installWebmCapableAudio();
  createdAudios.length = 0;
  const p = new AudioPipeline();
  p.unlockAudioSync();
  const promise = p.callAudio.playCallClose();
  setTimeout(() => {
    const closeEl = createdAudios.find((a) => /callClose/.test(a.src));
    closeEl.dispatchEvent('ended');
  }, 10);
  const r = await promise;
  assert(r && r.ok === true && r.reason === 'ended', `playCallClose resolved on 'ended' (r=${JSON.stringify(r)})`);
  await p.close();
}

async function testBackgroundLoopWatchdog(AudioPipeline) {
  console.log('\n--- background: watchdog restarts after spurious ended ---');
  installWebmCapableAudio();
  createdAudios.length = 0;
  const p = new AudioPipeline();
  p.unlockAudioSync();
  p.callAudio.setBackgroundEnabled(true);
  p.callAudio.startBackground();
  const bg = createdAudios.find((a) => /background/.test(a.src));
  const playsAfterStart = bg._playCount;
  // Simulate the browser incorrectly firing `ended` while we still want to
  // loop. The watchdog must rewind and restart playback.
  bg.dispatchEvent('ended');
  assert(bg._playCount === playsAfterStart + 1, `watchdog restarted play() after ended (plays=${bg._playCount}, expected=${playsAfterStart + 1})`);
  // And when disabled, the watchdog must NOT restart.
  p.callAudio.stopBackground();
  p.callAudio.setBackgroundEnabled(false);
  const playsNow = bg._playCount;
  bg.dispatchEvent('ended');
  assert(bg._playCount === playsNow, 'watchdog does not restart when disabled');
  await p.close();
}

async function testPhoneCompressionToggle(AudioPipeline) {
  console.log('\n--- phone compression: toggle ---');
  installWebmCapableAudio();
  createdAudios.length = 0;
  const p = new AudioPipeline();
  p.unlockAudioSync();
  assert(typeof p.setPhoneCompression === 'function', 'setPhoneCompression method present');
  assert(p.isPhoneCompressionOn() === false, 'phone compression OFF by default');
  p.setPhoneCompression(true);
  assert(p.isPhoneCompressionOn() === true, 'phone compression ON after toggle');
  p.setPhoneCompression(false);
  assert(p.isPhoneCompressionOn() === false, 'phone compression OFF after second toggle');
  // Graph nodes must exist.
  assert(p._phoneHP && p._phoneLP1 && p._phoneLP2 && p._phoneComp && p._phoneMakeup, 'phone chain nodes wired');
  await p.close();
}

async function testNoLegacyNoiseSurface(AudioPipeline) {
  console.log('\n--- legacy noise surface removed ---');
  installWebmCapableAudio();
  createdAudios.length = 0;
  const p = new AudioPipeline();
  p.unlockAudioSync();
  const forbidden = [
    'setAmbientOn', 'setHumanLayerOn', 'setNoiseMode', 'setNoiseVolume',
    'setCompressionStrength', 'setCompressionEnabled', 'setBandPassEnabled',
    'setHumanLayerVolume', 'getCompressionStrength'
  ];
  const present = forbidden.filter((m) => typeof p[m] === 'function');
  assert(present.length === 0, `no legacy noise/compression methods on AudioPipeline (present=${JSON.stringify(present)})`);

  // And the old procedural-noise fields too.
  const forbiddenFields = ['noiseEnvelopeGain', 'noiseBusGain', 'humanLayerBusGain', 'humanLayer', 'bandPass'];
  const leaked = forbiddenFields.filter((k) => p[k] != null);
  assert(leaked.length === 0, `no legacy noise/compression fields on AudioPipeline (leaked=${JSON.stringify(leaked)})`);
  await p.close();
}

main().catch((err) => {
  console.error('ERROR', err && (err.stack || err.message || err));
  process.exit(1);
});
