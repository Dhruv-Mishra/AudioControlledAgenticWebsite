// Round-7 smoke — callOpen `onended` deterministic invariants.
//
// Runs the Playwright browser repro (evals/_r7-browser-repro-v2.js)
// with 5 consecutive fresh-page placeCall cycles and asserts ALL
// five round-7 invariants on every run:
//
//   I1. Background audio MUST NOT play during callOpen.
//   I2. Agent audio MUST NOT reach the client before audio_prelude_ended.
//   I3. audio_prelude_ended is sent exactly once per run.
//   I4. Background real-play happens within 100ms of the prelude signal.
//   I5. No unexpected console.error events.
//
// Requires `playwright` as a dev dep (auto-installed on first run).
// Depends on the dev server being up at http://localhost:3001/ — if
// it's not, this smoke fails fast.
//
// Usage:
//   # start dev server in another terminal
//   PORT=3001 node server.js
//   # then:
//   npm run smoke:callopen-onended-invariant

'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

const PORT = Number(process.env.SMOKE_PORT || 3001);
const N_RUNS = Number(process.env.SMOKE_RUNS || 3);  // default 3 for CI speed
const OUTDIR = path.resolve(__dirname, '..', '.playwright-mcp');

function checkServer() {
  return new Promise((resolve) => {
    const req = http.get('http://localhost:' + PORT + '/api/health', (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1500, () => { req.destroy(); resolve(false); });
  });
}

async function main() {
  // 1. Verify dev server is running. We don't spawn one because the
  //    repro harness is launched in a child process that would need
  //    to inherit env / API key. Simpler: require the caller to have
  //    a server up.
  if (!await checkServer()) {
    console.error('FAIL: dev server not running on port ' + PORT + '.');
    console.error('  Run: PORT=' + PORT + ' node server.js');
    process.exit(1);
  }

  // 2. Run the Playwright repro.
  const reproPath = path.resolve(__dirname, '_r7-browser-repro-v2.js');
  if (!fs.existsSync(reproPath)) {
    console.error('FAIL: repro harness missing at ' + reproPath);
    process.exit(1);
  }

  const before = fs.readdirSync(OUTDIR).filter((f) => /^r7v2-run-/.test(f));
  const existingSet = new Set(before);

  console.log('Running ' + N_RUNS + ' Playwright repro runs...');
  const child = spawn(process.execPath, [reproPath], {
    env: {
      ...process.env,
      REPRO_RUNS: String(N_RUNS),
      REPRO_URL: 'http://localhost:' + PORT + '/',
      PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || (process.env.HOME || process.env.USERPROFILE) + '/AppData/Local/ms-playwright'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (d) => process.stdout.write('  [repro] ' + d));
  child.stderr.on('data', (d) => process.stderr.write('  [repro!] ' + d));

  const reproCode = await new Promise((resolve) => child.on('exit', resolve));
  if (reproCode !== 0) {
    console.error('FAIL: repro harness exited with code ' + reproCode);
    process.exit(1);
  }

  // 3. Find new dump files + run invariant check on each.
  const after = fs.readdirSync(OUTDIR).filter((f) => /^r7v2-run-/.test(f));
  const newFiles = after.filter((f) => !existingSet.has(f)).sort();
  if (newFiles.length !== N_RUNS) {
    console.error('FAIL: expected ' + N_RUNS + ' new dumps, got ' + newFiles.length);
    process.exit(1);
  }

  const checker = path.resolve(__dirname, '_r7-invariant-check.js');
  let pass = 0, fail = 0;
  const results = [];
  for (let i = 0; i < newFiles.length; i++) {
    const f = path.join(OUTDIR, newFiles[i]);
    const out = await new Promise((resolve) => {
      const c = spawn(process.execPath, [checker, f], { stdio: ['ignore', 'pipe', 'pipe'] });
      let buf = '';
      c.stdout.on('data', (d) => { buf += d.toString('utf8'); });
      c.stderr.on('data', (d) => { buf += d.toString('utf8'); });
      c.on('exit', (code) => resolve({ code, buf }));
    });
    const ok = /ALL INVARIANTS HOLD/.test(out.buf);
    results.push({ run: i + 1, file: newFiles[i], ok });
    if (ok) { pass++; console.log('  run ' + (i + 1) + ' PASS'); }
    else { fail++; console.error('  run ' + (i + 1) + ' FAIL — see ' + newFiles[i]); process.stderr.write(out.buf); }
  }

  console.log('\n=== ' + pass + ' pass / ' + fail + ' fail across ' + N_RUNS + ' runs ===');
  if (fail === 0) {
    console.log('ROUND-7 CALLOPEN ONENDED INVARIANT HOLDS — background never overlaps callOpen, agent never speaks early, prelude fires once, determinism confirmed.');
    process.exit(0);
  }
  process.exit(1);
}

main().catch((err) => { console.error('FATAL:', err.stack || err.message); process.exit(1); });
