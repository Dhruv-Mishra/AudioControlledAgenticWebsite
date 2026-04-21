// Smoke — GEMINI_TRANSCRIPTION + SHOW_TEXT env-var toggles.
//
// Walks the 2×2 matrix (false/true × false/true), spawns a server child for
// each, waits for the listen log, fetches /api/config, and asserts:
//
//   1. Server starts cleanly under each combination (no crash).
//   2. /api/config.flags matches the env vars set on the child.
//   3. The startup log prints the effective flag values.
//   4. /api/health still returns 200 (baseline liveness check).
//
// No GEMINI_API_KEY is required — we don't round-trip to Gemini. The test
// only verifies the wire protocol between env → server → /api/config.
//
// Usage:
//   node evals/transcription-toggle-smoke.js
//   npm run smoke:transcription-toggle

'use strict';

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

function pickPort() {
  return 40000 + Math.floor(Math.random() * 20000);
}

// Attach a persistent buffer to the child so grepLog can match against
// logs written BEFORE it was called (e.g. the `[server-flags]` line, which
// fires during module load — often before `listening on http:`).
function attachBuffer(child) {
  const buf = { text: '', watchers: [] };
  function onData(d) {
    buf.text += d.toString('utf8');
    for (const w of buf.watchers.slice()) {
      if (w.pattern.test(buf.text)) {
        w.resolve(buf.text);
        buf.watchers.splice(buf.watchers.indexOf(w), 1);
      }
    }
  }
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  return buf;
}

function waitFor(buf, pattern, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (pattern.test(buf.text)) return resolve(buf.text);
    const watcher = { pattern, resolve: null };
    const t = setTimeout(() => {
      const idx = buf.watchers.indexOf(watcher);
      if (idx >= 0) buf.watchers.splice(idx, 1);
      reject(new Error('timeout waiting for ' + pattern));
    }, timeoutMs);
    watcher.resolve = (v) => { clearTimeout(t); resolve(v); };
    buf.watchers.push(watcher);
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

async function runCombo({ geminiTranscription, showText }) {
  const port = pickPort();
  const serverPath = path.resolve(__dirname, '..', 'server.js');
  const env = {
    ...process.env,
    PORT: String(port),
    GEMINI_API_KEY: 'smoke-test-key',
    // Explicit strings so we also exercise the parseBool matrix.
    GEMINI_TRANSCRIPTION: String(geminiTranscription),
    SHOW_TEXT: String(showText),
    NODE_ENV: 'development'
  };
  const child = spawn(process.execPath, [serverPath], {
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const label = `g=${geminiTranscription} s=${showText}`;
  const prefix = `  [${label}]`;
  child.stdout.on('data', (d) => process.stdout.write(`${prefix} ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`${prefix} ERR ${d}`));

  const buf = attachBuffer(child);

  try {
    // Wait for the listen log AND the server-flags summary. The flag
    // summary must reflect the exact values set on the child.
    await waitFor(buf, /listening on http:/i, 6000);
    const flagPattern = new RegExp(
      `server-flags.*GEMINI_TRANSCRIPTION=${geminiTranscription}.*SHOW_TEXT=${showText}`
    );
    await waitFor(buf, flagPattern, 3000);

    // /api/health — proves the server is accepting HTTP.
    const health = await httpJson(port, '/api/health');
    if (health.status !== 200 || !health.body || health.body.ok !== true) {
      throw new Error(`unexpected health: ${JSON.stringify(health)}`);
    }

    // /api/config — the contract under test.
    const cfg = await httpJson(port, '/api/config');
    if (cfg.status !== 200) throw new Error(`config status=${cfg.status}`);
    if (!cfg.body || !cfg.body.flags) throw new Error('config missing flags');
    if (cfg.body.flags.geminiTranscription !== geminiTranscription) {
      throw new Error(`flags.geminiTranscription=${cfg.body.flags.geminiTranscription} expected ${geminiTranscription}`);
    }
    if (cfg.body.flags.showText !== showText) {
      throw new Error(`flags.showText=${cfg.body.flags.showText} expected ${showText}`);
    }
    console.log(`PASS ${label}: /api/config.flags = ${JSON.stringify(cfg.body.flags)}`);
  } finally {
    try { child.kill('SIGTERM'); } catch {}
    // Give the child a beat to exit before we return so ports don't clash
    // across combos.
    await new Promise((r) => setTimeout(r, 250));
    try { child.kill('SIGKILL'); } catch {}
  }
}

(async function main() {
  const combos = [
    { geminiTranscription: false, showText: true  },  // default
    { geminiTranscription: false, showText: false },
    { geminiTranscription: true,  showText: true  },
    { geminiTranscription: true,  showText: false }
  ];
  let failed = 0;
  for (const c of combos) {
    try {
      await runCombo(c);
    } catch (err) {
      failed += 1;
      console.error(`FAIL g=${c.geminiTranscription} s=${c.showText}: ${err.message}`);
    }
  }
  if (failed) {
    console.error(`\n${failed}/${combos.length} combinations FAILED`);
    process.exit(1);
  }
  console.log(`\nALL ${combos.length} TRANSCRIPTION-TOGGLE COMBINATIONS PASSED`);
})();
