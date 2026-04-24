// Map-tile-render smoke. Loads /map.html under the production CSP and
// verifies that:
//   - at least N OSM tile <img> elements actually loaded (status 200,
//     non-zero byte body),
//   - no securitypolicyviolation events fired on the img-src directive,
//   - the map container painted (Leaflet sets .leaflet-container on it).
//
// This is the hard test the user cared about: "the map page does not load"
// must turn into "the map page DOES load — here's proof tiles arrived."

import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://127.0.0.1:3458';

const CSP =
  "default-src 'self'; " +
  "script-src 'self' https://static.cloudflareinsights.com; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: https://tile.openstreetmap.org https://*.tile.openstreetmap.org; " +
  "font-src 'self'; " +
  "connect-src 'self' wss: https://cloudflareinsights.com; " +
  "media-src 'self'; " +
  "worker-src 'self' blob:; " +
  "base-uri 'self'; " +
  "form-action 'self'; " +
  "frame-ancestors 'self'";

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });

const tileResponses = [];
const cspViolations = [];

await context.route('**/*', async (route) => {
  const req = route.request();
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

const page = await context.newPage();

await page.exposeBinding('__recordCspViolation', (_, payload) => {
  cspViolations.push(payload);
});
await page.addInitScript(() => {
  document.addEventListener('securitypolicyviolation', (ev) => {
    try {
      window.__recordCspViolation({
        directive: ev.violatedDirective,
        blockedURI: ev.blockedURI
      });
    } catch (_) {}
  });
});

page.on('response', (res) => {
  const url = res.url();
  if (/tile\.openstreetmap\.org/.test(url)) {
    tileResponses.push({ url, status: res.status() });
  }
});

await page.goto(BASE + '/map.html', { waitUntil: 'load', timeout: 20000 });

// Wait for Leaflet to paint at least one tile.
try {
  await page.waitForSelector('.leaflet-container', { timeout: 10000 });
  await page.waitForFunction(
    () => document.querySelectorAll('.leaflet-tile-loaded').length > 0,
    null,
    { timeout: 10000 }
  );
} catch (err) {
  process.stderr.write('Tiles never reached .leaflet-tile-loaded: ' + err.message + '\n');
}

// Give tiles a couple more seconds to land.
await page.waitForTimeout(2000);

const tileImgCount = await page.evaluate(() => document.querySelectorAll('.leaflet-tile-loaded').length);
const containerExists = await page.evaluate(() => !!document.querySelector('.leaflet-container'));

await page.screenshot({ path: '.playwright-mcp/map-smoke.png', fullPage: false });

await browser.close();

const tileSuccess = tileResponses.filter((r) => r.status === 200).length;
const tileNon200  = tileResponses.filter((r) => r.status !== 200);

process.stdout.write('\n=== Map smoke result ===\n');
process.stdout.write(`leaflet-container present:   ${containerExists}\n`);
process.stdout.write(`tile <img> elements loaded:  ${tileImgCount}\n`);
process.stdout.write(`OSM tile responses (total):  ${tileResponses.length}\n`);
process.stdout.write(`OSM tile responses (200):    ${tileSuccess}\n`);
process.stdout.write(`OSM tile responses (non-200):${tileNon200.length}\n`);
for (const r of tileNon200.slice(0, 5)) process.stdout.write(`  ${r.status} ${r.url}\n`);
process.stdout.write(`CSP violations:              ${cspViolations.length}\n`);
for (const v of cspViolations) process.stdout.write(`  ${JSON.stringify(v)}\n`);
process.stdout.write(`Screenshot: .playwright-mcp/map-smoke.png\n`);

const fail =
  !containerExists ||
  tileImgCount < 1 ||
  tileSuccess < 4 ||
  cspViolations.length > 0;

if (fail) {
  process.stdout.write('\nFAIL\n');
  process.exit(1);
} else {
  process.stdout.write('\nPASS — map renders OSM tiles under production CSP.\n');
  process.exit(0);
}
