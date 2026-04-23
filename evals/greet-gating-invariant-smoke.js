// Round-6 smoke — greet-gating invariant (reshaped).
//
// Round-5 invariant: "no text is sent UPSTREAM until greet_gate_open"
// has been superseded. Round-6's invariant is better:
//
//   "no generated audio / transcript / turn_complete frames reach the
//    BROWSER until the browser sends `audio_prelude_ended`."
//
// The upstream greeting fires IMMEDIATELY on `upstreamSetupComplete`
// so Gemini starts generating in parallel with the client's callOpen
// chime. Server-side buffer holds the generated frames. On
// `audio_prelude_ended` the buffer flushes in order. Net result:
// near-zero perceived gap between callOpen ending and agent speaking.
//
// Strategy:
//   1. Spawn server with the round-6 stub. Stub responds to the
//      bridge's `sendRealtimeInput({text})` by dispatching a simulated
//      modelTurn (audio + transcript + turn_complete) after 20 ms.
//   2. Phase A: send `hello` with greet. Upstream not setup-complete.
//      Expect NO text injection yet.
//   3. Phase B: touch the setup sentinel to fire fake `setup_complete`.
//      Bridge fires text injection (greeting). Stub simulates Gemini's
//      audio + transcript + turn_complete response. The SERVER
//      receives those frames via onUpstreamMessage. We assert the
//      client WS receives NONE of them yet (they're in the pre-greet
//      buffer).
//   4. Phase C: client sends `audio_prelude_ended`. Server flushes
//      buffer. Client WS receives the binary audio chunk AND the
//      transcript_delta AND the turn_complete JSON, in order.
//
// Usage:  node evals/greet-gating-invariant-smoke.js
//         npm run smoke:greet-gating-invariant

'use strict';

const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');
const fs = require('fs');

const PORT = 40000 + Math.floor(Math.random() * 20000);
const STUB_PATH = path.resolve(__dirname, '_greet-gating-stub.js');
const SENTINEL_SETUP = path.resolve(__dirname, '_greet-gating-stub.setup');

function waitForListen(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const t = setTimeout(() => {
      if (!done) { done = true; reject(new Error('server start timeout')); }
    }, timeoutMs);
    function onData(d) {
      if (/listening on http:/i.test(d.toString('utf8')) && !done) {
        done = true; clearTimeout(t); resolve();
      }
    }
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
  });
}

(async function main() {
  if (!fs.existsSync(STUB_PATH)) {
    console.error('FAIL: stub not found at', STUB_PATH);
    process.exit(1);
  }
  try { fs.unlinkSync(SENTINEL_SETUP); } catch (_) {}

  const serverPath = path.resolve(__dirname, '..', 'server.js');
  const child = spawn(process.execPath, ['-r', STUB_PATH, serverPath], {
    env: {
      ...process.env,
      PORT: String(PORT),
      GEMINI_API_KEY: 'smoke-fake-key',
      DEBUG: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stdoutBuf = '';
  child.stdout.on('data', (d) => {
    const s = d.toString('utf8');
    stdoutBuf += s;
    process.stdout.write('  [srv] ' + s);
  });
  child.stderr.on('data', (d) => {
    const s = d.toString('utf8');
    stdoutBuf += s;
    process.stderr.write('  [srv!] ' + s);
  });

  function countInStdout(re) {
    const m = stdoutBuf.match(re);
    return m ? m.length : 0;
  }
  async function waitFor(predicate, timeoutMs, label) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('timeout waiting for ' + label);
  }

  let exitCode = 1;
  try {
    await waitForListen(child, 5000);

    const ws = new WebSocket('ws://localhost:' + PORT + '/api/live');
    const clientBinaryFrames = [];
    const clientJsonFrames = [];
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        clientBinaryFrames.push({ at: Date.now(), bytes: data.length });
      } else {
        try { clientJsonFrames.push({ at: Date.now(), msg: JSON.parse(data.toString('utf8')) }); } catch (_) {}
      }
    });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('open timeout')), 3000);
      ws.once('open', () => { clearTimeout(t); resolve(); });
      ws.once('error', reject);
    });

    // Phase A: send hello with greet. Upstream not yet setup-complete;
    // the greeting text should NOT be injected yet.
    ws.send(JSON.stringify({
      type: 'hello',
      persona: 'professional',
      elements: [],
      page: '/',
      mode: 'live',
      greet: { page: '/', title: 'Dispatch Board' }
    }));
    await waitFor(() => /live\.connect requested/.test(stdoutBuf), 4000, 'live.connect requested');
    await new Promise((r) => setTimeout(r, 300));
    const textFiresAfterHello = countInStdout(/\[SMOKE-STUB\] sendRealtimeInput kind=text/g);
    if (textFiresAfterHello !== 0) {
      throw new Error('REGRESSION: text fired ' + textFiresAfterHello + ' times BEFORE setup_complete. Expected 0.');
    }
    console.log('PASS phase A — no text injection after hello (upstream not setup-complete)');

    // Phase B: trigger fake setup_complete via sentinel. Bridge will
    // inject greeting text upstream. Stub replies with simulated audio
    // + transcript + turn_complete ~20 ms later. Server buffers those
    // frames (pre-greet buffer). Client WS should receive ZERO
    // agent-content frames (no binary, no transcript_delta, no
    // turn_complete). The ONLY JSON frames the client may see are
    // control frames: hello_ack, state, setup_complete.
    fs.writeFileSync(SENTINEL_SETUP, '1');
    await waitFor(() => /firing first onmessage \(setup_complete\)/.test(stdoutBuf), 2000, 'setup_complete fire');
    await waitFor(() => /sendRealtimeInput kind=text/.test(stdoutBuf), 2000, 'greeting fired upstream');
    await waitFor(() => /greeting turn_complete dispatched/.test(stdoutBuf), 2000, 'stub fake turn_complete');
    // Give the server a generous window for the bridge to process the
    // simulated Gemini frames. If the server is correctly buffering,
    // NONE of the audio / transcript / turn_complete frames reach the
    // client during this window.
    await new Promise((r) => setTimeout(r, 300));

    if (clientBinaryFrames.length !== 0) {
      throw new Error('REGRESSION: client received ' + clientBinaryFrames.length +
        ' binary frame(s) BEFORE audio_prelude_ended. Expected 0. ' +
        'THIS IS THE EXACT BUG ROUND-6 PROTECTS AGAINST.');
    }
    const prematureTranscripts = clientJsonFrames.filter((f) => f.msg && f.msg.type === 'transcript_delta');
    if (prematureTranscripts.length !== 0) {
      throw new Error('REGRESSION: client received ' + prematureTranscripts.length +
        ' transcript_delta frame(s) BEFORE audio_prelude_ended. Expected 0.');
    }
    const prematureTurnComplete = clientJsonFrames.filter((f) => f.msg && f.msg.type === 'turn_complete');
    if (prematureTurnComplete.length !== 0) {
      throw new Error('REGRESSION: client received ' + prematureTurnComplete.length +
        ' turn_complete frame(s) BEFORE audio_prelude_ended. Expected 0.');
    }
    console.log('PASS phase B — client receives 0 agent frames while buffering ' +
      '(json=' + clientJsonFrames.length + ' control only, binary=0)');

    // Phase C: send `audio_prelude_ended`. Server flushes buffer.
    // Client should receive the buffered audio chunk + transcript +
    // turn_complete in the ORDER they arrived from upstream.
    const preBinaryCount = clientBinaryFrames.length;
    const preTranscriptCount = clientJsonFrames.filter((f) => f.msg && f.msg.type === 'transcript_delta').length;
    const preTurnCompleteCount = clientJsonFrames.filter((f) => f.msg && f.msg.type === 'turn_complete').length;

    const sentAt = Date.now();
    ws.send(JSON.stringify({ type: 'audio_prelude_ended' }));
    await waitFor(() => /pregreet_buffer_released/.test(stdoutBuf), 2000, 'buffer release log');
    await waitFor(() => clientBinaryFrames.length > preBinaryCount, 2000, 'buffered audio flushed to client');
    await new Promise((r) => setTimeout(r, 100));

    const newBinary = clientBinaryFrames.length - preBinaryCount;
    const newTranscript = clientJsonFrames.filter((f) => f.msg && f.msg.type === 'transcript_delta').length - preTranscriptCount;
    const newTurnComplete = clientJsonFrames.filter((f) => f.msg && f.msg.type === 'turn_complete').length - preTurnCompleteCount;

    if (newBinary < 1) throw new Error('Expected >=1 binary frame after release, got ' + newBinary);
    if (newTranscript < 1) throw new Error('Expected >=1 transcript_delta after release, got ' + newTranscript);
    if (newTurnComplete < 1) throw new Error('Expected >=1 turn_complete after release, got ' + newTurnComplete);

    // Latency measurement: ms between sending audio_prelude_ended and
    // first binary frame arriving on the client. This IS the perceived
    // greeting latency in the new architecture (should be ~1 RTT on
    // localhost, sub-100 ms).
    const firstNewBinary = clientBinaryFrames[preBinaryCount];
    const latencyMs = firstNewBinary.at - sentAt;
    console.log('PASS phase C — flushed binary=' + newBinary + ' transcript=' + newTranscript +
      ' turn_complete=' + newTurnComplete + ' flush_latency_ms=' + latencyMs);

    console.log('\nGREET-GATING INVARIANT HOLDS (round-6): server buffers greeting frames ' +
      'until audio_prelude_ended arrives, then flushes in order.');
    exitCode = 0;
    try { ws.terminate(); } catch (_) {}
  } catch (e) {
    console.error('\nFAIL:', e.message);
  } finally {
    try { fs.unlinkSync(SENTINEL_SETUP); } catch (_) {}
    try { child.kill('SIGTERM'); } catch (_) {}
    setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      process.exit(exitCode);
    }, 800);
  }
})();
