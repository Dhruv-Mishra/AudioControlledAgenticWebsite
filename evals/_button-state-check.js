// Headless verify the Place/Cancel/End button state transitions.
// We stub getUserMedia with a dummy MediaStream so the call progresses
// past mic acquisition even in a headless env.
const { chromium } = require('playwright');
const PORT = Number(process.env.PORT) || 3464;
const URL = `http://localhost:${PORT}/`;

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    permissions: ['microphone']
  });
  const page = await ctx.newPage();

  // Stub getUserMedia: return a silent AudioContext-produced stream.
  await page.addInitScript(() => {
    const orig = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async () => {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const dst = ctx.createMediaStreamDestination();
      osc.connect(dst); osc.start();
      return dst.stream;
    };
  });

  let exitCode = 1;
  try {
    await page.goto(URL, { waitUntil: 'networkidle' });
    await page.waitForSelector('#voice-call-btn');

    const initialLabel = await page.$eval('#voice-call-btn-label', el => el.textContent.trim());
    if (!/Place Call/i.test(initialLabel)) throw new Error('initial label wrong: ' + initialLabel);
    console.log('PASS initial: Place Call');

    // Click to place call. Without valid key, it'll error out after ~15s
    // (dial watchdog) — but we only care about the state transitions
    // along the way.
    await page.click('#voice-call-btn');

    // Wait up to 2s for state to become DIALING or LIVE_OPENING.
    await page.waitForFunction(() => {
      const s = window.__voiceAgent && window.__voiceAgent.getState();
      return s === 'dialing' || s === 'live_opening';
    }, { timeout: 2000 });
    const state2 = await page.evaluate(() => window.__voiceAgent.getState());
    const label2 = await page.$eval('#voice-call-btn-label', el => el.textContent.trim());
    if (label2 !== 'Cancel') throw new Error('expected Cancel, got ' + label2 + ' (state=' + state2 + ')');
    console.log(`PASS dialing: state=${state2} btn="${label2}"`);

    // Click Cancel.
    await page.click('#voice-call-btn');
    await page.waitForFunction(() => {
      const s = window.__voiceAgent && window.__voiceAgent.getState();
      return s === 'idle' || s === 'closing';
    }, { timeout: 2000 });
    // Wait for closing to finish → idle.
    await page.waitForFunction(() => window.__voiceAgent.getState() === 'idle', { timeout: 2000 });
    const label3 = await page.$eval('#voice-call-btn-label', el => el.textContent.trim());
    if (!/Place Call/i.test(label3)) throw new Error('after cancel, expected Place Call, got ' + label3);
    console.log(`PASS cancel → idle → Place Call`);

    console.log('ALL BUTTON-STATE CHECKS PASSED');
    exitCode = 0;
  } catch (e) {
    console.error('FAIL', e.message);
  } finally {
    await ctx.close();
    await browser.close();
    process.exit(exitCode);
  }
})();
