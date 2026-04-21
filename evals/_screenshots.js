// Capture screenshots at mobile + tablet + desktop viewports. Used for
// manual visual verification only; not part of the smoke suite.
// Writes PNGs to /tmp/hrfo-<size>.png.
const { chromium } = require('playwright');
const PORT = Number(process.env.PORT) || 3464;
const URL = `http://localhost:${PORT}/`;
const VIEWPORTS = [
  { name: 'iphone', width: 375, height: 812 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 }
];
(async () => {
  const browser = await chromium.launch({ headless: true });
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const page = await ctx.newPage();
    await page.goto(URL, { waitUntil: 'networkidle' });
    await page.waitForSelector('#voice-call-btn');
    const out = `/tmp/hrfo-${vp.name}.png`;
    await page.screenshot({ path: out, fullPage: false });
    console.log(`wrote ${out} (${vp.width}x${vp.height})`);
    await ctx.close();
  }
  await browser.close();
})();
