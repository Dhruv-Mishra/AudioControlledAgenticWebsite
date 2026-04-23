// Round-7 browser reproduction v2 — uses exposeBinding to bypass
// Playwright console-capture quirks. Every event from the page is
// pushed directly to Node via `window.__reproPush(kind, detail)`.
//
// Also adds instrumentation INSIDE the project source: we inject a
// script that hooks key methods on the AudioPipeline / VoiceAgent
// instances once they're constructed, so we can see exactly what the
// project code sees (not just the native events).
'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const URL = process.env.REPRO_URL || 'http://localhost:3001/';
const N_RUNS = Number(process.env.REPRO_RUNS || 5);
const WAIT_MS = 22000;
const OUTDIR = path.resolve(__dirname, '..', '.playwright-mcp');
fs.mkdirSync(OUTDIR, { recursive: true });

function stamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }

async function runOnce(runIdx) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required'
    ]
  });
  const ctx = await browser.newContext({ permissions: ['microphone'] });
  const page = await ctx.newPage();

  const events = [];
  const t0 = Date.now();
  await page.exposeBinding('__reproPush', (_src, kind, detail) => {
    events.push({ t: Date.now() - t0, kind, detail });
  });

  page.on('pageerror', (err) => events.push({ t: Date.now() - t0, kind: 'pageerror', detail: String(err && err.message) }));
  page.on('crash', () => events.push({ t: Date.now() - t0, kind: 'crash' }));

  await page.addInitScript(() => {
    const push = (kind, detail) => {
      try { window.__reproPush(kind, detail); } catch (_) {}
    };

    // 1. Native console passthrough — some Playwright builds drop
    //    console events; route every console.log/warn/error through
    //    our binding.
    ['log','warn','error','info','debug'].forEach((lvl) => {
      const orig = console[lvl].bind(console);
      console[lvl] = function wrapped() {
        try {
          const text = Array.from(arguments).map((a) => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
          push('console.' + lvl, text.slice(0, 300));
        } catch (_) {}
        return orig.apply(console, arguments);
      };
    });

    // 2. HTMLMediaElement prototype hooks.
    const origPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function reproPlay() {
      push('media.play.call', (this.src || '').split('/').pop());
      const ret = origPlay.apply(this, arguments);
      if (ret && typeof ret.then === 'function') {
        ret.then(() => push('media.play.resolved', (this.src || '').split('/').pop()))
           .catch((e) => push('media.play.rejected', { src: (this.src || '').split('/').pop(), msg: String(e && e.message) }));
      }
      return ret;
    };
    const origPause = HTMLMediaElement.prototype.pause;
    HTMLMediaElement.prototype.pause = function reproPause() {
      push('media.pause.call', (this.src || '').split('/').pop());
      return origPause.apply(this, arguments);
    };

    // 3. Hook addEventListener so we see EVERY event the project
    //    actually subscribes to — and WHICH events fire on which
    //    element. This is the smoking gun: if 'ended' never fires we
    //    see the listener registered but no dispatch.
    const origAEL = HTMLMediaElement.prototype.addEventListener;
    HTMLMediaElement.prototype.addEventListener = function reproAEL(evName, handler, opts) {
      push('media.listener.attach', { src: (this.src || '').split('/').pop(), ev: evName });
      const wrapped = function(e) {
        push('media.event', { src: (e.target && e.target.src || '').split('/').pop(), ev: evName, ct: e.target && Math.round((e.target.currentTime || 0) * 1000) / 1000, dur: e.target && e.target.duration });
        return handler.apply(this, arguments);
      };
      return origAEL.call(this, evName, wrapped, opts);
    };

    // 4. Active-polling probe on every <audio>-like element: every
    //    200 ms, read .currentTime / .paused / .ended so we KNOW what
    //    state the element is in, not just what events it dispatched.
    const probedEls = new WeakSet();
    function probe(el, tag) {
      if (probedEls.has(el)) return;
      probedEls.add(el);
      const src = (el.src || '').split('/').pop();
      const iv = setInterval(() => {
        if (!document || !el) return;
        push('media.probe', { src, tag, paused: el.paused, ended: el.ended, t: Math.round((el.currentTime || 0) * 100) / 100, dur: Math.round((el.duration || 0) * 100) / 100 });
        if (el.ended) clearInterval(iv);
      }, 500);
    }
    // Probe all existing + new audio elements via periodic sweep.
    setInterval(() => {
      document.querySelectorAll('audio').forEach((el) => probe(el, 'dom'));
    }, 400);

    // 5. Capture every `new Audio()` construction.
    const OrigAudio = window.Audio;
    window.Audio = function reproAudio() {
      const inst = new OrigAudio(...arguments);
      push('new.Audio', { args: Array.from(arguments).map((a) => typeof a).join(',') });
      setTimeout(() => probe(inst, 'new'), 0);
      return inst;
    };
    window.Audio.prototype = OrigAudio.prototype;

    // 6. WebSocket wire-log.
    const OrigWS = window.WebSocket;
    function reproWS(url, protocols) {
      const ws = new OrigWS(url, protocols);
      push('ws.new', String(url));
      const origSend = ws.send.bind(ws);
      ws.send = function reproSend(data) {
        let summary;
        if (typeof data === 'string') {
          try { summary = { type: JSON.parse(data).type, len: data.length }; }
          catch { summary = { raw: data.slice(0, 60) }; }
        } else {
          summary = { binary: data.byteLength || data.length };
        }
        push('ws.send', summary);
        return origSend(data);
      };
      ws.addEventListener('open', () => push('ws.open', String(url)));
      ws.addEventListener('close', (e) => push('ws.close', { code: e.code, reason: String(e.reason || '') }));
      ws.addEventListener('message', (e) => {
        if (typeof e.data === 'string') {
          try { push('ws.recv.json', { type: JSON.parse(e.data).type }); }
          catch { push('ws.recv.raw', e.data.slice(0, 60)); }
        } else {
          push('ws.recv.binary', { bytes: e.data.byteLength });
        }
      });
      return ws;
    }
    reproWS.prototype = OrigWS.prototype;
    for (const k of ['CONNECTING','OPEN','CLOSING','CLOSED']) reproWS[k] = OrigWS[k];
    window.WebSocket = reproWS;
  });

  events.push({ t: Date.now() - t0, kind: 'goto.start', detail: URL });
  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  const btn = await page.waitForSelector('#voice-call-btn', { timeout: 8000 });
  events.push({ t: Date.now() - t0, kind: 'btn.ready' });
  await btn.click();
  events.push({ t: Date.now() - t0, kind: 'btn.clicked' });

  await new Promise((r) => setTimeout(r, WAIT_MS));

  await browser.close();

  const fname = path.join(OUTDIR, 'r7v2-run-' + runIdx + '-' + stamp() + '.json');
  fs.writeFileSync(fname, JSON.stringify(events, null, 2));

  // Metrics: find first callOpen play.call and callOpen "ended" event
  // (either via addEventListener 'ended' OR via probe showing el.ended=true).
  const firstCallOpenPlay = events.find((e) => e.kind === 'media.play.call' && e.detail && /callOpen/.test(e.detail));
  const callOpenEnded = events.find((e) => e.kind === 'media.event' && e.detail && /callOpen/.test(e.detail.src) && e.detail.ev === 'ended');
  const callOpenEndedByProbe = events.find((e) => e.kind === 'media.probe' && e.detail && /callOpen/.test(e.detail.src) && e.detail.ended === true);
  const backgroundFirstPlay = events.find((e) => e.kind === 'media.play.call' && e.detail && /background/.test(e.detail));
  // But the FIRST background play is the unlock-dance one. Look for the REAL one:
  // the second `media.play.call` on background.
  const backgroundPlays = events.filter((e) => e.kind === 'media.play.call' && e.detail && /background/.test(e.detail));
  const backgroundRealPlay = backgroundPlays.length >= 2 ? backgroundPlays[1] : null;
  const preludeSent = events.find((e) => e.kind === 'ws.send' && e.detail && e.detail.type === 'audio_prelude_ended');
  const firstBin = events.find((e) => e.kind === 'ws.recv.binary');

  const summary = {
    run: runIdx,
    callOpenPlay_ms: firstCallOpenPlay ? firstCallOpenPlay.t : null,
    callOpenEndedEvent_ms: callOpenEnded ? callOpenEnded.t : null,
    callOpenEndedByProbe_ms: callOpenEndedByProbe ? callOpenEndedByProbe.t : null,
    background_dance_ms: backgroundPlays[0] ? backgroundPlays[0].t : null,
    background_real_ms: backgroundRealPlay ? backgroundRealPlay.t : null,
    audioPreludeSent_ms: preludeSent ? preludeSent.t : null,
    firstAgentBinary_ms: firstBin ? firstBin.t : null,
    dumpFile: fname
  };
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

  const f = path.join(OUTDIR, 'r7v2-summary-' + stamp() + '.json');
  fs.writeFileSync(f, JSON.stringify(results, null, 2));
  process.stdout.write('\n=== FINAL ===\n');
  for (const r of results) process.stdout.write(JSON.stringify(r) + '\n');
  process.stdout.write('summary: ' + f + '\n');
})();
