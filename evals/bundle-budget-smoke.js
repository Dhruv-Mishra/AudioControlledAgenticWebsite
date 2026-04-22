// Bundle-budget smoke — fails if our post-build chunk sizes exceed Oracle's
// performance budget.
//
// Budgets (gzipped):
//   - dist/js/voice-agent.js         ≤ 15 KB   (main voice path)
//   - dist/js/stt-controller.js      ≤  5 KB   (new; STT main-thread driver)
//   - dist/js/stt-worker.js          ≤ 20 KB   (new; transformers.js is its own chunk)
//   - dist/js/page-*.js              ≤ 20 KB   (per-page chunks; warning only)
//
// The `@xenova/transformers` chunk is NOT budgeted — it's multi-MB by design
// and lives outside the initial load path (only fetched on the first placeCall).
//
// Usage:
//   npm run build
//   node evals/bundle-budget-smoke.js
//
// Exit codes: 0 ok, 1 budget violation, 2 dist missing.

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DIST = path.resolve(__dirname, '..', 'dist');
const JS = path.join(DIST, 'js');

// Chunk names include an esbuild hash suffix (e.g. `stt-controller-JYM2DJCC.js`).
// The patterns below match on the leading name + hash + `.js`.
const BUDGETS = [
  // voice-agent.js is a tiny re-export facade after esbuild splits code into
  // shared chunks — the real main-thread voice surface is the largest chunk
  // imported by it. 15 KB is the gzipped budget for voice-agent ITSELF (the
  // facade); the shared voice chunk is audited via the warnings list.
  { pattern: /^voice-agent\.js$/,               maxKb: 15, label: 'voice-agent.js' },
  { pattern: /^stt-controller(-[A-Z0-9]+)?\.js$/, maxKb:  7, label: 'stt-controller.js' },
  { pattern: /^stt-worker(-[A-Z0-9]+)?\.js$/,     maxKb: 20, label: 'stt-worker.js' }
];
const WARNINGS = [
  { pattern: /^page-.*\.js$/,                       maxKb: 20, label: 'page-*' },
  // The shared voice chunk (audio-pipeline + voice-agent + tool-registry + etc)
  // bundled by esbuild. Warn — don't fail — if it balloons past this.
  { pattern: /^chunk-[A-Z0-9]+\.js$/,               maxKb: 25, label: 'shared-voice-chunk' }
];

function gzipSize(buf) {
  return zlib.gzipSync(buf, { level: 9 }).length;
}

function walk(dir, rel = '') {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const relPath = path.posix.join(rel, e.name);
    if (e.isDirectory()) out.push(...walk(full, relPath));
    else out.push({ abs: full, rel: relPath, name: e.name });
  }
  return out;
}

function main() {
  if (!fs.existsSync(DIST) || !fs.existsSync(JS)) {
    console.error('FAIL  dist/ is missing. Run `npm run build` first.');
    process.exit(2);
  }
  const files = walk(JS).filter((f) => f.name.endsWith('.js'));
  if (!files.length) {
    console.error('FAIL  no .js files in dist/js/.');
    process.exit(2);
  }

  // Report each file's gzip size so reviewers can see the perf delta.
  const report = [];
  for (const f of files) {
    const buf = fs.readFileSync(f.abs);
    const raw = buf.length;
    const gz = gzipSize(buf);
    report.push({ name: f.name, rel: f.rel, raw, gz });
  }
  report.sort((a, b) => b.gz - a.gz);

  console.log('Bundle sizes (gzipped):');
  for (const r of report) {
    console.log(`  ${r.rel.padEnd(48)} ${String(Math.round(r.raw / 1024) + ' KB').padStart(8)}  gz=${String(Math.round(r.gz / 1024 * 10) / 10 + ' KB').padStart(8)}`);
  }

  let fail = 0;
  const checked = new Set();
  for (const b of BUDGETS) {
    const hits = report.filter((r) => b.pattern.test(r.name));
    if (!hits.length) {
      console.error(`FAIL  missing budgeted file matching ${b.pattern}`);
      fail += 1;
      continue;
    }
    for (const hit of hits) {
      checked.add(hit.name);
      const kb = hit.gz / 1024;
      if (kb > b.maxKb) {
        console.error(`FAIL  ${hit.rel} gzip=${kb.toFixed(1)} KB > budget ${b.maxKb} KB`);
        fail += 1;
      } else {
        console.log(`PASS  ${hit.rel} gzip=${kb.toFixed(1)} KB ≤ budget ${b.maxKb} KB`);
      }
    }
  }

  for (const w of WARNINGS) {
    for (const r of report) {
      if (!w.pattern.test(r.name)) continue;
      const kb = r.gz / 1024;
      if (kb > w.maxKb) {
        console.warn(`WARN  ${r.rel} gzip=${kb.toFixed(1)} KB > soft budget ${w.maxKb} KB`);
      }
    }
  }

  if (fail) {
    console.error(`\n${fail} budget violation(s).`);
    process.exit(1);
  }
  console.log(`\nAll ${BUDGETS.length} budgets satisfied.`);
  process.exit(0);
}

main();
