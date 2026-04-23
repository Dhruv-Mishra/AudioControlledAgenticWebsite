// Forced-failure smoke test: invalid GEMINI_API_KEY must NOT take the server
// down. /api/health must still return 200 and the Live WS must surface a
// JSON { type: "error", code: "invalid_key", ... } frame promptly.
//
// This script starts its own ephemeral server child so it can set a bad key
// without disturbing an already-running dev server.
//
// Usage: node evals/invalid-key-smoke.js

'use strict';

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');

// Pick a random high port so we don't collide with a dev server or leftovers.
const PORT = 40000 + Math.floor(Math.random() * 20000);

function waitForHealth(timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    function tick() {
      const req = http.get(
        { host: 'localhost', port: PORT, path: '/api/health' },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              if (res.statusCode === 200 && body.ok) resolve(body);
              else retry(new Error('bad health body'));
            } catch (e) { retry(e); }
          });
        }
      );
      req.on('error', retry);
    }
    function retry(err) {
      if (Date.now() - start > timeoutMs) return reject(err || new Error('health timeout'));
      setTimeout(tick, 200);
    }
    tick();
  });
}

function waitForErrorFrame(timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/api/live`);
    const received = [];
    let done = false;
    const finish = (res, err) => {
      if (done) return; done = true;
      try { ws.terminate(); } catch {}
      if (err) {
        err.received = received;
        reject(err);
      } else resolve(res);
    };
    const timeout = setTimeout(() => {
      const e = new Error('no error frame before timeout');
      finish(null, e);
    }, timeoutMs);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', persona: 'professional', elements: [], page: '/' }));
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      try {
        const msg = JSON.parse(data.toString('utf8'));
        received.push(msg);
        if (msg.type === 'error') {
          clearTimeout(timeout);
          finish(msg);
        }
        if (msg.type === 'state' && msg.state === 'error') {
          clearTimeout(timeout);
          finish(msg);
        }
      } catch {}
    });
    ws.on('error', (e) => { clearTimeout(timeout); finish(null, e); });
    ws.on('close', () => {});
  });
}

(async function main() {
  const serverPath = path.resolve(__dirname, '..', 'server.js');
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      PORT: String(PORT),
      GEMINI_API_KEY: 'invalid-key-for-smoke-test',
      // Avoid loading real dotenv in case it overrides.
      DOTENV_DISABLE: '1',
      DISABLE_WS_NONCE: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stdout.on('data', (d) => process.stdout.write(`  [server] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`  [server err] ${d}`));

  let exitCode = 1;
  try {
    const hc = await waitForHealth();
    if (!hc.hasApiKey) throw new Error('health reported hasApiKey=false — wrong process was probed?');
    console.log('PASS health =', hc);
    const err = await waitForErrorFrame();
    console.log('PASS error frame =', err);
    exitCode = 0;
  } catch (e) {
    console.error('FAIL', e.message);
  } finally {
    try { child.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} process.exit(exitCode); }, 800);
  }
})();
