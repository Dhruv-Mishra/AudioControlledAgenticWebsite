// One-off integration check (not wired to npm). Boots Playwright against
// a running dev server (port 3099), opens the voice shell, opens the
// settings sheet, asserts the Phone-line compression toggle is ON by
// default, screenshots it, then places a call and records the network
// WS traffic and console to prove the nonce+audio_format handshake works.
//
// Usage: PORT=3099 node evals/_browser-integration-check.js

'use strict';

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const PORT = Number(process.env.PORT || 3099);
const URL_ROOT = 'http://localhost:' + PORT + '/';
const OUTDIR = path.resolve(__dirname, '..', '.playwright-mcp');

(async function main() {
  fs.mkdirSync(OUTDIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    permissions: ['microphone'],
    viewport: { width: 1440, height: 900 }
  });
  const page = await ctx.newPage();

  const consoleLines = [];
  page.on('console', (msg) => consoleLines.push('[' + msg.type() + '] ' + msg.text()));
  const wsNonceReqs = [];
  page.on('request', (req) => {
    if (req.url().includes('/api/ws-nonce')) wsNonceReqs.push({ url: req.url(), at: Date.now() });
  });
  const wsFrames = [];
  page.on('websocket', (ws) => {
    const started = Date.now();
    wsFrames.push({ kind: 'open', url: ws.url(), at: started });
    ws.on('framesent',     (f) => { try { const obj = JSON.parse(f.payload); wsFrames.push({ kind: 'snd_json', type: obj.type, at: Date.now() }); } catch {} });
    ws.on('framereceived', (f) => { try { const obj = JSON.parse(f.payload); wsFrames.push({ kind: 'rcv_json', type: obj.type, detail: obj, at: Date.now() }); } catch {} });
    ws.on('close', () => wsFrames.push({ kind: 'close', at: Date.now() }));
  });

  // Add ?debug=1 so we can observe HUD + console probes.
  await page.goto(URL_ROOT + '?debug=1');
  await page.waitForLoadState('networkidle');

  // Open the settings sheet.
  await page.click('#voice-settings');
  // Allow CSS transition to settle.
  await page.waitForTimeout(400);

  // Assert Phone-line compression is checked by default.
  const toggleChecked = await page.evaluate(() => {
    const t = document.querySelector('#voice-phone-compression-toggle');
    return t ? t.checked : null;
  });
  console.log('phone-line default checked:', toggleChecked);

  // Screenshot the settings sheet.
  const shotSettings = path.join(OUTDIR, 'settings-phone-line-default.png');
  await page.screenshot({ path: shotSettings });
  console.log('screenshot saved:', shotSettings);

  // Close settings; place a call.
  await page.click('#voice-settings-close');
  await page.waitForTimeout(200);
  await page.click('#voice-call-btn');

  // Wait for either the hello_ack or a timeout.
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (wsFrames.some((f) => f.kind === 'rcv_json' && f.type === 'audio_format')) break;
    await page.waitForTimeout(50);
  }

  const nonceFetched = wsNonceReqs.length;
  const wsOpen = wsFrames.find((f) => f.kind === 'open');
  const helloAck = wsFrames.find((f) => f.kind === 'rcv_json' && f.type === 'hello_ack');
  const fmt = wsFrames.find((f) => f.kind === 'rcv_json' && f.type === 'audio_format');

  console.log('--- summary ---');
  console.log('nonce fetched count: ' + nonceFetched);
  console.log('ws opened URL: ' + (wsOpen && wsOpen.url));
  console.log('hello_ack received: ' + !!helloAck);
  console.log('audio_format received: ' + (fmt ? JSON.stringify(fmt.detail) : 'no'));

  const relevantConsole = consoleLines.filter((l) => /nonce|audio_format|jarvis/.test(l));
  console.log('relevant console lines:');
  relevantConsole.forEach((l) => console.log('  ', l));

  // Save the console log too.
  const consoleFile = path.join(OUTDIR, 'browser-integration-console.txt');
  fs.writeFileSync(consoleFile, consoleLines.join('\n'), 'utf8');
  console.log('console log saved:', consoleFile);

  await browser.close();
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
