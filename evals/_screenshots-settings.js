// Capture screenshot with Settings panel open at iPhone + desktop.
const { chromium } = require('playwright');
const PORT = Number(process.env.PORT) || 3464;
const URL = `http://localhost:${PORT}/`;
const VPS = [{n:'iphone-settings', w:375, h:812}, {n:'desktop-settings', w:1280, h:800}];
(async () => {
  const browser = await chromium.launch({ headless: true });
  for (const vp of VPS) {
    const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h } });
    const page = await ctx.newPage();
    await page.goto(URL, { waitUntil: 'networkidle' });
    await page.waitForSelector('#voice-call-btn');
    await page.click('#voice-settings');
    await page.waitForSelector('#voice-settings-sheet.is-open');
    const out = `/tmp/hrfo-${vp.n}.png`;
    await page.screenshot({ path: out });
    console.log(`wrote ${out} (${vp.w}x${vp.h})`);
    await ctx.close();
  }
  await browser.close();
})();
