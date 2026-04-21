// Verify the ambient-noise invariant: on every state transition while
// the call is active, the AudioPipeline.setAmbientOn() call has
// target=ON (i.e. the gain envelope target is non-zero). We record
// each setAmbientOn call with a spy. When the state transitions
// between in-call states, the target MUST remain ON.
const { chromium } = require('playwright');
const PORT = Number(process.env.PORT) || 3466;

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    permissions: ['microphone']
  });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const a = new AudioContext();
      const osc = a.createOscillator();
      const dst = a.createMediaStreamDestination();
      osc.connect(dst); osc.start();
      return dst.stream;
    };
  });

  let exitCode = 1;
  try {
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
    await page.waitForSelector('#voice-call-btn');

    // Install a spy BEFORE placing the call. Every setAmbientOn call
    // (and its `on` arg) gets recorded.
    await page.evaluate(() => {
      const p = window.__voiceAgent.pipeline;
      window.__ambientCalls = [];
      const orig = p.setAmbientOn.bind(p);
      p.setAmbientOn = function(on, opts) {
        window.__ambientCalls.push({ on: !!on, opts: opts || {}, stateAtCall: window.__voiceAgent.getState() });
        return orig(on, opts);
      };
    });

    // We skip placeCall entirely here to avoid the 15s dial_timeout with
    // an invalid key. The state machine can be driven directly — we're
    // testing _setState → _updateAmbient → setAmbientOn, which doesn't
    // depend on the WS handshake.
    await page.evaluate(() => { window.__ambientCalls = []; });

    // Drive a representative in-call state sequence.
    const states = ['dialing', 'live_opening', 'live_ready', 'model_thinking', 'model_speaking', 'tool_executing', 'reconnecting', 'live_ready'];
    for (const s of states) {
      await page.evaluate((st) => window.__voiceAgent._setState(st, 'test-' + Math.random()), s);
    }
    // Finally transition to idle.
    await page.evaluate(() => window.__voiceAgent._setState('idle'));

    const calls = await page.evaluate(() => window.__ambientCalls);
    let failed = 0;
    console.log(`${calls.length} setAmbientOn calls recorded:`);
    for (const c of calls) {
      console.log(`  on=${c.on} state=${c.stateAtCall}`);
    }

    // Every in-call state MUST have produced a setAmbientOn(true) call.
    const inCallStates = ['dialing', 'live_opening', 'live_ready', 'model_thinking', 'model_speaking', 'tool_executing', 'reconnecting'];
    for (const s of inCallStates) {
      const found = calls.find(c => c.stateAtCall === s && c.on === true);
      if (!found) {
        console.error(`FAIL no setAmbientOn(true) recorded for state ${s}`);
        failed++;
      }
    }
    // idle MUST have produced setAmbientOn(false).
    const idleOff = calls.find(c => c.stateAtCall === 'idle' && c.on === false);
    if (!idleOff) {
      console.error('FAIL no setAmbientOn(false) recorded for idle');
      failed++;
    }
    // And no in-call state should produce setAmbientOn(false).
    const badOff = calls.find(c => inCallStates.includes(c.stateAtCall) && c.on === false);
    if (badOff) {
      console.error(`FAIL setAmbientOn(false) during in-call state ${badOff.stateAtCall}`);
      failed++;
    }

    if (failed === 0) {
      console.log(`\nALL AMBIENT-CONTINUITY CHECKS PASSED`);
      exitCode = 0;
    } else {
      console.error(`\n${failed} failures`);
    }
  } catch (e) {
    console.error('FAIL', e.message);
  } finally {
    await ctx.close();
    await browser.close();
    process.exit(exitCode);
  }
})();
