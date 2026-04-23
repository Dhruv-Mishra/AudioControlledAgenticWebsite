// Smoke — session resumption wire protocol. Asserts that:
//   (1) The server logs `resume=yes` when a browser sends `hello` with a
//       resumeHandle that's inside the resume window.
//   (2) The server logs `resume=no` when the hello is fresh (no handle).
//   (3) The server drops a stale handle (issuedAt outside the window) and
//       logs the drop + `resume=no`.
//   (4) The server accepts and round-trips a `page_context` message (logs
//       `page_context ignored — upstream not ready` with an invalid key,
//       which proves the handler is wired even when Gemini can't run).
//
// Invalid-key mode — no real GEMINI_API_KEY required. The point is the
// server-side wire protocol, not a real Gemini round-trip.
//
// Usage:  node evals/session-resume-smoke.js
//         npm run smoke:session-resume

'use strict';

const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

const PORT = 40000 + Math.floor(Math.random() * 20000);

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
      else reject(new Error(`missing: ${[...missing].map(String).join(', ')} | matched: ${matched.join(' | ')}`));
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

function openWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const t = setTimeout(() => reject(new Error('ws open timeout')), 3000);
    ws.once('open', () => { clearTimeout(t); resolve(ws); });
    ws.once('error', (e) => { clearTimeout(t); reject(e); });
  });
}

(async function main() {
  const serverPath = path.resolve(__dirname, '..', 'server.js');
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      PORT: String(PORT),
      GEMINI_API_KEY: 'invalid-for-resume-smoke',
      DEBUG: '1',
      DISABLE_WS_NONCE: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (d) => process.stdout.write(`  [srv] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`  [srv!] ${d}`));

  let exitCode = 1;
  try {
    await waitForListen(child);

    // ---- Phase 1: fresh hello (no handle). Expect `resume=no`. ----
    const ws1 = await openWs(`ws://localhost:${PORT}/api/live`);
    const p1 = grepLogs(child, [
      /hello persona=professional.*resume=no/
    ], 6000);
    ws1.send(JSON.stringify({ type: 'hello', persona: 'professional', elements: [], page: '/' }));
    await p1;
    console.log('PASS phase 1 — fresh hello logs resume=no');
    try { ws1.terminate(); } catch {}
    // Give the server a moment to clean up the first WS before the next.
    await new Promise((r) => setTimeout(r, 200));

    // ---- Phase 2: hello WITH a fresh handle. Expect `resume=yes`. ----
    const ws2 = await openWs(`ws://localhost:${PORT}/api/live`);
    const p2 = grepLogs(child, [
      /hello persona=professional.*resume=yes/,
      /upstream connect requested.*resume=yes/
    ], 6000);
    ws2.send(JSON.stringify({
      type: 'hello',
      persona: 'professional',
      elements: [],
      page: '/',
      resumeHandle: 'FAKE-HANDLE-FOR-SMOKE-TEST',
      resumeHandleIssuedAt: Date.now()
    }));
    await p2;
    console.log('PASS phase 2 — hello with fresh handle logs resume=yes and forwards to ai.live.connect');
    try { ws2.terminate(); } catch {}
    await new Promise((r) => setTimeout(r, 200));

    // ---- Phase 3: hello WITH an expired handle. Expect `resume=no`
    // and a "dropped" log line. ----
    const ws3 = await openWs(`ws://localhost:${PORT}/api/live`);
    const p3 = grepLogs(child, [
      /hello resumeHandle dropped/,
      /hello persona=professional.*resume=no/
    ], 6000);
    ws3.send(JSON.stringify({
      type: 'hello',
      persona: 'professional',
      elements: [],
      page: '/',
      resumeHandle: 'STALE-HANDLE-FOR-SMOKE-TEST',
      // 1 hour ago — far outside the 10-minute resume window.
      resumeHandleIssuedAt: Date.now() - 60 * 60 * 1000
    }));
    await p3;
    console.log('PASS phase 3 — stale handle dropped, session starts fresh');
    try { ws3.terminate(); } catch {}
    await new Promise((r) => setTimeout(r, 200));

    // ---- Phase 4: page_context message while upstream not ready (invalid
    // key, so upstream never succeeds). Handler must still log the skip. ----
    const ws4 = await openWs(`ws://localhost:${PORT}/api/live`);
    const p4 = grepLogs(child, [
      /page_context ignored — upstream not ready/
    ], 6000);
    ws4.send(JSON.stringify({ type: 'hello', persona: 'professional', elements: [], page: '/' }));
    // Give the bridge a tick to wire the session before we send page_context.
    await new Promise((r) => setTimeout(r, 400));
    ws4.send(JSON.stringify({
      type: 'page_context',
      page: '/carriers.html',
      title: 'Carrier Directory',
      elements: [
        { id: 'carriers.card.C-101', label: 'Liberty Freight' }
      ]
    }));
    await p4;
    console.log('PASS phase 4 — page_context wired end-to-end (dropped gracefully when upstream not ready)');
    try { ws4.terminate(); } catch {}

    console.log('\nALL SESSION-RESUME SMOKE CHECKS PASSED');
    exitCode = 0;
  } catch (e) {
    console.error('\nFAIL:', e.message);
  } finally {
    try { child.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} process.exit(exitCode); }, 800);
  }
})();
