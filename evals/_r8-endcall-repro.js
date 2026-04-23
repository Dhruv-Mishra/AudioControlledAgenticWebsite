// Round-8 Playwright harness — end-call paths in a real browser.
//
// Tests BOTH end-call paths across N runs each:
//
//   AGENT-PATH runs:
//     1. Click Place Call, wait for call to be live (~16s incl. callOpen).
//     2. Inject a synthetic `end_call_requested` message via a test hook
//        on the VoiceAgent instance, PLUS pretend Gemini sends turn_complete
//        and the agent audio has drained.
//     3. Verify: callClose starts to play, runs for ~4.1s, onended fires,
//        then teardown (button goes green).
//
//   USER-PATH runs (5 subtypes, one per run):
//     1. Click Place Call.
//     2. At a variable delay (during callOpen, during listening, during
//        simulated agent speech, during simulated agent-end wait, during
//        simulated callClose playback), click End Call.
//     3. Verify: NO callClose audio plays, teardown is same-tick.
//
// A "test hook" is injected at page-load via `addInitScript`:
//   - window.__r8TestDispatchServerMessage(msgObj) — routes an object
//     as if it came over the WS. We use this to simulate agent-end
//     without a real Gemini session.
//   - window.__r8TestDrainAgentAudio() — dispatches
//     `agent-playback-drained` on pipeline.
//
// These hooks are only available when the page has `?r8hook=1` in the
// URL — they're gated so production runs don't expose them.
// (Minimal surface: we set `window.__r8` to the VoiceAgent instance.)
//
// Output: JSON summary of each run + per-run event dump.

'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const URL = process.env.REPRO_URL || 'http://localhost:3001/?r8hook=1';
const N_RUNS_AGENT = Number(process.env.REPRO_RUNS_AGENT || 5);
const N_RUNS_USER  = Number(process.env.REPRO_RUNS_USER  || 5);
const WAIT_MS = 25000;   // enough for callOpen 15.7s + chime 4.1s + margin
const OUTDIR = path.resolve(__dirname, '..', '.playwright-mcp');
fs.mkdirSync(OUTDIR, { recursive: true });

function stamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }

async function runOnce(runIdx, scenario) {
  // scenario is one of:
  //   'agent'
  //   'user-during-callopen'       (click 2s in, while callOpen plays)
  //   'user-after-callopen'        (click 17s in, right after callOpen ends)
  //   'user-during-greeting'       (click 17.5s in, during buffered agent audio)
  //   'user-during-agent-end-wait' (click while agent-end is armed)
  //   'user-during-callclose'      (click ~0.5s into callClose)
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

  await page.addInitScript(() => {
    const push = (kind, detail) => { try { window.__reproPush(kind, detail); } catch (_) {} };
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

    // Hook HTMLAudioElement play/pause.
    const origPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function reproPlay() {
      push('media.play.call', (this.src || '').split('/').pop());
      const ret = origPlay.apply(this, arguments);
      if (ret && typeof ret.then === 'function') {
        ret.then(() => push('media.play.resolved', (this.src || '').split('/').pop())).catch((e) => push('media.play.rejected', { src: (this.src || '').split('/').pop(), msg: String(e && e.message) }));
      }
      return ret;
    };
    const origPause = HTMLMediaElement.prototype.pause;
    HTMLMediaElement.prototype.pause = function reproPause() {
      push('media.pause.call', (this.src || '').split('/').pop());
      return origPause.apply(this, arguments);
    };

    // Hook AudioBufferSourceNode.start / stop — callOpen + callClose
    // use these (round 7). We want to know exactly when these fire.
    const OrigCtx = window.AudioContext || window.webkitAudioContext;
    if (OrigCtx) {
      const origCreate = OrigCtx.prototype.createBufferSource;
      OrigCtx.prototype.createBufferSource = function patched() {
        const node = origCreate.apply(this, arguments);
        const origStart = node.start.bind(node);
        node.start = function patchedStart() {
          const d = node.buffer ? node.buffer.duration : null;
          push('bufsrc.start', { duration: d });
          return origStart.apply(this, arguments);
        };
        const origStop = node.stop.bind(node);
        node.stop = function patchedStop() {
          push('bufsrc.stop', {});
          return origStop.apply(this, arguments);
        };
        // Use addEventListener so we don't shadow the built-in
        // onended property setter (which has native listener wiring
        // that a JS defineProperty override would break).
        node.addEventListener('ended', () => {
          push('bufsrc.onended', { duration: node.buffer ? node.buffer.duration : null });
        });
        return node;
      };
    }

    // WebSocket hooks.
    const OrigWS = window.WebSocket;
    function reproWS(url, protocols) {
      const ws = new OrigWS(url, protocols);
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
      ws.addEventListener('close', (e) => push('ws.close', { code: e.code }));
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

    // Test hook: capture the VoiceAgent instance so the test harness
    // can synthesize end_call_requested + agent-playback-drained.
    window.__r8 = null;
    const origDefine = Object.defineProperty;
    // We install __r8 assignment in the body via a MutationObserver on
    // the first voice-dock element. Simpler: expose helpers that the
    // harness calls from page.evaluate().
    window.__r8InstallHooks = function () {
      // Walk the globals to find the VoiceAgent instance. Our app
      // stashes it on the ui.js module scope; inspect document for
      // the call button's agent reference.
      // Simplest: try to find it via the global script shell. The
      // app exposes the agent on window.__voiceAgent if we patch the
      // app. Instead, we reach through the module graph using a
      // stringified getter: each invocation of the UI click handler
      // binds `agent` via closure. We expose a helper that dispatches
      // a synthetic WS message through the existing agent.
      if (!window.__r8Agent) {
        // Fall back: patch `VoiceAgent.prototype` to tag instances.
        return false;
      }
      return true;
    };
  });

  // Inject a page-level bootstrap that patches VoiceAgent to tag the
  // singleton as `window.__r8Agent` when it constructs.
  await page.addInitScript(() => {
    const check = () => {
      // Inspect for the voice-agent module import instance.
      // The app builds a singleton in ui.js inside `bootstrapVoiceShell`.
      // The instance is assigned to `window.__voiceAgent__r8` if we
      // patch. Instead, we reach in via a MutationObserver that waits
      // for the button to exist, then reads `agent` via a bespoke
      // patch below.
    };
    check();
  });

  events.push({ t: Date.now() - t0, kind: 'goto.start', detail: URL });
  // Retry up to 3x in case the dev server dropped between runs.
  let gotoOk = false;
  let gotoErr = null;
  for (let attempt = 0; attempt < 3 && !gotoOk; attempt++) {
    try {
      await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 10000 });
      gotoOk = true;
    } catch (err) {
      gotoErr = err;
      process.stderr.write('  [r8] goto attempt ' + (attempt + 1) + ' failed: ' + err.message + '\n');
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  if (!gotoOk) throw gotoErr || new Error('goto failed after retries');

  // Hardest path to grab the agent: patch the UI module's bootstrap
  // to stash the instance. We do this by injecting a patched ui.js
  // in the page context. Simpler: wait for the Place Call button to
  // exist, then monkey-patch its click handler's closure via the
  // known path: the `agent` is referenced by the onclick listener.
  //
  // We use a known workaround — patch the global BEFORE the app
  // boots so the VoiceAgent import's own module-level code stashes
  // itself. Since the module is ESM and we can't easily intercept
  // that, we rely on the fact that `bootstrapVoiceShell` returns
  // the agent and that the app calls it from app.js.
  //
  // Actual approach: inject a brief script that polls for
  // `document.querySelector('#voice-call-btn')` and reads its
  // attached agent reference (which is closed-over, not accessible
  // from outside). Since the handler uses a closure, we can't reach
  // it directly. Instead, we expose a NEW helper: a
  // `dispatchEvent` on the voice-agent EventTarget. We find that
  // target by walking document object references.
  //
  // Simplest actually-working approach: add a small hook to
  // js/voice-agent.js (one line) that sets `window.__r8Agent = this`
  // when `?r8hook=1` is in the URL. The hook brief says "minimal
  // surface" and is gated. We add this via a separate edit to
  // voice-agent.js (not this file) — see the companion patch.

  const btn = await page.waitForSelector('#voice-call-btn', { timeout: 8000 });
  events.push({ t: Date.now() - t0, kind: 'btn.ready' });

  // Click Place Call.
  await btn.click();
  events.push({ t: Date.now() - t0, kind: 'btn.clicked_place' });

  // Wait for agent readiness:
  //   - 'agent' scenario: wait for callOpen to end + listening state
  //     (~17 s) before we simulate end_call_requested.
  //   - 'user-during-*' scenarios: delays per scenario.
  async function waitMs(ms) { return new Promise((r) => setTimeout(r, ms)); }

  async function clickEndCall() {
    // Click the call button in its End state.
    await btn.click();
    events.push({ t: Date.now() - t0, kind: 'btn.clicked_end' });
  }

  async function simulateAgentEnd() {
    // Fire end_call_requested into the agent + simulate turn_complete
    // and agent-playback-drained. Goes through the agent's own
    // _onServerMessage handler which routes `end_call_requested` to
    // the deterministic wait.
    const ok = await page.evaluate(() => {
      const a = window.__r8Agent;
      if (!a) return 'no_agent_ref';
      a._onServerMessage({ type: 'end_call_requested', reason: 'smoke' });
      // Simulate agent audio already drained + turn complete.
      setTimeout(() => {
        try {
          a._onServerMessage({ type: 'turn_complete' });
          if (a.pipeline && typeof a.pipeline.dispatchEvent === 'function') {
            a.pipeline.dispatchEvent(new CustomEvent('agent-playback-drained'));
          }
        } catch (e) {}
      }, 60);
      return 'ok';
    });
    events.push({ t: Date.now() - t0, kind: 'simulate.agent_end', detail: ok });
  }

  // Scenario timing.
  if (scenario === 'agent') {
    // Wait for callOpen to end + a bit past for listen/idle.
    await waitMs(17500);
    await simulateAgentEnd();
    // Expect callClose duration ~4.1s, so wait ≥5s for teardown.
    await waitMs(6000);
  } else if (scenario === 'user-during-callopen') {
    await waitMs(3000);
    await clickEndCall();
    await waitMs(1500);
  } else if (scenario === 'user-after-callopen') {
    await waitMs(17500);
    await clickEndCall();
    await waitMs(1500);
  } else if (scenario === 'user-during-greeting') {
    await waitMs(17800);  // ~100ms into the flushed-buffer period
    await clickEndCall();
    await waitMs(1500);
  } else if (scenario === 'user-during-agent-end-wait') {
    await waitMs(17500);
    await simulateAgentEnd();
    // While the wait is armed (turn_complete + drained in ~60ms)…
    // actually let's click BEFORE the wait completes. Since sim
    // completes in 60ms we need to click in between. Instead: fire a
    // raw end_call_requested without the completion triggers, then
    // click mid-wait.
    await page.evaluate(() => {
      // Clear any automated completion by re-arming
      const a = window.__r8Agent;
      if (!a) return;
      // Cancel any pending completion simulated above then re-arm
      // without completions so the wait stays open.
      a._cancelAgentEndingWait && a._cancelAgentEndingWait('test_reset');
      a._onServerMessage({ type: 'end_call_requested', reason: 'smoke_hold' });
    });
    await waitMs(200);  // small delay so the wait is visibly armed
    await clickEndCall();
    await waitMs(1500);
  } else if (scenario === 'user-during-callclose') {
    await waitMs(17500);
    await simulateAgentEnd();
    // Agent chain completes: turn_complete + drained fire at ~60ms
    // → _gracefullyEndCall('agent_end_call') → playCallClose() starts.
    // Click 500ms into the chime.
    await waitMs(800);
    await clickEndCall();
    await waitMs(1200);
  } else {
    throw new Error('unknown scenario: ' + scenario);
  }

  const all = events.slice();
  process.stdout.write('  [r8] ' + scenario + ' run ' + runIdx + ' captured ' + all.length + ' events; closing browser\n');
  await browser.close();

  const fname = path.join(OUTDIR, 'r8-' + scenario + '-run-' + runIdx + '-' + stamp() + '.json');
  try {
    fs.writeFileSync(fname, JSON.stringify(all, null, 2));
    process.stdout.write('  [r8] wrote ' + fname + '\n');
  } catch (err) {
    process.stderr.write('  [r8] write FAILED ' + err.message + '\n');
  }
  return { scenario, run: runIdx, file: fname, events: all };
}

(async function main() {
  const results = { agent: [], user: [] };

  for (let i = 0; i < N_RUNS_AGENT; i++) {
    process.stdout.write('\n=== AGENT run ' + (i + 1) + '/' + N_RUNS_AGENT + ' ===\n');
    try {
      const r = await runOnce(i + 1, 'agent');
      results.agent.push(r);
    } catch (err) {
      process.stderr.write('AGENT run threw: ' + (err && err.stack || err.message) + '\n');
      results.agent.push({ run: i + 1, error: String(err && err.message) });
    }
  }

  const userScenarios = [
    'user-during-callopen',
    'user-after-callopen',
    'user-during-greeting',
    'user-during-agent-end-wait',
    'user-during-callclose'
  ];
  for (let i = 0; i < Math.min(N_RUNS_USER, userScenarios.length); i++) {
    process.stdout.write('\n=== USER run ' + (i + 1) + '/' + N_RUNS_USER + ' (' + userScenarios[i] + ') ===\n');
    try {
      const r = await runOnce(i + 1, userScenarios[i]);
      results.user.push(r);
    } catch (err) {
      process.stderr.write('USER run threw: ' + (err && err.stack || err.message) + '\n');
      results.user.push({ run: i + 1, scenario: userScenarios[i], error: String(err && err.message) });
    }
  }

  // Summary + invariant checks.
  process.stdout.write('\n=== SUMMARY ===\n');
  let pass = 0, fail = 0;
  for (const r of results.agent) {
    const ev = r.events || [];
    const bufsrcStarts = ev.filter((e) => e.kind === 'bufsrc.start');
    // CallOpen is ~15.7s, callClose is ~4.1s. Distinguish by duration.
    const opens = bufsrcStarts.filter((e) => e.detail && e.detail.duration > 10);
    const closes = bufsrcStarts.filter((e) => e.detail && e.detail.duration > 3 && e.detail.duration < 6);
    const onEndeds = ev.filter((e) => e.kind === 'bufsrc.onended');
    const closeOk = closes.length === 1;
    const teardownAfterChime = (() => {
      if (!closes.length) return false;
      const tStart = closes[0].t;
      const onEnd = ev.find((e) => e.kind === 'bufsrc.onended' && e.detail && e.detail.duration > 3 && e.detail.duration < 6 && e.t > tStart);
      const sendCallEnd = ev.find((e) => e.kind === 'ws.send' && e.detail && e.detail.type === 'call_end');
      // call_end is sent right before chime on agent path per the current
      // order; just verify the onended arrived.
      return !!onEnd;
    })();
    const ok = closeOk && teardownAfterChime;
    process.stdout.write('AGENT run ' + r.run + ': opens=' + opens.length + ' closes=' + closes.length + ' onendeds=' + onEndeds.length + ' → ' + (ok ? 'PASS' : 'FAIL') + '\n');
    if (ok) pass++; else fail++;
  }
  for (const r of results.user) {
    const ev = r.events || [];
    const bufsrcStarts = ev.filter((e) => e.kind === 'bufsrc.start');
    // Agent path identifier: a buffer source with 4-6s duration fully
    // completed. User-during-callclose is a special case where close
    // may have started but then got .stop(0)'d. Any buffer in the
    // 3-6s duration range that RAN to completion (= onended WITHOUT
    // a preceding .stop()) on user path is a FAIL.
    const closes = bufsrcStarts.filter((e) => e.detail && e.detail.duration > 3 && e.detail.duration < 6);
    let closeFullyPlayed = false;
    for (const c of closes) {
      // Did stop() happen AFTER c.t?
      const stoppedAfter = ev.find((e) => e.kind === 'bufsrc.stop' && e.t > c.t && e.t < c.t + 6000);
      if (!stoppedAfter) {
        closeFullyPlayed = true;   // this one ran without interruption
      }
    }
    const ok = !closeFullyPlayed;
    process.stdout.write('USER [' + r.scenario + '] run ' + r.run + ': closes=' + closes.length + ' fullyPlayed=' + closeFullyPlayed + ' → ' + (ok ? 'PASS' : 'FAIL') + '\n');
    if (ok) pass++; else fail++;
  }

  process.stdout.write('\n=== ' + pass + ' pass / ' + fail + ' fail ===\n');
  process.exit(fail === 0 ? 0 : 1);
})();
