// Smoke test — asserts the bridge actually attempts ai.live.connect() on the
// first `hello` message. Does NOT require a real GEMINI_API_KEY — we give it
// a bogus key and grep the server's DEBUG log for `upstream connect requested`
// and `ai.live.connect` evidence. Catches regressions where someone refactors
// the bridge to async iteration or removes the SDK call altogether.
//
// Usage:  node evals/upstream-handshake-smoke.js

'use strict';

const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

const PORT = 40000 + Math.floor(Math.random() * 20000);

function waitForListen(child, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const t = setTimeout(() => {
      if (done) return; done = true;
      reject(new Error('server did not start'));
    }, timeoutMs);
    function onData(d) {
      const s = d.toString('utf8');
      if (/listening on http:/i.test(s)) {
        if (done) return; done = true;
        clearTimeout(t);
        resolve();
      }
    }
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
  });
}

function runAndGrep(child, patterns, timeoutMs = 8000) {
  const missing = new Set(patterns);
  const matched = [];
  return new Promise((resolve, reject) => {
    let done = false;
    const t = setTimeout(() => {
      if (done) return; done = true;
      if (missing.size === 0) resolve(matched);
      else reject(new Error(`missing patterns: ${[...missing].join(', ')}\nmatched: ${matched.join(' | ')}`));
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
        done = true;
        clearTimeout(t);
        resolve(matched);
      }
    }
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
  });
}

(async function main() {
  const serverPath = path.resolve(__dirname, '..', 'server.js');
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      PORT: String(PORT),
      GEMINI_API_KEY: 'invalid-key-for-handshake-smoke',
      DEBUG: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  // Echo server output to our stdout for visibility.
  child.stdout.on('data', (d) => process.stdout.write(`  [srv] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`  [srv!] ${d}`));

  let exitCode = 1;
  try {
    await waitForListen(child);
    const ws = new WebSocket(`ws://localhost:${PORT}/api/live`);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('ws open timeout')), 3000);
      ws.once('open', () => { clearTimeout(t); resolve(); });
      ws.once('error', (e) => { clearTimeout(t); reject(e); });
    });
    // Start grepping BEFORE we send hello so we catch the connect log.
    const grep = runAndGrep(child, [
      'upstream connect requested',
      /model=gemini-.+-live/,
      'attach complete',
      /onclose|onerror|invalid_key/
    ], 10_000);
    ws.send(JSON.stringify({ type: 'hello', persona: 'professional', elements: [], page: '/' }));
    const matched = await grep;
    console.log('\nPASS — bridge attempted live.connect and reported upstream result:');
    matched.forEach((m) => console.log('   •', m));
    exitCode = 0;
    try { ws.terminate(); } catch {}
  } catch (e) {
    console.error('\nFAIL:', e.message);
  } finally {
    try { child.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} process.exit(exitCode); }, 800);
  }
})();
