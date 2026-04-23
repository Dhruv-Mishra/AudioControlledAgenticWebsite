// End-to-end wire-protocol smoke that acts like a real browser:
//   1. Opens a WebSocket to /api/live.
//   2. Sends a `hello` message.
//   3. Sends a small binary PCM16 chunk (just a few ms of silence) to prove
//      the bridge forwards it into the SDK without throwing.
//   4. Captures ALL server → client frames (text + binary) for inspection.
//   5. Verifies the browser-side Int16Array(buffer) decode on any binary
//      frame that comes back (would throw with the old tag-byte design).
//
// Uses GEMINI_API_KEY from env if present — if it's a real valid key, we'll
// also get `audio chunk bytes=N` frames back from Gemini. If the key is
// invalid/absent, we verify the error-path without audio.
//
// Usage:
//   node evals/simulated-browser-smoke.js
//   GEMINI_API_KEY=<real> node evals/simulated-browser-smoke.js   (real end-to-end)

'use strict';

const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

const PORT = 40000 + Math.floor(Math.random() * 20000);
const REAL_KEY = !!process.env.GEMINI_API_KEY;

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

function encodeSilencePcm16(ms, sampleRate = 16000) {
  const samples = Math.round((ms / 1000) * sampleRate);
  return Buffer.alloc(samples * 2); // zero bytes = silence
}

(async function main() {
  const serverPath = path.resolve(__dirname, '..', 'server.js');
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      PORT: String(PORT),
      GEMINI_API_KEY: process.env.GEMINI_API_KEY || 'invalid-for-sim',
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
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('open timeout')), 3000);
      ws.once('open', () => { clearTimeout(t); resolve(); });
      ws.once('error', reject);
    });

    const events = { text: [], binary: [] };
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        // Verify alignment-safe decode.
        const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        try {
          const pcm = new Int16Array(ab);
          events.binary.push({ bytes: data.byteLength, samples: pcm.length });
          console.log(`[client] binary bytes=${data.byteLength} samples=${pcm.length} (decoded OK)`);
        } catch (e) {
          console.log('[client] BINARY DECODE FAILED:', e.message);
          events.binary.push({ bytes: data.byteLength, error: e.message });
        }
      } else {
        try {
          const obj = JSON.parse(data.toString('utf8'));
          events.text.push(obj);
          console.log(`[client] text type=${obj.type} ${obj.state || obj.code || obj.from || ''}`);
        } catch {}
      }
    });

    ws.send(JSON.stringify({ type: 'hello', persona: 'professional', elements: [], page: '/' }));

    // Send 200ms of silence as audio (proves bridge forwards without throwing).
    setTimeout(() => {
      const pcm = encodeSilencePcm16(200);
      console.log(`[client] sending ${pcm.length} bytes of silence...`);
      ws.send(pcm);
    }, 1000);

    // Let it run for a few seconds then summarize.
    await new Promise((r) => setTimeout(r, REAL_KEY ? 8000 : 4000));

    console.log('\n--- summary ---');
    console.log('text frames received:', events.text.length);
    const types = events.text.reduce((a, e) => { a[e.type] = (a[e.type] || 0) + 1; return a; }, {});
    console.log('   by type:', types);
    console.log('binary frames received:', events.binary.length);
    if (events.binary.length > 0) {
      const total = events.binary.reduce((a, b) => a + (b.bytes || 0), 0);
      console.log(`   total audio bytes: ${total}`);
    }
    const hadConnecting = events.text.some((e) => e.type === 'state' && e.state === 'connecting');
    const hadError = events.text.some((e) => e.type === 'error');
    const hadAudio = events.binary.length > 0;

    if (REAL_KEY && !hadAudio) {
      throw new Error('REAL_KEY was set but no audio binary frames were received from Gemini');
    }
    if (!hadConnecting) throw new Error('never saw connecting state');
    if (!REAL_KEY && !hadError) throw new Error('expected an error frame with invalid key');

    console.log(`\nPASS (${REAL_KEY ? 'REAL-KEY end-to-end' : 'invalid-key smoke path'})`);
    exitCode = 0;
    try { ws.terminate(); } catch {}
  } catch (e) {
    console.error('\nFAIL:', e.message);
  } finally {
    try { child.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} process.exit(exitCode); }, 800);
  }
})();
