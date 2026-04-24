// Verify Geist + Geist Mono actually loaded (not the system fallback) by
// checking document.fonts.check() and computed font-family on rendered
// text. Runs under the production CSP so it also exercises the woff2
// fetch path.

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
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });

const fontFetches = [];
await context.route('**/*', async (route) => {
  const req = route.request();
  const res = await context.request.fetch(req);
  const headers = { ...res.headers() };
  if (req.resourceType() === 'document' || /text\/html/i.test(headers['content-type'] || '')) {
    headers['content-security-policy'] = CSP;
  }
  if (/\/public\/fonts\//.test(req.url())) {
    fontFetches.push({ url: req.url(), status: res.status() });
  }
  await route.fulfill({ status: res.status(), headers, body: await res.body() });
});

const page = await context.newPage();
await page.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 15000 });
await page.waitForTimeout(800);

const fontStatus = await page.evaluate(async () => {
  // Force the fonts to load by typing text in both families and waiting on
  // document.fonts.ready. Then ask the FontFaceSet which @font-face rules
  // resolved.
  await document.fonts.ready;
  const have = (family, weight) => document.fonts.check(`${weight} 16px "${family}"`);
  const families = [];
  for (const ff of document.fonts.values()) {
    families.push({ family: ff.family, weight: ff.weight, status: ff.status });
  }
  return {
    geist400: have('Geist', '400'),
    geist500: have('Geist', '500'),
    geist700: have('Geist', '700'),
    geistMono400: have('Geist Mono', '400'),
    geistMono500: have('Geist Mono', '500'),
    families
  };
});

await browser.close();

process.stdout.write('=== Font load result ===\n');
process.stdout.write(`Geist 400 loaded:        ${fontStatus.geist400}\n`);
process.stdout.write(`Geist 500 loaded:        ${fontStatus.geist500}\n`);
process.stdout.write(`Geist 700 loaded:        ${fontStatus.geist700}\n`);
process.stdout.write(`Geist Mono 400 loaded:   ${fontStatus.geistMono400}\n`);
process.stdout.write(`Geist Mono 500 loaded:   ${fontStatus.geistMono500}\n`);
process.stdout.write(`woff2 fetches:           ${fontFetches.length}\n`);
for (const f of fontFetches) process.stdout.write(`  ${f.status} ${f.url}\n`);
process.stdout.write('Registered FontFaces in the document:\n');
for (const f of fontStatus.families) {
  process.stdout.write(`  ${f.family} weight=${f.weight} status=${f.status}\n`);
}

const ok =
  fontStatus.geist400 &&
  fontStatus.geist500 &&
  fontStatus.geist700 &&
  fontStatus.geistMono400 &&
  fontStatus.geistMono500;

if (!ok) { process.stdout.write('\nFAIL\n'); process.exit(1); }
process.stdout.write('\nPASS — every Geist + Geist Mono weight resolved via the self-hosted woff2 files.\n');
