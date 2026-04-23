// Smoke — Live mode wire protocol. Simulates a browser client sending
//   hello { mode: 'live' } → audio stream → set_mode back to 'wakeword'
// and asserts the server logs the mode transitions and accepts the flow.
//
// When GEMINI_API_KEY is a real valid key, additionally asserts we receive
// at least one binary audio frame back from Gemini within 10s of streaming
// silence (which should prompt a "don't know what you said" response).
//
// Usage:   npm run smoke:live-mode
//          GEMINI_API_KEY=<real> npm run smoke:live-mode

'use strict';

const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

const PORT = 40000 + Math.floor(Math.random() * 20000);
const REAL_KEY = !!process.env.GEMINI_API_KEY && !/invalid|test/i.test(process.env.GEMINI_API_KEY);

function waitForListen(child, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; reject(new Error('server start timeout')); } }, timeoutMs);
    function onData(d) {
      if (/listening on http:/i.test(d.toString('utf8')) && !done) {
        done = true; clearTimeout(t); resolve();
      }
    }
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
  });
}

function grepLogs(child, patterns, timeoutMs) {
  const missing = new Set(patterns);
  const matched = [];
  return new Promise((resolve, reject) => {
    let done = false;
    const t = setTimeout(() => {
      if (done) return; done = true;
      if (missing.size === 0) resolve(matched);
      else reject(new Error(`missing: ${[...missing].join(', ')} | matched: ${matched.join(' | ')}`));
    }, timeoutMs);
    function onData(d) {
      const s = d.toString('utf8');
      for (const p of [...missing]) {
        if (p instanceof RegExp ? p.test(s) : s.includes(p)) {
          missing.delete(p);
          matched.push(typeof p === 'string' ? p : p.toString());
        }
      }
      if (missing.size === 0 && !done) {
        done = true; clearTimeout(t); resolve(matched);
      }
    }
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
  });
}

function silencePcm16(ms, sampleRate = 16000) {
  return Buffer.alloc(Math.round((ms / 1000) * sampleRate) * 2);
}

(async function main() {
  const serverPath = path.resolve(__dirname, '..', 'server.js');
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      PORT: String(PORT),
      GEMINI_API_KEY: process.env.GEMINI_API_KEY || 'invalid-for-live-smoke',
      DEBUG: '1',
      DISABLE_WS_NONCE: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (d) => process.stdout.write(`[srv] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[srv!] ${d}`));

  let exitCode = 1;
  try {
    await waitForListen(child);
    const ws = new WebSocket(`ws://localhost:${PORT}/api/live`);
    const events = { text: [], binary: 0, binaryBytes: 0 };
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        events.binary += 1;
        events.binaryBytes += data.byteLength;
      } else {
        try { events.text.push(JSON.parse(data.toString('utf8'))); } catch {}
      }
    });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('open timeout')), 3000);
      ws.once('open', () => { clearTimeout(t); resolve(); });
      ws.once('error', reject);
    });

    // Phase 1: open in live mode via hello.
    const phase1 = grepLogs(child, ['mode=live', 'upstream connect requested'], 5000);
    ws.send(JSON.stringify({ type: 'hello', persona: 'professional', elements: [], page: '/', mode: 'live' }));
    await phase1;
    console.log('PASS hello(mode=live) → server opened live session');

    // Phase 2: stream a brief burst of silence, then flip to wake-word.
    const chunk = silencePcm16(200);
    for (let i = 0; i < 3; i++) { ws.send(chunk); await new Promise((r) => setTimeout(r, 100)); }
    console.log('PASS streamed ' + (chunk.length * 3) + ' bytes of PCM silence');

    const phase3 = grepLogs(child, ['mode switch live -> wakeword', 'upstream connect requested'], 5000);
    ws.send(JSON.stringify({ type: 'set_mode', mode: 'wakeword' }));
    await phase3;
    console.log('PASS set_mode → wakeword');

    if (REAL_KEY) {
      // Open a real audio round-trip: flip back to live and wait for audio.
      ws.send(JSON.stringify({ type: 'set_mode', mode: 'live' }));
      await new Promise((r) => setTimeout(r, 1500));
      // Stream ~1s of silence — Gemini should say something in response.
      for (let i = 0; i < 25; i++) { ws.send(silencePcm16(40)); await new Promise((r) => setTimeout(r, 40)); }
      const start = Date.now();
      while (Date.now() - start < 12_000 && events.binary === 0) {
        await new Promise((r) => setTimeout(r, 200));
      }
      if (events.binary === 0) throw new Error('REAL_KEY: never received audio from Gemini');
      console.log(`PASS received ${events.binary} audio frames / ${events.binaryBytes} bytes from Gemini`);
    } else {
      console.log('SKIP real-key audio round-trip (no GEMINI_API_KEY)');
    }

    console.log('\nALL SMOKE CHECKS PASSED');
    exitCode = 0;
    try { ws.terminate(); } catch {}
  } catch (e) {
    console.error('\nFAIL:', e.message);
  } finally {
    try { child.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} process.exit(exitCode); }, 800);
  }
})();
