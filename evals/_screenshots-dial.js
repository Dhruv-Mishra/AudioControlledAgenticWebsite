// Capture screenshot during DIALING state (after Place Call click).
const { chromium } = require('playwright');
const PORT = Number(process.env.PORT) || 3464;
const URL = `http://localhost:${PORT}/`;
(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 375, height: 812 },
    permissions: ['microphone']
  });
  const page = await ctx.newPage();
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('#voice-call-btn');
  // Click Place Call.
  await page.click('#voice-call-btn');
  // Wait briefly for state transition.
  await page.waitForTimeout(400);
  await page.screenshot({ path: '/tmp/hrfo-iphone-dialing.png' });
  console.log('iphone dialing captured');
  const state = await page.evaluate(() => window.__voiceAgent && window.__voiceAgent.getState());
  const label = await page.$eval('#voice-call-btn-label', el => el.textContent.trim());
  console.log('state=' + state + ' btnLabel=' + label);
  await ctx.close();
  await browser.close();
})();
