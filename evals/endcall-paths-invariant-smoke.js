// Round-8 smoke — end-call paths invariant.
//
// Asserts the three round-8 end-call paths:
//
//   Path A (agent-initiated, deterministic):
//     1. end_call_requested arrives
//     2. wait for turn_complete + agent-playback-drained
//     3. stop background
//     4. play callClose to completion
//     5. teardown (close WS, reset state)
//     MUST: playCallClose called EXACTLY ONCE and awaited; teardown
//           strictly AFTER callClose onended; background stopped.
//
//   Path B (user click, instant):
//     1. user click End Call
//     2. stopAllAudio synchronously on UI
//     3. endCall() → _gracefullyEndCall('user_end')
//     4. NO callClose; skip straight to WS close + state reset
//     MUST: playCallClose NEVER called; stopAllAudio called; teardown
//           in same tick.
//
//   Path C (user click DURING agent-end wait):
//     1. end_call_requested arrived, wait armed
//     2. user clicks End Call → _cancelAgentEndingWait + user-path
//        teardown
//     MUST: playCallClose NEVER called; listeners cleaned up; timer
//           cleared; user-path reason recorded.
//
//   Regressions:
//     • end_call_requested can arrive after turn_complete/audio-drained;
//       it must fire from the recorded recent gate state instead of
//       hanging open.
//     • terminal end-call clears stale queued UI actions ahead of it.
//     • if the user asks to end and the agent signs off but the tool
//       frame never arrives, the narrow local fallback ends the call.
//
// Uses the node-side VoiceAgent import with stub pipeline/WS. Builds
// on the round-6 end-call-deterministic-smoke harness.
//
// Usage: node evals/endcall-paths-invariant-smoke.js
//        npm run smoke:endcall-paths-invariant

'use strict';

// Browser-global stubs (same pattern as end-call-deterministic-smoke).
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
global.Audio = class {
  constructor() { this._listeners = {}; }
  addEventListener() {}
  removeEventListener() {}
  play() { return Promise.resolve(); }
  pause() {}
  load() {}
};
global.location = { protocol: 'http:', host: 'localhost:3001', pathname: '/', search: '' };
global.sessionStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
global.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
global.performance = { now: () => Date.now() };

async function main() {
  let VoiceAgent;
  try {
    const mod = await import('../js/voice-agent.js');
    VoiceAgent = mod.VoiceAgent;
  } catch (err) {
    console.error('FAIL import:', err.message);
    process.exit(1);
  }

  class StubPipeline extends (require('events').EventEmitter) {
    constructor() {
      super();
      this.stats = {
        playCallCloseCalls: 0,
        stopAllAudioCalls: 0,
        stopAllCallAudioCalls: 0,
        flushPlaybackCalls: 0,
        armForNextCallCalls: 0,
        setCapturePausedCalls: []
      };
      this.callAudio = {
        armForNextCall: () => { this.stats.armForNextCallCalls += 1; },
        stopAllCallAudio: () => { this.stats.stopAllCallAudioCalls += 1; },
        unlock: () => {},
        playCallOpen: () => Promise.resolve({ ok: true, reason: 'ended' }),
        playCallClose: async () => {
          this.stats.playCallCloseCalls += 1;
          // Simulate ~50 ms of chime playback so we can verify the
          // teardown awaits it.
          await new Promise((r) => setTimeout(r, 50));
          return { ok: true, reason: 'ended' };
        },
        startBackground: () => {},
        stopBackground: () => {},
        setBackgroundEnabled: () => {},
        isBackgroundEnabled: () => false,
        isBackgroundPlaying: () => false
      };
      this._capturePaused = true;
      this.activePlaybackSources = new Set();
    }
    unlockAudioSync() { return {}; }
    ensureCtx() { return Promise.resolve({}); }
    setCapturePaused(p) { this.stats.setCapturePausedCalls.push(p); this._capturePaused = p; }
    setMuted() {}
    setPhoneCompression() {}
    setOutputVolume() {}
    isPlaybackBlocked() { return false; }
    flushPlayback() { this.stats.flushPlaybackCalls += 1; this.activePlaybackSources.clear(); }
    stopAllAudio() {
      this.stats.stopAllAudioCalls += 1;
      this.flushPlayback();
      this.callAudio.stopAllCallAudio();
    }
    stopCapture() {}
    isMicEnded() { return false; }
    addEventListener(ev, fn) { this.on(ev, fn); }
    removeEventListener(ev, fn) { this.off(ev, fn); }
    isAgentAudioPlaying() { return this.activePlaybackSources.size > 0; }
    readVuLevel() { return 0; }
    readMicLevel() { return 0; }
    simulateAgentAudioInFlight() {
      const fake = { stop() {}, disconnect() {} };
      this.activePlaybackSources.add(fake);
      return fake;
    }
  }

  function freshAgent() {
    const agent = new VoiceAgent({});
    agent.pipeline = new StubPipeline();
    agent._callActive = true;
    agent.setupComplete = true;
    agent._callOpenSettled = true;
    agent._listenGateOpen = true;
    agent._listenGateSetupComplete = true;
    agent.state = 'live_ready';
    agent.ws = { readyState: 1, send() {}, close() {} };
    return agent;
  }

  let passes = 0, fails = 0;
  function assert(cond, msg) {
    if (cond) { console.log('  PASS:', msg); passes += 1; }
    else { console.error('  FAIL:', msg); fails += 1; }
  }

  // ===== PATH A =====
  console.log('\n--- Path A: agent-initiated end (deterministic, chime plays) ---');
  {
    const agent = freshAgent();
    // Pretend the agent spoke (activePlaybackSources has 1 source).
    agent.pipeline.simulateAgentAudioInFlight();
    // Fire server event.
    agent._onServerMessage({ type: 'end_call_requested', reason: 'say-bye' });
    assert(agent._agentEndingArmed === true, 'wait armed');
    assert(agent.pipeline.stats.playCallCloseCalls === 0, 'callClose NOT called during wait');

    // Fire turn_complete + drained.
    agent._onServerMessage({ type: 'turn_complete' });
    assert(agent.pipeline.stats.playCallCloseCalls === 0, 'callClose NOT called after only turn_complete');
    agent.pipeline.emit('agent-playback-drained');
    // Allow the async _gracefullyEndCall to run and the 50ms fake chime
    // to complete.
    await new Promise((r) => setTimeout(r, 120));

    assert(agent.pipeline.stats.playCallCloseCalls === 1, 'callClose called EXACTLY once');
    assert(agent.pipeline.stats.stopAllCallAudioCalls >= 1, 'background stopped (stopAllCallAudio called)');
    assert(agent.pipeline.stats.stopAllAudioCalls === 0, 'stopAllAudio NOT called on agent path (no flush of Gemini PCM)');
    assert(agent.pipeline.stats.flushPlaybackCalls === 0, 'flushPlayback NOT called on agent path');
    assert(agent._agentEndingArmed === false, 'wait disarmed after fire');
    assert(agent._endingCall === false, 'endingCall latch cleared');
    assert(agent.state === 'idle', 'final state is IDLE');
  }

  // ===== PATH B =====
  console.log('\n--- Path B: user click, instant, NO chime ---');
  {
    const agent = freshAgent();
    await agent.endCall();  // simulates user click
    // No wait needed — user path is synchronous-ish.
    assert(agent.pipeline.stats.playCallCloseCalls === 0, 'callClose NEVER called on user path');
    assert(agent.pipeline.stats.stopAllAudioCalls >= 1, 'stopAllAudio called');
    assert(agent.pipeline.stats.armForNextCallCalls === 0, 'armForNextCall NOT called on user path (hard-kill latch preserved)');
    assert(agent._endingCall === false, 'endingCall latch cleared');
    assert(agent.state === 'idle', 'final state is IDLE');
  }

  // ===== PATH C =====
  console.log('\n--- Path C: user click DURING agent-end wait ---');
  {
    const agent = freshAgent();
    agent.pipeline.simulateAgentAudioInFlight();

    // Arm the agent-end wait.
    agent._onServerMessage({ type: 'end_call_requested' });
    assert(agent._agentEndingArmed === true, 'wait armed');
    assert(agent.pipeline.stats.playCallCloseCalls === 0, 'callClose NOT called yet');

    // User clicks End Call mid-wait.
    await agent.endCall();
    assert(agent.pipeline.stats.playCallCloseCalls === 0, 'callClose NEVER called on user-during-wait');
    assert(agent._agentEndingArmed === false, 'wait cancelled');
    assert(agent._agentEndingTimer === null, 'safety timer cleared');
    assert(agent._agentEndingListeners === null, 'listeners cleaned up');
    assert(agent.state === 'idle', 'final state is IDLE');
  }

  // ===== REGRESSION: duplicate end_call_requested =====
  console.log('\n--- regression: duplicate end_call_requested frame dropped ---');
  {
    const agent = freshAgent();
    agent.pipeline.simulateAgentAudioInFlight();
    agent._onServerMessage({ type: 'end_call_requested' });
    const armed1 = agent._agentEndingArmed;
    agent._onServerMessage({ type: 'end_call_requested' });  // duplicate
    const armed2 = agent._agentEndingArmed;
    assert(armed1 === true && armed2 === true, 'armed stays true through duplicate');
    assert(agent.pipeline.stats.playCallCloseCalls === 0, 'no premature chime');
    agent._cancelAgentEndingWait('test_cleanup');
  }

  // ===== REGRESSION: request arrives after both gates already fired =====
  console.log('\n--- regression: end_call after recent gates still fires ---');
  {
    const agent = freshAgent();
    let staleActionRan = false;
    agent._pendingActions.enqueue(() => { staleActionRan = true; }, { label: 'stale-nav', reason: 'test' });
    agent._lastTurnCompleteAt = Date.now();
    agent._lastAgentPlaybackDrainedAt = Date.now();

    agent._onServerMessage({ type: 'end_call_requested', reason: 'late-frame' });
    await new Promise((r) => setTimeout(r, 120));

    assert(staleActionRan === false, 'stale queued action cleared before terminal hangup');
    assert(agent.pipeline.stats.playCallCloseCalls === 1, 'callClose called from initial gate state');
    assert(agent._agentEndingArmed === false, 'wait disarmed');
    assert(agent.state === 'idle', 'final state is IDLE');
  }

  // ===== REGRESSION: model signs off but tool frame never arrives =====
  console.log('\n--- regression: sign-off fallback ends call without tool frame ---');
  {
    const agent = freshAgent();
    agent._onTranscriptDelta({ from: 'user', delta: 'Goodbye, end the call.' });
    agent._onTranscriptDelta({ from: 'agent', delta: 'Goodbye.' });
    await new Promise((r) => setTimeout(r, 2200));

    assert(agent.pipeline.stats.playCallCloseCalls === 1, 'fallback plays callClose once');
    assert(agent._agentEndingArmed === false, 'no deterministic wait left armed');
    assert(agent.state === 'idle', 'fallback final state is IDLE');
  }

  console.log('\n' + passes + ' PASS / ' + fails + ' FAIL');
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((err) => { console.error('FATAL:', err.stack || err.message); process.exit(1); });
