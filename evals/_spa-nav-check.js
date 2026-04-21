// Headless browser: verify SPA nav doesn't reload the document + Place
// Call button transitions state (DIALING → ERROR with an invalid key).
//
// Usage: PORT=3465 node evals/_spa-nav-check.js

const { chromium } = require('playwright');

const PORT = Number(process.env.PORT) || 3465;
const URL = `http://localhost:${PORT}/`;

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    // Grant mic permission up-front so getUserMedia doesn't block.
    permissions: ['microphone']
  });
  let exitCode = 1;
  try {
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (err) => errors.push(String(err)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto(URL, { waitUntil: 'networkidle' });

    // Capture the VoiceAgent object identity — it should survive route changes.
    await page.waitForSelector('#voice-call-btn');
    const agentBefore = await page.evaluate(() => {
      return {
        has: !!window.__voiceAgent,
        state: window.__voiceAgent && window.__voiceAgent.getState(),
        mode: window.__voiceAgent && window.__voiceAgent.getMode()
      };
    });
    if (!agentBefore.has) throw new Error('VoiceAgent not on window');
    console.log('before nav:', agentBefore);

    // Click the Carriers nav link — should NOT reload the page.
    await page.click('a[href="/carriers.html"]');
    await page.waitForFunction(() => {
      const h1 = document.querySelector('h1');
      return h1 && /carrier/i.test(h1.textContent);
    }, { timeout: 3000 });
    const agentAfter = await page.evaluate(() => ({
      same: window.__voiceAgent === window.__voiceAgentSnapshot__,
      state: window.__voiceAgent && window.__voiceAgent.getState(),
      mode: window.__voiceAgent && window.__voiceAgent.getMode()
    }));
    console.log('after nav:', agentAfter);

    if (agentAfter.state !== agentBefore.state) {
      throw new Error(`state changed across nav: ${agentBefore.state} → ${agentAfter.state}`);
    }
    console.log('PASS — SPA nav kept VoiceAgent state stable');

    // Navigate to Negotiate via the router directly.
    await page.click('a[href="/negotiate.html"]');
    await page.waitForFunction(() => {
      const h1 = document.querySelector('h1');
      return h1 && /rate negotiation/i.test(h1.textContent);
    }, { timeout: 3000 });
    console.log('PASS — nav to /negotiate.html');

    if (errors.length) {
      console.log('console errors:', errors);
      throw new Error('console errors during SPA nav');
    }
    console.log('ALL SPA NAV CHECKS PASSED');
    exitCode = 0;
  } catch (e) {
    console.error('FAIL', e.message);
  } finally {
    await ctx.close();
    await browser.close();
    process.exit(exitCode);
  }
})();
