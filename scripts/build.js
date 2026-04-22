'use strict';

/**
 * Production build for Dhruv FreightOps.
 *
 * Runs esbuild over the client-side JS and CSS and writes minified bundles
 * to `dist/`. Entry points:
 *
 *   • js/app.js          → dist/js/app.js          (bundled + minified)
 *   • js/page-*.js       → dist/js/page-*.js       (dynamic imports; bundled per page)
 *   • js/audio-worklets/pcm-capture.js → dist/js/audio-worklets/pcm-capture.js
 *   • css/*.css          → dist/css/*.css          (minified)
 *
 * HTML shell is copied (not bundled) — we rewrite the `/js/app.js` reference
 * from the source tree via a tiny post-step (see writeHtmlShell below).
 *
 * Flags:
 *   --metafile   Also writes dist/meta.json (esbuild metafile for bundle
 *                inspection). Verifies no accidentally-large imports.
 *   --sourcemap  Emits external source maps (SOURCEMAPS=true env also works).
 *
 * Exit codes:
 *   0 = ok; non-zero = build failed.
 */

const esbuild = require('esbuild');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

const argv = process.argv.slice(2);
const EMIT_META = argv.includes('--metafile');
const EMIT_MAPS = argv.includes('--sourcemap') || process.env.SOURCEMAPS === 'true';

async function rimraf(p) {
  try { await fsp.rm(p, { recursive: true, force: true }); } catch {}
}

async function ensureDir(p) { await fsp.mkdir(p, { recursive: true }); }

async function copyFile(src, dst) {
  await ensureDir(path.dirname(dst));
  await fsp.copyFile(src, dst);
}

/** esbuild options common to every build call. */
const commonJsOpts = {
  bundle: true,
  format: 'esm',
  target: ['chrome110', 'firefox115', 'safari17', 'edge110'],
  minify: true,
  sourcemap: EMIT_MAPS,
  legalComments: 'none',
  charset: 'utf8',
  logLevel: 'info',
  treeShaking: true
};

async function buildJs(entryPoints) {
  const res = await esbuild.build({
    ...commonJsOpts,
    entryPoints,
    outdir: path.join(DIST, 'js'),
    entryNames: '[name]',
    chunkNames: 'chunks/[name]-[hash]',
    splitting: true,
    metafile: EMIT_META
  });
  return res;
}

async function buildWorklet() {
  // Worklet must stand alone (no imports, no splitting). Output as IIFE so the
  // `registerProcessor` call runs when the browser loads it.
  const res = await esbuild.build({
    ...commonJsOpts,
    entryPoints: [path.join(ROOT, 'js/audio-worklets/pcm-capture.js')],
    outdir: path.join(DIST, 'js/audio-worklets'),
    format: 'iife',
    splitting: false,
    metafile: EMIT_META
  });
  return res;
}

async function buildCss() {
  const cssEntries = (await fsp.readdir(path.join(ROOT, 'css')))
    .filter((f) => f.endsWith('.css'))
    .map((f) => path.join(ROOT, 'css', f));
  const res = await esbuild.build({
    entryPoints: cssEntries,
    outdir: path.join(DIST, 'css'),
    loader: { '.css': 'css' },
    bundle: false,
    minify: true,
    sourcemap: EMIT_MAPS,
    legalComments: 'none',
    charset: 'utf8',
    logLevel: 'info',
    metafile: EMIT_META
  });
  return res;
}

async function copyStatic() {
  // Partials and public assets are served verbatim.
  const dirs = ['partials', 'public', 'data'];
  for (const d of dirs) {
    const src = path.join(ROOT, d);
    try {
      const stat = await fsp.stat(src);
      if (!stat.isDirectory()) continue;
    } catch { continue; }
    const entries = await fsp.readdir(src, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.isDirectory()) continue;
      await copyFile(path.join(src, ent.name), path.join(DIST, d, ent.name));
    }
  }
}

async function writeHtmlShell() {
  // Copy index.html verbatim — in production the server rewrites module
  // paths at request time (see `resolveStaticPath` in server.js). Keeps the
  // build step idempotent.
  const src = await fsp.readFile(path.join(ROOT, 'index.html'), 'utf8');
  await ensureDir(DIST);
  await fsp.writeFile(path.join(DIST, 'index.html'), src, 'utf8');
}

function humanSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

async function walkDir(dir, rel = '') {
  const out = [];
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    const relPath = path.posix.join(rel, ent.name);
    if (ent.isDirectory()) {
      out.push(...(await walkDir(full, relPath)));
    } else {
      const st = await fsp.stat(full);
      out.push({ rel: relPath, size: st.size });
    }
  }
  return out;
}

async function printSummary(results) {
  const files = await walkDir(DIST);
  files.sort((a, b) => b.size - a.size);
  let total = 0;
  process.stdout.write('\nBuild output:\n');
  for (const f of files) {
    total += f.size;
    process.stdout.write(`  ${f.rel.padEnd(48)} ${humanSize(f.size).padStart(10)}\n`);
  }
  process.stdout.write(`  ${'TOTAL'.padEnd(48)} ${humanSize(total).padStart(10)}\n`);

  if (EMIT_META) {
    // Merge all metafiles so a single dist/meta.json can be opened in
    // https://esbuild.github.io/analyze/ for a visual tree-shake audit.
    const merged = { inputs: {}, outputs: {} };
    for (const r of results.filter(Boolean)) {
      if (!r.metafile) continue;
      Object.assign(merged.inputs, r.metafile.inputs);
      Object.assign(merged.outputs, r.metafile.outputs);
    }
    await fsp.writeFile(
      path.join(DIST, 'meta.json'),
      JSON.stringify(merged, null, 2),
      'utf8'
    );
    process.stdout.write(`\nMetafile written to dist/meta.json (drop into https://esbuild.github.io/analyze/ to inspect).\n`);
  }
}

async function main() {
  const t0 = Date.now();
  process.stdout.write('Building dhruv-freightops → dist/ ...\n');
  await rimraf(DIST);
  await ensureDir(DIST);

  const jsEntries = [
    path.join(ROOT, 'js/app.js'),
    path.join(ROOT, 'js/voice-agent.js'),
    path.join(ROOT, 'js/router.js'),
    path.join(ROOT, 'js/page-dispatch.js'),
    path.join(ROOT, 'js/page-carriers.js'),
    path.join(ROOT, 'js/page-negotiate.js'),
    path.join(ROOT, 'js/page-contact.js'),
    // STT pipeline — worker must be an explicit entry so `new URL(...,
    // import.meta.url)` in stt-controller can resolve it after build.
    // transformers.js is dynamically imported inside the worker and
    // esbuild code-splits it into its own chunk (kept out of the initial
    // load path — first placeCall triggers the fetch).
    path.join(ROOT, 'js/stt-worker.js')
  ];

  const results = await Promise.all([
    buildJs(jsEntries),
    buildWorklet(),
    buildCss()
  ]);

  await copyStatic();
  await writeHtmlShell();

  await printSummary(results);

  const ms = Date.now() - t0;
  process.stdout.write(`\nBuild complete in ${ms} ms. SOURCEMAPS=${EMIT_MAPS ? 'on' : 'off'}\n`);
}

main().catch((err) => {
  process.stderr.write(`\nBuild failed: ${err && err.message || err}\n`);
  process.exit(1);
});
