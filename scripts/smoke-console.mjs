// Console-error smoke test.
//
// Loads each SPA route in headless Chromium, waits for the JS to settle,
// then walks back the page console + network log to flag:
//   - any console-level "error"
//   - any failed network request (4xx / 5xx)
//   - any CSP violation event (recorded as `securitypolicyviolation`)
//
// Run with: node scripts/smoke-console.mjs http://127.0.0.1:3458
//
// One-shot — exits 0 if every route is clean, non-zero otherwise.

import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://127.0.0.1:3458';
const ROUTES = ['/', '/carriers.html', '/negotiate.html', '/contact.html', '/map.html'];

// Errors we accept as benign for this smoke. The voice agent + STT modules
// will fail to fetch transformers.js shards and the WS endpoint will refuse
// without a valid Origin nonce — those failures aren't what we're hunting
// here. We're looking for CSP violations, missing assets, and any other
// load-time error a real user would see on first paint.
const ACCEPT_PATTERNS = [
  /api\/ws-nonce/i,         // dev-mode nonce path may not exist yet
  /api\/live/i,             // WS endpoint refuses without an active call
  /transformers/i,          // transformers.js shard prefetch (off-path)
  /Failed to load resource: the server responded with a status of 401/i, // ws nonce path
  /Failed to load resource: the server responded with a status of 403/i, // ws upgrade
  /Failed to load resource: net::ERR_FAILED.*\/api\/live/i,
  /Mic permission/i,
  /AudioContext/i
];

function isAccepted(text) {
  return ACCEPT_PATTERNS.some((re) => re.test(text));
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const all = { errors: [], warnings: [], cspViolations: [], failedRequests: [] };

const page = await context.newPage();

page.on('console', (msg) => {
  const type = msg.type();
  const text = msg.text();
  if (type === 'error') {
    if (!isAccepted(text)) all.errors.push({ route: page._lastRoute, text });
  } else if (type === 'warning') {
    all.warnings.push({ route: page._lastRoute, text });
  }
});

page.on('pageerror', (err) => {
  if (!isAccepted(err.message)) all.errors.push({ route: page._lastRoute, text: 'pageerror: ' + err.message });
});

page.on('requestfailed', (req) => {
  const url = req.url();
  const failure = req.failure();
  if (!failure) return;
  const text = `${req.method()} ${url} :: ${failure.errorText}`;
  if (isAccepted(url) || isAccepted(text)) return;
  all.failedRequests.push({ route: page._lastRoute, text });
});

page.on('response', (res) => {
  const status = res.status();
  if (status < 400) return;
  const url = res.url();
  if (isAccepted(url)) return;
  all.failedRequests.push({ route: page._lastRoute, text: `HTTP ${status} ${res.request().method()} ${url}` });
});

// Capture CSP violations the same way DevTools does — listen for the DOM
// `securitypolicyviolation` event and proxy it back to the test runner.
await page.exposeBinding('__recordCspViolation', (_, payload) => {
  all.cspViolations.push({ route: page._lastRoute, ...payload });
});
await page.addInitScript(() => {
  document.addEventListener('securitypolicyviolation', (ev) => {
    try {
      window.__recordCspViolation({
        directive: ev.violatedDirective,
        blockedURI: ev.blockedURI,
        sourceFile: ev.sourceFile,
        lineNumber: ev.lineNumber,
        sample: ev.sample
      });
    } catch (_) {}
  });
});

for (const route of ROUTES) {
  page._lastRoute = route;
  process.stdout.write(`-> ${route} ... `);
  try {
    const url = BASE + route;
    await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
    // Give lazy-loaded modules (theme, palette, captions, map, etc.) a beat
    // to import + run their init().
    await page.waitForTimeout(1500);
    process.stdout.write('ok\n');
  } catch (err) {
    process.stdout.write(`load failed: ${err.message}\n`);
    all.errors.push({ route, text: 'navigation failed: ' + err.message });
  }
}

await browser.close();

// Report
const fail =
  all.errors.length > 0 ||
  all.cspViolations.length > 0 ||
  all.failedRequests.length > 0;

const sectionsOrder = [
  ['CSP violations', all.cspViolations],
  ['Console errors', all.errors],
  ['Failed requests', all.failedRequests],
  ['Console warnings', all.warnings]
];

for (const [label, list] of sectionsOrder) {
  process.stdout.write(`\n## ${label}: ${list.length}\n`);
  for (const item of list) {
    process.stdout.write(`  [${item.route || '?'}] ${JSON.stringify(item)}\n`);
  }
}

if (fail) {
  process.stdout.write('\nFAIL\n');
  process.exit(1);
} else {
  process.stdout.write('\nPASS\n');
  process.exit(0);
}
