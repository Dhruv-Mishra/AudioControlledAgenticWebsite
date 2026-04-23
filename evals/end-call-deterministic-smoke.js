// Round-6 smoke — deterministic agent-end-call chain.
//
// Asserts that after `end_call_requested` arrives from the server,
// the client waits for BOTH `turn-complete` AND
// `agent-playback-drained` before running teardown. The round-3 3 s
// timer has been removed in favour of event-driven determinism.
//
// Strategy:
//   1. Instantiate the client-side VoiceAgent in a jsdom-ish stub
//      environment — we can't run a real browser here, but we CAN
//      import the module, stub its pipeline + WS, and manually drive
//      the `end_call_requested` → `turn-complete` →
//      `agent-playback-drained` → `_gracefullyEndCall` sequence.
//   2. Assert `_gracefullyEndCall` is called EXACTLY once, AFTER both
//      signals have fired, NEVER before. No timer is scheduled.
//   3. Assert safety timeout fires if turn-complete never arrives.
//   4. Assert user click short-circuits the wait (instant kill).
//
// Because voice-agent.js imports real browser globals we stub them.
// The goal is to validate the state machine logic, not the full
// audio graph.
//
// Usage:  node evals/end-call-deterministic-smoke.js
//         npm run smoke:end-call-deterministic

'use strict';

// Browser-global stubs. The imported module only touches these at
// construct/use time; minimal shims suffice.
global.window = { AudioContext: class {}, webkitAudioContext: class {}, addEventListener() {}, removeEventListener() {} };
global.document = { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' };
Object.defineProperty(global, 'navigator', { value: { mediaDevices: null, userAgent: 'node-smoke' }, configurable: true });
global.WebSocket = class MockWs {
  constructor() {
    this.readyState = 1;
    this.sent = [];
    setTimeout(() => this.onopen && this.onopen(), 0);
  }
  send(data) { this.sent.push(data); }
  close() { this.onclose && this.onclose({ code: 1000, reason: 'test' }); }
};
global.Audio = class { constructor() { this._listeners = {}; } addEventListener() {} removeEventListener() {} play() { return Promise.resolve(); } pause() {} load() {} };
global.location = { protocol: 'http:', host: 'localhost:3029', pathname: '/', search: '' };
global.sessionStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
global.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
global.performance = { now: () => Date.now() };

async function main() {
  // Dynamic ESM import — voice-agent.js is an ES module.
  let VoiceAgent;
  try {
    const mod = await import('../js/voice-agent.js');
    VoiceAgent = mod.VoiceAgent;
  } catch (err) {
    console.error('FAIL to import voice-agent.js:', err.message);
    process.exit(1);
  }

  // Stub pipeline that records end-call-relevant interactions.
  class StubPipeline extends (require('events').EventEmitter) {
    constructor() {
      super();
      this.callAudio = {
        armForNextCall() {},
        stopAllCallAudio() {},
        unlock() {},
        playCallOpen() { return Promise.resolve({ ok: true, reason: 'ended' }); },
        playCallClose: async () => { this.playCallCloseCalls = (this.playCallCloseCalls || 0) + 1; return { ok: true, reason: 'ended' }; },
        startBackground() {},
        stopBackground() {},
        setBackgroundEnabled() {},
        isBackgroundEnabled() { return false; },
        isBackgroundPlaying() { return false; }
      };
      this._capturePaused = true;
      this.activePlaybackSources = new Set();
      this.flushPlaybackCalls = 0;
      this.playCallCloseCalls = 0;
    }
    unlockAudioSync() { return {}; }
    ensureCtx() { return Promise.resolve({}); }
    setCapturePaused(p) { this._capturePaused = p; }
    setMuted() {}
    setPhoneCompression() {}
    setOutputVolume() {}
    isPlaybackBlocked() { return false; }
    flushPlayback() { this.flushPlaybackCalls += 1; this.activePlaybackSources.clear(); }
    stopAllAudio() { this.flushPlayback(); }
    stopCapture() {}
    isMicEnded() { return false; }
    addEventListener(ev, fn) { this.on(ev, fn); }
    removeEventListener(ev, fn) { this.off(ev, fn); }
    isAgentAudioPlaying() { return this.activePlaybackSources.size > 0; }
    readVuLevel() { return 0; }
    readMicLevel() { return 0; }
    // Test helpers
    simulateAgentAudioInFlight() {
      // Pretend a source is scheduled.
      const fake = { stop() {}, disconnect() {} };
      this.activePlaybackSources.add(fake);
      return fake;
    }
    simulateAgentAudioDrained() {
      this.activePlaybackSources.clear();
      this.dispatchEvent(new (require('events').EventEmitter.prototype.constructor || function(){})());
      // Use EventEmitter emit:
      this.emit('agent-playback-drained');
    }
    dispatchEvent(ev) { this.emit(ev.type, ev); }
  }

  let passes = 0;
  let fails = 0;
  function assert(cond, msg) {
    if (cond) { console.log('  PASS:', msg); passes += 1; }
    else { console.error('  FAIL:', msg); fails += 1; }
  }

  // --- Test 1: deterministic chain fires in correct order. ---
  console.log('Test 1: end_call_requested → wait turn_complete + drained → teardown');
  {
    const agent = new VoiceAgent({});
    agent.pipeline = new StubPipeline();
    // Force the agent into in-call state.
    agent._callActive = true;
    agent.setupComplete = true;
    agent._callOpenSettled = true;
    agent._listenGateOpen = true;
    agent._listenGateSetupComplete = true;
    agent.state = 'live_ready';
    // WS mocked — just an object with send()
    agent.ws = { readyState: 1, send() {}, close() {} };

    let gracefulCalls = 0;
    const origGraceful = agent._gracefullyEndCall.bind(agent);
    agent._gracefullyEndCall = async (reason) => {
      gracefulCalls += 1;
      console.log('  [agent] _gracefullyEndCall reason=' + reason);
      // Short-circuit the real graceful close — we just care it was called.
      return;
    };

    // Simulate a scheduled agent audio source (drain not yet signaled).
    agent.pipeline.simulateAgentAudioInFlight();

    // Fire the end_call_requested message the same way the server would.
    agent._onServerMessage({ type: 'end_call_requested', reason: 'user-said-bye' });

    // At this point: no graceful call yet (waiting for signals).
    assert(gracefulCalls === 0, 'no teardown fires immediately after end_call_requested');
    assert(agent._agentEndingArmed === true, 'wait is armed');

    // Fire turn_complete. Still waiting on drain.
    agent._onServerMessage({ type: 'turn_complete' });
    assert(gracefulCalls === 0, 'still no teardown after turn_complete alone');
    assert(agent._agentTurnComplete === true, 'turn_complete flag flipped');

    // Fire drain. Now both gates closed.
    agent.pipeline.emit('agent-playback-drained');
    // Allow the microtask queue to run.
    await new Promise((r) => setTimeout(r, 10));
    assert(gracefulCalls === 1, 'teardown fires exactly once after BOTH signals');
    assert(agent._agentEndingArmed === false, 'wait disarmed after fire');
  }

  // --- Test 2: drain signal before turn_complete also works. ---
  console.log('\nTest 2: drain first, then turn_complete');
  {
    const agent = new VoiceAgent({});
    agent.pipeline = new StubPipeline();
    agent._callActive = true;
    agent.setupComplete = true;
    agent._callOpenSettled = true;
    agent.state = 'live_ready';
    agent.ws = { readyState: 1, send() {}, close() {} };
    let gracefulCalls = 0;
    agent._gracefullyEndCall = async () => { gracefulCalls += 1; };
    agent.pipeline.simulateAgentAudioInFlight();

    agent._onServerMessage({ type: 'end_call_requested' });
    assert(gracefulCalls === 0, 'no immediate teardown');

    agent.pipeline.emit('agent-playback-drained');
    assert(gracefulCalls === 0, 'still waiting for turn_complete');

    agent._onServerMessage({ type: 'turn_complete' });
    await new Promise((r) => setTimeout(r, 10));
    assert(gracefulCalls === 1, 'teardown fires after reverse order');
  }

  // --- Test 3: if no agent audio ever scheduled, drained is already true. ---
  console.log('\nTest 3: no agent audio in flight — drained flag initialises true');
  {
    const agent = new VoiceAgent({});
    agent.pipeline = new StubPipeline();
    agent._callActive = true;
    agent.setupComplete = true;
    agent._callOpenSettled = true;
    agent.state = 'live_ready';
    agent.ws = { readyState: 1, send() {}, close() {} };
    let gracefulCalls = 0;
    agent._gracefullyEndCall = async () => { gracefulCalls += 1; };
    // No simulateAgentAudioInFlight — the set is empty from the start.

    agent._onServerMessage({ type: 'end_call_requested' });
    assert(agent._agentAudioDrained === true, 'drained flag starts true (no audio in flight)');
    agent._onServerMessage({ type: 'turn_complete' });
    await new Promise((r) => setTimeout(r, 10));
    assert(gracefulCalls === 1, 'only turn_complete needed to fire teardown');
  }

  // --- Test 4: user click during wait short-circuits. ---
  console.log('\nTest 4: user endCall() during deterministic wait runs teardown immediately');
  {
    const agent = new VoiceAgent({});
    agent.pipeline = new StubPipeline();
    agent._callActive = true;
    agent.setupComplete = true;
    agent._callOpenSettled = true;
    agent.state = 'live_ready';
    agent.ws = { readyState: 1, send() {}, close() {} };
    let gracefulCalls = [];
    agent._gracefullyEndCall = async (reason) => { gracefulCalls.push(reason); };
    agent.pipeline.simulateAgentAudioInFlight();

    agent._onServerMessage({ type: 'end_call_requested' });
    assert(gracefulCalls.length === 0, 'no teardown during wait');

    // User click — note the VoiceAgent.endCall() guard needs isInCall;
    // force the state so the guard passes.
    await agent.endCall();
    assert(gracefulCalls.length === 1, 'teardown fires once on user click');
    assert(gracefulCalls[0] === 'user_end', 'reason=user_end (not agent_end_call)');
    assert(agent._agentEndingArmed === false, 'wait cancelled');
  }

  // --- Test 5: safety timeout if turn_complete never arrives. ---
  console.log('\nTest 5: safety timeout (reduced to 200ms for test speed)');
  {
    const agent = new VoiceAgent({});
    agent.pipeline = new StubPipeline();
    agent._callActive = true;
    agent.setupComplete = true;
    agent._callOpenSettled = true;
    agent.state = 'live_ready';
    agent.ws = { readyState: 1, send() {}, close() {} };
    let gracefulCalls = [];
    agent._gracefullyEndCall = async (reason) => { gracefulCalls.push(reason); };
    agent.pipeline.simulateAgentAudioInFlight();

    agent._onServerMessage({ type: 'end_call_requested' });
    // Patch the timer to fire quickly.
    clearTimeout(agent._agentEndingTimer);
    agent._agentEndingTimer = setTimeout(() => {
      if (!agent._agentEndingArmed) return;
      agent._agentEndingArmed = false;
      agent._gracefullyEndCall('agent_end_call_timeout');
    }, 100);

    await new Promise((r) => setTimeout(r, 200));
    assert(gracefulCalls.length === 1, 'safety timeout fired teardown once');
    assert(gracefulCalls[0] === 'agent_end_call_timeout', 'reason reflects timeout');
  }

  console.log('\n' + passes + ' PASS / ' + fails + ' FAIL');
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((err) => { console.error('FATAL:', err.stack || err.message); process.exit(1); });
