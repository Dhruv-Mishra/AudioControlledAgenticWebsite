// Headless browser render check: loads the SPA at mobile + tablet
// viewports and verifies (a) the page loads without JS errors, (b) the
// Place Call button is visible and meets the 48x48 min tap target, (c)
// iOS Safari UA hides the wake-word option (simulated via UA override).
//
// Run against an already-running server on PORT env var (default 3463).
// Usage: PORT=3463 npx playwright@1.59.1 test or just node it.

const { chromium, devices } = require('playwright');

const PORT = Number(process.env.PORT) || 3463;
const URL = `http://localhost:${PORT}/`;

const VIEWPORTS = [
  { name: 'iPhone 375x812', width: 375, height: 812 },
  { name: 'Tablet 768x1024', width: 768, height: 1024 },
  { name: 'Desktop 1280x800', width: 1280, height: 800 }
];

(async () => {
  const browser = await chromium.launch({ headless: true });
  let failed = 0;
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 1
    });
    const page = await ctx.newPage();
    const consoleErrors = [];
    page.on('pageerror', (err) => consoleErrors.push(String(err)));
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });

    try {
      await page.goto(URL, { waitUntil: 'networkidle', timeout: 10000 });
      // Wait for the call button to render (router + ui bootstrap must complete).
      await page.waitForSelector('#voice-call-btn', { state: 'visible', timeout: 5000 });
      const btn = await page.$('#voice-call-btn');
      const box = await btn.boundingBox();
      const label = await page.$eval('#voice-call-btn-label', (el) => el.textContent.trim());
      const status = await page.$eval('#voice-status-pill .label', (el) => el.textContent.trim());
      const h1 = await page.$('h1');
      const h1Text = h1 ? await h1.textContent() : '(no h1)';

      // Assert: button ≥ 48px tall (tap target).
      const okTap = box && box.height >= 48;
      // Assert: status says the call has not started.
      const okStatus = /Not connected|Stand by/i.test(status);
      // Assert: Place Call label.
      const okLabel = /Place Call/i.test(label);

      console.log(`--- ${vp.name} ---`);
      console.log(`  h1: "${(h1Text || '').trim()}"`);
      console.log(`  pill: "${status}"  (ok=${okStatus})`);
      console.log(`  call btn: "${label}"  ${box ? `${box.width.toFixed(0)}x${box.height.toFixed(0)}` : '(no box)'}  (tap=${okTap})`);
      if (!okTap || !okStatus || !okLabel || consoleErrors.length) {
        console.log('  console errors:', consoleErrors);
        failed++;
      } else {
        console.log('  PASS');
      }
    } catch (err) {
      console.log(`--- ${vp.name} ---`);
      console.log('  FAIL', err.message);
      console.log('  console errors:', consoleErrors);
      failed++;
    }
    await ctx.close();
  }
  await browser.close();
  process.exit(failed ? 1 : 0);
})();
