// Smoke — WS nonce handshake.
//
// Asserts the origin-protection + signed-nonce gate on the WS upgrade.
//
//   1. GET /api/ws-nonce returns { nonce, exp, ttlMs } with nonce.length > 0.
//   2. WS open with NO token → 401 Unauthorized.
//   3. WS open with FORGED token (right shape, wrong HMAC) → 401.
//   4. WS open with a valid token → upgrades cleanly.
//   5. Reopening the same WS with the SAME token → 401 (replay protection).
//   6. WS open with an EXPIRED token → 401.
//
// Uses Node's `http` + `ws` stacks directly so we can observe the response
// status on the upgrade attempt.
//
// Usage:
//   node evals/ws-nonce-smoke.js
//   npm run smoke:ws-nonce

'use strict';

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const { mintNonce } = require('../api/ws-nonce');

const PORT = 40000 + Math.floor(Math.random() * 20000);
const SECRET = 'ws-nonce-smoke-secret-please-stay-longer-than-16';

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

function httpJson(port, pathName) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: pathName, timeout: 3000 },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            resolve({ status: res.statusCode, body });
          } catch (e) { reject(e); }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('http timeout')); });
  });
}

// Attempt a WS upgrade and return the HTTP response status (or 101 on success).
// Resolves with { status } — never throws.
function attemptWs(url) {
  return new Promise((resolve) => {
    // ws's unexpected-response is our hook for non-101 responses.
    let opened = false;
    const ws = new WebSocket(url, { handshakeTimeout: 2000 });
    ws.on('open', () => { opened = true; try { ws.close(); } catch {} resolve({ status: 101 }); });
    ws.on('unexpected-response', (req, res) => {
      resolve({ status: res.statusCode, reason: res.headers['x-ws-auth-reason'] || null });
      try { res.resume(); } catch {}
    });
    ws.on('error', (err) => {
      if (opened) return;
      // Connection refused / reset before response — surface the error.
      resolve({ status: 0, err: err.message || String(err) });
    });
    setTimeout(() => { if (!opened) { try { ws.terminate(); } catch {} resolve({ status: 0, err: 'timeout' }); } }, 2500);
  });
}

(async function main() {
  const serverPath = path.resolve(__dirname, '..', 'server.js');
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      PORT: String(PORT),
      GEMINI_API_KEY: 'invalid-for-nonce-smoke',
      DEBUG: '1',
      // Crucial: nonce checking MUST be on for this smoke. No bypass.
      DISABLE_WS_NONCE: '0',
      WS_NONCE_SECRET: SECRET
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (d) => process.stdout.write('  [srv] ' + d));
  child.stderr.on('data', (d) => process.stderr.write('  [srv!] ' + d));

  let fail = 0;
  const assertEq = (label, actual, expected) => {
    if (actual === expected) { console.log('PASS  ' + label + ' → ' + actual); }
    else                     { console.error('FAIL  ' + label + ' — got ' + actual + ', expected ' + expected); fail += 1; }
  };

  try {
    await waitForListen(child);

    // 1. /api/ws-nonce — returns { nonce, exp }.
    const n1 = await httpJson(PORT, '/api/ws-nonce');
    if (n1.status !== 200) throw new Error('nonce endpoint status ' + n1.status);
    if (typeof n1.body.nonce !== 'string' || !n1.body.nonce) throw new Error('missing nonce field');
    if (typeof n1.body.exp !== 'number' || n1.body.exp < Date.now()) throw new Error('bad exp');
    console.log('PASS  /api/ws-nonce returns fresh nonce len=' + n1.body.nonce.length + ' exp+' + (n1.body.exp - Date.now()) + 'ms');

    // 2. No token → 401.
    const r2 = await attemptWs('ws://127.0.0.1:' + PORT + '/api/live');
    assertEq('no-token → 401', r2.status, 401);

    // 3. Forged token (right length, wrong HMAC).
    //    We build a 52-byte token with a valid rand+exp but random sig.
    const forged = Buffer.concat([
      require('crypto').randomBytes(16),
      (() => { const b = Buffer.alloc(4); b.writeUInt32BE(Math.floor(Date.now()/1000) + 30, 0); return b; })(),
      require('crypto').randomBytes(32)
    ]);
    const forgedB64 = forged.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    const r3 = await attemptWs('ws://127.0.0.1:' + PORT + '/api/live?token=' + encodeURIComponent(forgedB64));
    assertEq('forged-token → 401', r3.status, 401);

    // 4. Valid token → 101.
    const n4 = await httpJson(PORT, '/api/ws-nonce');
    const r4 = await attemptWs('ws://127.0.0.1:' + PORT + '/api/live?token=' + encodeURIComponent(n4.body.nonce));
    assertEq('valid-token → 101', r4.status, 101);

    // 5. Replay: same token again → 401.
    const r5 = await attemptWs('ws://127.0.0.1:' + PORT + '/api/live?token=' + encodeURIComponent(n4.body.nonce));
    assertEq('replay-token → 401', r5.status, 401);
    if (r5.reason && r5.reason !== 'replay') {
      console.warn('WARN  replay reason header = ' + r5.reason + ' (expected "replay")');
    }

    // 6. Expired token: we can't fabricate an already-signed expired token
    //    from outside (different secret), but we CAN mint one with
    //    mintNonce using the same secret — so set the env var identically
    //    and call the module's helper. But we'd need to coordinate with
    //    the child's secret. Simpler: use the in-process mintNonce with
    //    the same WS_NONCE_SECRET, then wait until exp elapses.
    //    TTL is 60 s — too slow for CI. Instead we set the env var to the
    //    SAME secret and mint fresh with mintNonce, wait 1 s, and
    //    manually rewind the exp by subtracting TTL+1 s from a new token.
    //
    //    We achieve this by re-signing a token with an expired exp using
    //    the same secret the server sees via WS_NONCE_SECRET. Since this
    //    script shares the same secret string we can do it locally.
    process.env.WS_NONCE_SECRET = SECRET;
    const crypto = require('crypto');
    const rand = crypto.randomBytes(16);
    const expBuf = Buffer.alloc(4);
    // 10 s in the past.
    expBuf.writeUInt32BE(Math.floor(Date.now() / 1000) - 10, 0);
    const hmac = crypto.createHmac('sha256', Buffer.from(SECRET, 'utf8'));
    hmac.update(rand);
    hmac.update(expBuf);
    const sig = hmac.digest();
    const expired = Buffer.concat([rand, expBuf, sig]);
    const expiredB64 = expired.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    const r6 = await attemptWs('ws://127.0.0.1:' + PORT + '/api/live?token=' + encodeURIComponent(expiredB64));
    assertEq('expired-token → 401', r6.status, 401);

    if (fail === 0) {
      console.log('\nALL NONCE SMOKE CHECKS PASSED');
      process.exit(0);
    } else {
      console.error('\n' + fail + ' check(s) failed');
      process.exit(1);
    }
  } catch (e) {
    console.error('\nFAIL:', e.message);
    process.exit(1);
  } finally {
    try { child.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 500);
  }
})();
