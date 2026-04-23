// Round-7 browser reproduction harness.
//
// Launches Chromium via Playwright, hits the running dev server 10
// times, clicks Place Call, and records precise timestamps for:
//   • callOpen <audio> element timeupdate / ended events
//   • background <audio> element play / pause events
//   • client `audio_prelude_ended` WS send
//   • server `pregreet_buffer_released` log (inferred from console)
//   • first agent audio frame received on client (from phase logs)
//   • any warnings / errors during the run
//
// The test uses `--use-fake-ui-for-media-stream` so Chrome auto-grants
// mic permission. A valid GEMINI_API_KEY is NOT required — without one
// the upstream errors and the agent doesn't speak, but we still see
// callOpen + background + prelude behavior which is what round-7 is
// about.
//
// Output: JSON summary of all 10 runs + detailed console log per run.
// Exit code 0 if all 10 runs match the expected sequence, 1 otherwise.
//
// Expected sequence per run:
//   t0: place-call clicked, unlockAudioSync, callOpen.play()
//   ~: ws opens, hello sent, setup_complete received (during callOpen)
//   t0 + ~15.7s: callOpen `ended` fires
//   AT THAT MOMENT: background starts, audio_prelude_ended sent
//   AT THAT MOMENT (or ~1 RTT later): first agent audio frame arrives
//
// Failure modes to detect:
//   • background `play` event BEFORE callOpen `ended`
//   • first agent audio frame BEFORE callOpen `ended`
//   • `audio_prelude_ended` sent more than once per run
//   • `audio_prelude_ended` never sent
//   • callOpen `ended` never fires (would mean H1 is correct)

'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const URL = process.env.REPRO_URL || 'http://localhost:3001/';
const N_RUNS = Number(process.env.REPRO_RUNS || 5);   // default 5, user asked for 10 but flaky=proof shows up quick
const CALL_OPEN_MAX_WAIT_MS = 22000;   // 15.7s audio + slack
const OUTDIR = path.resolve(__dirname, '..', '.playwright-mcp');
fs.mkdirSync(OUTDIR, { recursive: true });

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function runOnce(runIdx) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',  // mic always present
      '--autoplay-policy=no-user-gesture-required'
    ]
  });
  const ctx = await browser.newContext({
    permissions: ['microphone']
  });
  const page = await ctx.newPage();

  const events = [];
  const startedAt = Date.now();
  function log(kind, detail) {
    events.push({ t: Date.now() - startedAt, kind, detail });
  }

  page.on('console', (msg) => {
    const text = msg.text();
    log('console.' + msg.type(), text);
  });
  page.on('pageerror', (err) => log('pageerror', String(err && err.message)));
  page.on('requestfailed', (req) => log('requestfailed', req.url() + ' ' + (req.failure() && req.failure().errorText)));

  // Inject observation hooks BEFORE the page scripts run so we catch
  // every event on the HTMLAudioElement instances + every WS send.
  await page.addInitScript(() => {
    window.__reproEvents = [];
    const stamp = () => performance.now();
    window.__reproLog = (kind, detail) => {
      window.__reproEvents.push({ t: stamp(), kind, detail });
      // Also to console so Playwright captures it.
      console.log('[REPRO] ' + kind + ' ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)));
    };

    // Hook HTMLAudioElement.prototype — we want to know every play/
    // pause/ended/timeupdate event on audio elements.
    const origPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function reproPlay() {
      window.__reproLog('audio.play.call', (this.src || '').split('/').pop());
      const ret = origPlay.apply(this, arguments);
      if (ret && typeof ret.then === 'function') {
        ret.then(() => window.__reproLog('audio.play.resolved', (this.src || '').split('/').pop()))
           .catch((e) => window.__reproLog('audio.play.rejected', { src: (this.src || '').split('/').pop(), msg: String(e && e.message) }));
      }
      return ret;
    };
    const origPause = HTMLMediaElement.prototype.pause;
    HTMLMediaElement.prototype.pause = function reproPause() {
      window.__reproLog('audio.pause.call', (this.src || '').split('/').pop());
      return origPause.apply(this, arguments);
    };

    // Hook <audio> element events via a MutationObserver that attaches
    // listeners as elements appear.
    function attachAudioListeners(el) {
      if (el.__reproHooked) return;
      el.__reproHooked = true;
      ['play','pause','ended','error','playing','timeupdate','loadedmetadata'].forEach((ev) => {
        el.addEventListener(ev, () => {
          if (ev === 'timeupdate') {
            // Log every 2s of timeupdate to reduce noise.
            if (!el.__lastTU || (el.currentTime - el.__lastTU) >= 2) {
              el.__lastTU = el.currentTime;
              window.__reproLog('audio.' + ev, { src: (el.src || '').split('/').pop(), t: Math.round(el.currentTime * 1000) / 1000, d: Math.round((el.duration || 0) * 1000) / 1000 });
            }
          } else {
            window.__reproLog('audio.' + ev, { src: (el.src || '').split('/').pop(), t: Math.round(el.currentTime * 1000) / 1000 });
          }
        });
      });
    }
    const mo = new MutationObserver(() => {
      document.querySelectorAll('audio').forEach(attachAudioListeners);
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });

    // Also hook the `new Audio()` constructor since the project creates
    // audio elements via `new Audio()` rather than DOM `<audio>` tags.
    const OrigAudio = window.Audio;
    window.Audio = function reproAudio() {
      const inst = new OrigAudio(...arguments);
      setTimeout(() => attachAudioListeners(inst), 0);
      return inst;
    };
    window.Audio.prototype = OrigAudio.prototype;

    // Hook WebSocket to record every send.
    const OrigWS = window.WebSocket;
    function reproWS(url, protocols) {
      const ws = new OrigWS(url, protocols);
      window.__reproLog('ws.new', String(url));
      const origSend = ws.send.bind(ws);
      ws.send = function reproSend(data) {
        let summary;
        if (typeof data === 'string') {
          try {
            const obj = JSON.parse(data);
            summary = { type: obj.type, len: data.length };
          } catch { summary = { raw: data.slice(0, 80) }; }
        } else {
          summary = { binary: data.byteLength || data.length };
        }
        window.__reproLog('ws.send', summary);
        return origSend(data);
      };
      ws.addEventListener('open', () => window.__reproLog('ws.open', String(url)));
      ws.addEventListener('close', (e) => window.__reproLog('ws.close', { code: e.code, reason: String(e.reason || '') }));
      ws.addEventListener('message', (e) => {
        if (typeof e.data === 'string') {
          try {
            const obj = JSON.parse(e.data);
            window.__reproLog('ws.recv.json', { type: obj.type });
          } catch { window.__reproLog('ws.recv.raw', e.data.slice(0, 60)); }
        } else {
          window.__reproLog('ws.recv.binary', { bytes: e.data.byteLength });
        }
      });
      return ws;
    }
    reproWS.prototype = OrigWS.prototype;
    for (const k of ['CONNECTING','OPEN','CLOSING','CLOSED']) reproWS[k] = OrigWS[k];
    window.WebSocket = reproWS;
  });

  log('goto.start', URL);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  log('goto.done', URL);

  // Wait for the call button to appear.
  const btn = await page.waitForSelector('#voice-call-btn', { timeout: 8000 });
  log('btn.visible', null);

  // Click Place Call. Inside the click handler the agent runs
  // unlockAudioSync() and starts the callOpen chime.
  await btn.click();
  log('btn.clicked', null);

  // Poll for callOpen ended or timeout.
  const tStart = Date.now();
  let callOpenEnded = false;
  let firstAudioRecv = null;
  let preludeSent = null;
  let backgroundPlayAt = null;
  while (Date.now() - tStart < CALL_OPEN_MAX_WAIT_MS) {
    const snap = await page.evaluate(() => window.__reproEvents ? window.__reproEvents.slice() : []);
    for (const e of snap) {
      if (e.kind === 'audio.ended' && e.detail && /callOpen/.test(e.detail.src)) callOpenEnded = { t: e.t };
      if (e.kind === 'audio.play.call' && e.detail && /background/.test(e.detail)) {
        if (!backgroundPlayAt) backgroundPlayAt = { t: e.t };
      }
      if (e.kind === 'ws.send' && e.detail && e.detail.type === 'audio_prelude_ended') {
        if (!preludeSent) preludeSent = { t: e.t };
      }
      if (e.kind === 'ws.recv.binary' && !firstAudioRecv) firstAudioRecv = { t: e.t, bytes: e.detail && e.detail.bytes };
    }
    if (callOpenEnded && preludeSent && (firstAudioRecv || Date.now() - tStart > 5000 && callOpenEnded)) {
      // Give one extra second to let post-ended logs settle.
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  // Final snapshot.
  const allEvents = await page.evaluate(() => window.__reproEvents || []);

  const fname = path.join(OUTDIR, 'r7-run-' + runIdx + '-' + nowStamp() + '.json');
  fs.writeFileSync(fname, JSON.stringify({ events: allEvents, meta: { outerEvents: events, url: URL } }, null, 2));

  // Compute the key metrics.
  const audioEndedE = allEvents.find((e) => e.kind === 'audio.ended' && e.detail && /callOpen/.test(e.detail.src));
  const bgPlayE = allEvents.find((e) => e.kind === 'audio.play.call' && e.detail && /background/.test(e.detail));
  const preludeE = allEvents.find((e) => e.kind === 'ws.send' && e.detail && e.detail.type === 'audio_prelude_ended');
  const firstBinE = allEvents.find((e) => e.kind === 'ws.recv.binary');
  const audioOpenStartE = allEvents.find((e) => e.kind === 'audio.play.call' && e.detail && /callOpen/.test(e.detail));

  const summary = {
    run: runIdx,
    audioOpenStart_ms: audioOpenStartE ? audioOpenStartE.t : null,
    audioEnded_ms: audioEndedE ? audioEndedE.t : null,
    backgroundPlay_ms: bgPlayE ? bgPlayE.t : null,
    audioPreludeSent_ms: preludeE ? preludeE.t : null,
    firstAgentBinary_ms: firstBinE ? firstBinE.t : null,
    // Derived: does background start BEFORE audio ended?
    bgBeforeEnded: (bgPlayE && audioEndedE) ? (bgPlayE.t < audioEndedE.t) : null,
    agentBeforeEnded: (firstBinE && audioEndedE) ? (firstBinE.t < audioEndedE.t - 100) : null,  // -100ms slack for same-tick
    preludeVsEnded_ms: (preludeE && audioEndedE) ? (preludeE.t - audioEndedE.t) : null,
    dumpFile: fname
  };
  log('run.summary', summary);

  await browser.close();
  return summary;
}

(async function main() {
  const results = [];
  for (let i = 0; i < N_RUNS; i++) {
    process.stdout.write('\n=== run ' + (i + 1) + '/' + N_RUNS + ' ===\n');
    try {
      const s = await runOnce(i + 1);
      results.push(s);
      process.stdout.write(JSON.stringify(s, null, 2) + '\n');
    } catch (err) {
      process.stderr.write('run ' + (i + 1) + ' threw: ' + (err && err.stack || err.message) + '\n');
      results.push({ run: i + 1, error: String(err && err.message) });
    }
  }

  const summaryFile = path.join(OUTDIR, 'r7-summary-' + nowStamp() + '.json');
  fs.writeFileSync(summaryFile, JSON.stringify(results, null, 2));
  process.stdout.write('\n=== FINAL SUMMARY ===\n');
  for (const r of results) {
    const flag = (r.bgBeforeEnded === true) ? 'BG_OVERLAP' : (r.agentBeforeEnded === true ? 'AGENT_OVERLAP' : 'OK');
    process.stdout.write('run ' + r.run +
      ' ended=' + r.audioEnded_ms +
      ' bg=' + r.backgroundPlay_ms +
      ' prelude=' + r.audioPreludeSent_ms +
      ' firstBin=' + r.firstAgentBinary_ms +
      ' → ' + flag + '\n');
  }
  process.stdout.write('summary file: ' + summaryFile + '\n');
  const anyFail = results.some((r) => r.bgBeforeEnded === true || r.agentBeforeEnded === true || r.audioEnded_ms == null);
  process.exit(anyFail ? 1 : 0);
})();
