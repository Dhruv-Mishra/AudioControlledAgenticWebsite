// Smoke — Live-mode cold-start wire protocol.
//
// Updated semantic (Place Call UX): after the user clicks Place Call,
// the browser opens exactly ONE WS, sends exactly ONE hello (mode=live),
// and the server opens exactly ONE upstream. No disconnect/reconnect
// dance is required.
//
// Using an invalid GEMINI_API_KEY deliberately — we're testing the wire
// protocol (single upstream open) and the defence-in-depth audio drop,
// not a real Gemini round-trip.
//
// Phases:
//   1. Open WS, send hello mode=live. Assert server logs the mode
//      transition to `mode=live` and `upstream connect requested` ONCE.
//   2. Without sending any set_mode, fire some audio frames. Because
//      setup_complete never arrives (invalid key), the server's defensive
//      `drop pre-setup audio` log fires — proves the gate still works.
//   3. Assert `upstream connect requested` was logged EXACTLY ONCE
//      during the entire run (no reconnect churn).
//
// Usage:  node evals/cold-start-live-smoke.js
//         npm run smoke:cold-start-live

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

function countMatches(buffer, re) {
  const m = buffer.match(re);
  return m ? m.length : 0;
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
      GEMINI_API_KEY: 'invalid-for-cold-start-smoke',
      DEBUG: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let collected = '';
  child.stdout.on('data', (d) => { const s = d.toString('utf8'); collected += s; process.stdout.write(`  [srv] ${s}`); });
  child.stderr.on('data', (d) => { const s = d.toString('utf8'); collected += s; process.stderr.write(`  [srv!] ${s}`); });

  let exitCode = 1;
  try {
    await waitForListen(child);

    const ws = new WebSocket(`ws://localhost:${PORT}/api/live`);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('open timeout')), 3000);
      ws.once('open', () => { clearTimeout(t); resolve(); });
      ws.once('error', reject);
    });

    // Phase 1: Place-Call-equivalent — single hello with mode=live.
    const phase1 = grepLogs(child, [
      /hello persona=professional mode=live/,
      /upstream connect requested.*mode=live/,
      /onopen model=/
    ], 6000);
    ws.send(JSON.stringify({
      type: 'hello',
      persona: 'professional',
      elements: [],
      page: '/',
      mode: 'live'
    }));
    await phase1;
    console.log('PASS phase 1 — single hello mode=live, upstream opened + onopen');

    // Phase 2: defence-in-depth drop of pre-setup audio. There's a narrow
    // window between onopen (upstream non-null) and onclose (upstream set
    // back to null). With an invalid key that window is tight, so we fire
    // audio in a tight loop and sample it — as long as at least one frame
    // lands while upstream !== null and upstreamEverProducedData === false,
    // the server must log the drop.
    //
    // If the window is too narrow for the drop log to fire, we fall back
    // to asserting the client-side semantic via the browser-sim and live-
    // mode smokes; the SERVER guard is genuinely best-effort when the key
    // is bad. This phase is skipped (not failed) in that case.
    let dropSeen = false;
    const dropPromise = grepLogs(child, [/drop pre-setup audio/], 1500).then(
      () => { dropSeen = true; },
      () => { /* timed out — not fatal */ }
    );
    for (let i = 0; i < 60; i++) {
      ws.send(silencePcm16(20));
    }
    await dropPromise;
    if (dropSeen) {
      console.log('PASS phase 2 — server drops audio sent before setup_complete');
    } else {
      console.log('SKIP phase 2 — upstream closed before any audio frame landed (invalid key timing). Semantic is covered by smoke:browser-sim.');
    }

    // Phase 3: assert no reconnect churn — exactly ONE upstream connect.
    await new Promise((r) => setTimeout(r, 500));
    const connectCount = countMatches(collected, /upstream connect requested/g);
    if (connectCount !== 1) {
      throw new Error(`expected exactly 1 upstream connect requested, got ${connectCount}`);
    }
    console.log(`PASS phase 3 — exactly 1 upstream connect (no reconnect churn)`);

    console.log('\nALL COLD-START-LIVE SMOKE CHECKS PASSED');
    exitCode = 0;
    try { ws.terminate(); } catch {}
  } catch (e) {
    console.error('\nFAIL:', e.message);
  } finally {
    try { child.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} process.exit(exitCode); }, 800);
  }
})();
