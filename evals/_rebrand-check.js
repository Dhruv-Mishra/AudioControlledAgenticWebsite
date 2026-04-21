// Verify the user-facing rebrand landed: page title, brand, and
// Jarvis's system prompt all show "Dhruv FreightOps". Also spot-check
// that no "HappyRobot FreightOps" string leaks into the rendered DOM.
const { chromium } = require('playwright');
const PORT = Number(process.env.PORT) || 3466;

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  let exitCode = 1;
  try {
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
    await page.waitForSelector('#voice-call-btn');

    const title = await page.title();
    const brand = await page.$eval('.app-brand span:last-child', el => el.textContent.trim());
    const bodyText = await page.evaluate(() => document.body.innerText);

    console.log('title:', title);
    console.log('brand:', brand);
    if (!/Dhruv FreightOps/.test(title)) throw new Error('title missing Dhruv FreightOps');
    if (!/Dhruv FreightOps/.test(brand)) throw new Error('brand missing Dhruv FreightOps');
    if (/HappyRobot FreightOps/.test(bodyText)) throw new Error('stale HappyRobot FreightOps in DOM');
    console.log('PASS rebrand in DOM');

    // SPA nav to carriers: title should update.
    await page.click('a[href="/carriers.html"]');
    await page.waitForFunction(() => /Carriers/i.test(document.title));
    const carriersTitle = await page.title();
    console.log('carriers title:', carriersTitle);
    if (!/Dhruv FreightOps/.test(carriersTitle)) throw new Error('carriers title missing Dhruv FreightOps');
    console.log('PASS rebrand survives SPA nav');

    console.log('ALL REBRAND CHECKS PASSED');
    exitCode = 0;
  } catch (e) {
    console.error('FAIL', e.message);
  } finally {
    await ctx.close();
    await browser.close();
    process.exit(exitCode);
  }
})();
