// CSP-enforced console smoke test.
//
// Loads each SPA route while injecting the EXACT Content-Security-Policy
// header that nginx will set in production (extracted from
// deploy/nginx/jarvis.whoisdhruv.com.conf). This catches CSP regressions
// that the dev server — which sets no CSP at all — would otherwise miss.
//
// Run: node scripts/smoke-console-csp.mjs http://127.0.0.1:3458
//
// Exits non-zero on any CSP violation, console error, or failed request.

import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://127.0.0.1:3458';
const ROUTES = ['/', '/carriers.html', '/negotiate.html', '/contact.html', '/map.html'];

// Keep this in lock-step with deploy/nginx/jarvis.whoisdhruv.com.conf.
// If you tweak the live CSP, mirror the change here and re-run the smoke.
const CSP =
  "default-src 'self'; " +
  "script-src 'self' https://static.cloudflareinsights.com; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: https://tile.openstreetmap.org https://*.tile.openstreetmap.org https://*.basemaps.cartocdn.com; " +
  "font-src 'self'; " +
  "connect-src 'self' wss: https://cloudflareinsights.com; " +
  "media-src 'self'; " +
  "worker-src 'self' blob:; " +
  "base-uri 'self'; " +
  "form-action 'self'; " +
  "frame-ancestors 'self'";

// Same accept-list as the unrestricted smoke — see scripts/smoke-console.mjs.
const ACCEPT_PATTERNS = [
  /api\/ws-nonce/i,
  /api\/live/i,
  /transformers/i,
  /Failed to load resource: the server responded with a status of 401/i,
  /Failed to load resource: the server responded with a status of 403/i,
  /Failed to load resource: net::ERR_FAILED.*\/api\/live/i,
  /Mic permission/i,
  /AudioContext/i
];

function isAccepted(text) { return ACCEPT_PATTERNS.some((re) => re.test(text)); }

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();

// Strip the existing (none) CSP and inject our production header on every
// HTML response. We touch ONLY the document — leaving CSS/JS/font response
// headers untouched, which mirrors how nginx applies `add_header` (it
// applies to every 2xx response, but the policy is set by the document
// loader's first navigation header).
await context.route('**/*', async (route) => {
  const req = route.request();
  // Pass-through fetch + augment headers on the way back. Only HTML
  // responses inherit the CSP — that's how browsers latch the policy.
  const res = await context.request.fetch(req);
  const headers = { ...res.headers() };
  const ct = headers['content-type'] || '';
  if (req.resourceType() === 'document' || /text\/html/i.test(ct)) {
    headers['content-security-policy'] = CSP;
  }
  await route.fulfill({
    status: res.status(),
    headers,
    body: await res.body()
  });
});

const all = { errors: [], cspViolations: [], failedRequests: [] };
const page = await context.newPage();

page.on('console', (msg) => {
  if (msg.type() !== 'error') return;
  const text = msg.text();
  if (isAccepted(text)) return;
  all.errors.push({ route: page._lastRoute, text });
});

page.on('pageerror', (err) => {
  if (!isAccepted(err.message)) {
    all.errors.push({ route: page._lastRoute, text: 'pageerror: ' + err.message });
  }
});

page.on('requestfailed', (req) => {
  const url = req.url();
  const failure = req.failure();
  if (!failure) return;
  const text = `${req.method()} ${url} :: ${failure.errorText}`;
  if (isAccepted(url) || isAccepted(text)) return;
  all.failedRequests.push({ route: page._lastRoute, text });
});

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
    await page.goto(BASE + route, { waitUntil: 'networkidle', timeout: 20000 });
    await page.waitForTimeout(1500);
    process.stdout.write('ok\n');
  } catch (err) {
    process.stdout.write(`load failed: ${err.message}\n`);
    all.errors.push({ route, text: 'navigation failed: ' + err.message });
  }
}

await browser.close();

const sectionsOrder = [
  ['CSP violations', all.cspViolations],
  ['Console errors', all.errors],
  ['Failed requests', all.failedRequests]
];

for (const [label, list] of sectionsOrder) {
  process.stdout.write(`\n## ${label}: ${list.length}\n`);
  for (const item of list) {
    process.stdout.write(`  [${item.route || '?'}] ${JSON.stringify(item)}\n`);
  }
}

const fail =
  all.errors.length > 0 ||
  all.cspViolations.length > 0 ||
  all.failedRequests.length > 0;

if (fail) {
  process.stdout.write('\nFAIL\n');
  process.exit(1);
} else {
  process.stdout.write('\nPASS — production CSP allows every resource the page loads.\n');
  process.exit(0);
}
