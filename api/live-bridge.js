'use strict';

/**
 * Gemini Live ↔ Browser bridge.
 *
 * Per-browser-WS lifecycle:
 *   1. Validate origin + rate limit, set state=idle.
 *   2. Wait for `hello` { persona, elements, page, mode?, resumeHandle? }.
 *   3. Open upstream ai.live.connect() with tools + persona-specific system
 *      prompt and mode-specific VAD preset. If hello supplied a fresh-enough
 *      resumption handle (within SESSION_RESUME_WINDOW_MS), pass it in the
 *      sessionResumption config so Gemini restores prior turn history.
 *   4. Bridge frames both directions. Binary frames are RAW PCM (no tag byte).
 *      Text frames are JSON control messages.
 *   5. Emit `setup_complete` to the browser on the first upstream message —
 *      the browser gates outbound audio on that signal.
 *   6. Capture every `sessionResumptionUpdate.newHandle` and forward to the
 *      browser (`session_resumption`) so the next page load can pick up the
 *      latest handle from sessionStorage. On the first update after a
 *      connect-with-handle: emit `session_resumed` if resumable, else
 *      `session_resume_failed` so the UI can un-dim / fall back cleanly.
 *   7. `page_context` messages from the browser (sent after nav) are turned
 *      into a delimited `<page_context>...</page_context>` system update and
 *      injected via session.sendRealtimeInput({ text }). (Previously used
 *      sendClientContent — but that's "seed-history only" on Gemini 3.1
 *      Flash Live, so the model would silently store the text without
 *      responding. Realtime-input is honoured on both 3.1 and 2.5.) The
 *      model is taught in the system prompt to acknowledge page changes in
 *      one short sentence unless the user is mid-task.
 *   8. Tool calls: forward to browser; round-trip results; 10s timeout.
 *   9. Heartbeat: 25s idle watchdog to close stale sessions.
 */

const { GoogleGenAI } = require('@google/genai');
const {
  LIVE_MODEL_ID,
  LIVE_MODEL_FALLBACK,
  KNOWN_VOICES,
  SESSION_RESUME_WINDOW_MS,
  buildLiveConfig
} = require('./gemini-config');
const { STATIC_TOOL_DECLARATIONS, buildSystemInstruction } = require('./tools');
const { getPersona, publicPersonas, DEFAULT_PERSONA_ID } = require('./personas');
const { makeFrameLimiter } = require('./rate-limit');
const { SHOW_TEXT } = require('./server-flags');

// Cap on how much of the visible-element list we include in a page-context
// injection so the model sees the surface without blowing token budget.
const PAGE_CONTEXT_MAX_ELEMENTS = 40;
const PAGE_CONTEXT_MAX_TEXT_BYTES = 4 * 1024;

const DEBUG = String(process.env.DEBUG || '') === '1' || /bridge/i.test(String(process.env.DEBUG || ''));

function dlog(sessionId, ...parts) {
  if (!DEBUG) return;
  process.stdout.write(`[live ${sessionId}] ${parts.join(' ')}\n`);
}

function now() { return Date.now(); }

function safeSendJson(ws, obj) {
  if (!ws || ws.readyState !== 1) return;
  try { ws.send(JSON.stringify(obj)); } catch { /* ignore */ }
}

function safeSendBinary(ws, buf) {
  if (!ws || ws.readyState !== 1) return;
  // latency-pass: disable per-message deflate for PCM audio. ws defaults to
  // `perMessageDeflate: true` on the server — applied to every frame,
  // including binary. 16-bit PCM at 16 kHz (8–32 kB/frame) is near-random
  // at the byte level and doesn't compress well (often ~95 %+ of original).
  // The CPU cost of deflate per frame (allocate, compress, send) stalls the
  // event loop on every audio chunk and delays both the TTS return path
  // AND incoming mic audio forwarding. Opting out with `compress:false`
  // skips the deflate stage entirely for the frame.
  try { ws.send(buf, { binary: true, compress: false }); } catch { /* ignore */ }
}

function buildGenaiClient(apiKey) {
  return new GoogleGenAI({ apiKey });
}

/** Strip delimiter tokens and control chars from any string we embed in a
 *  delimited prompt block. Mirrors the defence used in tools.js.
 *  (We also bound length — the browser is the trusted caller but storage can
 *   be tampered with via DevTools.) */
function safeDelimText(s, max = 140) {
  return String(s || '')
    .replace(/<\/?persona>|<\/?user_input>|<\/?page_context>|<\/?system>/gi, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** Build the <call_initiated>...</call_initiated> block sent on the first
 *  `setup_complete` after the user places a call. The model is taught to
 *  respond immediately with one short greeting — introduce itself, ask how
 *  it can help, stay in-persona. */
function buildCallInitiatedText({ page, title }) {
  const niceTitle = safeDelimText(title, 100) || '(untitled page)';
  const safePage = safeDelimText(page, 80) || '/';
  const lines = [
    '<call_initiated>',
    `The user just placed a call and is now connected. They are on ${safePage} ("${niceTitle}").`,
    'Greet them ONCE, briefly, in one short sentence — introduce yourself as Jarvis from Dhruv FreightOps and ask how you can help. Start speaking immediately; do not wait for them. Keep your persona. End with a question.',
    '</call_initiated>'
  ];
  return lines.join('\n');
}

/** Build the <page_context>...</page_context> block injected on navigation.
 *  The model is taught in the system prompt how to interpret this — treat as
 *  a system update, not a user request; acknowledge briefly unless mid-task. */
function buildPageContextText({ page, title, elements }) {
  const lines = [];
  lines.push('<page_context>');
  const niceTitle = safeDelimText(title, 100) || '(untitled page)';
  lines.push(`User navigated to ${safeDelimText(page, 80)} ("${niceTitle}").`);
  if (Array.isArray(elements) && elements.length) {
    lines.push('Visible agent-addressable elements (partial list):');
    for (const e of elements) {
      const id = safeDelimText(e.id, 80);
      const label = safeDelimText(e.label, 60);
      if (!id) continue;
      lines.push(label ? `- ${id} :: ${label}` : `- ${id}`);
    }
  } else {
    lines.push('No interactive elements detected yet on this page.');
  }
  lines.push('Briefly acknowledge the page change in one short sentence unless the user is mid-task; if mid-task, stay silent. Ground any next tool calls on the element list above.');
  lines.push('</page_context>');
  const text = lines.join('\n');
  if (text.length <= PAGE_CONTEXT_MAX_TEXT_BYTES) return text;
  // If the list overflows, truncate element lines to fit the budget.
  const head = `<page_context>\nUser navigated to ${safeDelimText(page, 80)} ("${niceTitle}").\nVisible agent-addressable elements (truncated):\n`;
  const tail = '\n... (list truncated)\nBriefly acknowledge the page change in one short sentence unless the user is mid-task; if mid-task, stay silent. Ground any next tool calls on the element list above.\n</page_context>';
  const budget = PAGE_CONTEXT_MAX_TEXT_BYTES - head.length - tail.length;
  let chunk = '';
  for (const e of elements) {
    const id = safeDelimText(e.id, 80);
    const label = safeDelimText(e.label, 60);
    const line = (label ? `- ${id} :: ${label}` : `- ${id}`) + '\n';
    if (chunk.length + line.length > budget) break;
    chunk += line;
  }
  return head + chunk + tail;
}

/** Lightweight type-guard for map-tool args. Returns an error string when the
 *  args are obviously malformed (wrong type / out-of-enum), else null. The
 *  widget does full validation + canonical error envelopes; this just saves a
 *  round-trip on the easy failures and keeps the model from learning bad
 *  shapes. */
const MAP_LAYER_ENUM = new Set(['loads', 'carriers', 'lanes', 'delayed']);
function validateMapToolArgs(name, args) {
  if (!args || typeof args !== 'object') return null;
  if (name === 'map_show_layer') {
    const layer = args.layer;
    if (typeof layer !== 'string' || !layer.trim()) {
      return 'map_show_layer requires a string "layer" (one of: loads, carriers, lanes, delayed).';
    }
    if (!MAP_LAYER_ENUM.has(layer.trim().toLowerCase())) {
      return `Layer "${String(layer).slice(0, 40)}" not recognised. One of: loads, carriers, lanes, delayed.`;
    }
    if (typeof args.visible !== 'boolean') {
      return 'map_show_layer requires "visible" as a boolean (true or false), not ' + typeof args.visible + '.';
    }
    return null;
  }
  if (name === 'map_highlight_load') {
    const id = args.load_id;
    if (typeof id !== 'string' || !id.trim()) {
      return 'map_highlight_load requires a string "load_id" like "LD-10824".';
    }
    return null;
  }
  if (name === 'map_focus') {
    const hasTarget = typeof args.target === 'string' && args.target.trim().length > 0;
    const latNum = Number(args.lat);
    const lngNum = Number(args.lng);
    const hasCoords = Number.isFinite(latNum) && Number.isFinite(lngNum);
    if (!hasTarget && !hasCoords) {
      return 'map_focus requires either a string "target" (city, state, or id) or numeric lat+lng.';
    }
    if (hasCoords && (latNum < -90 || latNum > 90 || lngNum < -180 || lngNum > 180)) {
      return 'map_focus lat/lng out of range (lat -90..90, lng -180..180).';
    }
    return null;
  }
  return null;
}

function isErrorEphemeral(err) {
  const msg = (err && (err.message || err.toString())) || '';
  const code = err && err.code;
  if (/api[_ ]?key|unauthori[sz]ed|PERMISSION_DENIED|invalid/i.test(msg)) return { retriable: false, code: 'invalid_key' };
  if (/not found|UNSUPPORTED|unsupported model|NOT_FOUND/i.test(msg)) return { retriable: false, code: 'model_unavailable' };
  if (/429|rate|quota|RESOURCE_EXHAUSTED/i.test(msg) || code === 429) return { retriable: true, code: 'rate_limited' };
  if (/refus|safety|BLOCK/i.test(msg)) return { retriable: false, code: 'refusal' };
  if (/network|timeout|ECONNRESET|EAI_AGAIN|socket|WebSocket/i.test(msg)) return { retriable: true, code: 'network' };
  return { retriable: false, code: 'upstream_error' };
}

function attach(browserWs, req, env) {
  const apiKey = env.GEMINI_API_KEY;
  const sessionId = Math.random().toString(36).slice(2, 10);
  let genai = null;
  let upstream = null;
  let modelUsed = null;
  let persona = getPersona(DEFAULT_PERSONA_ID);
  let mode = 'wakeword'; // 'wakeword' | 'live'
  let pageName = '/';
  let runtimeElements = [];
  let pendingToolResponses = new Map();
  let helloReceived = false;
  let closed = false;
  let upstreamEverProducedData = false;
  // latency-pass: if the browser supplied `greet:{page,title}` in its hello
  // frame, we inject the <call_initiated> block as soon as the upstream is
  // ready — saving one browser ↔ server RTT vs waiting for a subsequent
  // `call_start` message. Cleared after first-use so subsequent reconnects
  // within the same browser WS don't re-greet.
  // greeting-fix: explicit state machine. Two gates must close before the
  // greeting can fire:
  //   (a) `upstreamSetupComplete` — the upstream session has sent its first
  //       message (setupComplete from Gemini).
  //   (b) A greet intent is pending — either from the hello frame or from
  //       an explicit `call_start` frame.
  // We fire deterministically as soon as both gates are closed, in either
  // order — no dependency on any browser-to-server audio frame. This was
  // the regression: the prior pass correctly scheduled the inject on the
  // upstream's first message, but the inject itself used `sendClientContent`
  // which Gemini 3.1 Flash Live does NOT treat as a trigger for model
  // response. The fix below switches to `sendRealtimeInput({text})` which
  // IS honoured by 3.1 and does generate the audio greeting.
  let pendingGreet = null;
  let greetInjected = false;
  let upstreamSetupComplete = false; // greeting-fix: explicit gate (a)
  // audio-flow: gate (c). The browser plays a start-call chime while the
  // upstream handshake happens. Gemini's greeting must NOT speak over
  // that clip, so we hold the greet here until the browser sends
  // `greet_gate_open` (after the chime ends or its safety cap fires).
  let clientGreetGateOpen = false;
  // audio-flow: idempotency latch for the agent-initiated end_call tool.
  // When the model calls end_call we immediately ack the upstream, send
  // an `end_call_requested` frame to the browser, and mark this flag so
  // a second invocation in the same call is a no-op.
  let agentEndCallInFlight = false;
  let resumptionHandle = null;
  // The handle we attempted to resume WITH (distinct from the handle we
  // captured AFTER a successful resume). On the first resumption update the
  // server will tell us whether the handle was honoured; track intent so we
  // can surface `session_resumed` / `session_resume_failed` to the client.
  let attemptedResumeHandle = null;
  let resumeAckSent = false;
  let heartbeatTimer = null;
  let lastTrafficAt = Date.now();
  const frameLimiter = makeFrameLimiter();

  function touchTraffic() { lastTrafficAt = Date.now(); }

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (!upstream) return;
      const idleMs = Date.now() - lastTrafficAt;
      if (idleMs > 5 * 60 * 1000) {
        dlog(sessionId, 'upstream idle >5min — closing');
        closeUpstream('idle_timeout');
      }
    }, 25_000);
  }
  function stopHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  function emitState(state, detail) {
    safeSendJson(browserWs, { type: 'state', state, detail });
  }

  function emitError(code, message, retriable) {
    safeSendJson(browserWs, { type: 'error', code, message, retriable: !!retriable });
  }

  function snapshotElementsAsToolContext() {
    return runtimeElements.map((e) => ({
      id: e.id,
      role: e.role,
      label: String(e.label || '').slice(0, 140),
      page: e.page,
      value: e.state && e.state.value,
      checked: e.state && e.state.checked,
      disabled: e.state && e.state.disabled,
      options: Array.isArray(e.options) ? e.options.slice(0, 24) : undefined
    }));
  }

  function handleFunctionCall(fc) {
    const name = fc.name;
    const args = fc.args || {};
    const id = fc.id;

    // When SHOW_TEXT=false the operator asked us to log tool NAMES only —
    // args can carry arbitrary user/agent text so we drop them from logs.
    if (SHOW_TEXT) {
      dlog(sessionId, 'tool_call', name, JSON.stringify(args).slice(0, 200));
    } else {
      dlog(sessionId, 'tool_call', name, '(args redacted: SHOW_TEXT=false)');
    }

    if (name === 'list_elements') {
      let out = snapshotElementsAsToolContext();
      const filter = (args.filter || '').toString().toLowerCase();
      if (filter) {
        out = out.filter(
          (e) =>
            e.id.toLowerCase().includes(filter) ||
            (e.label && e.label.toLowerCase().includes(filter))
        );
      }
      sendToolResponse(id, name, { ok: true, result: { count: out.length, elements: out } });
      return;
    }

    // audio-flow: agent-initiated hang-up. The model has decided the
    // conversation is done. We handle this entirely server-side:
    //   1. Ack the tool call so Gemini doesn't keep speaking.
    //   2. Forward an `end_call_requested` frame to the browser — the
    //      VoiceAgent there runs the same sequence as a user click
    //      (stop background, play endCall chime, close WS). Its
    //      `_endingCall` latch guards against double-firing.
    //   3. Mark `agentEndCallInFlight` so a second tool invocation in
    //      the same turn is a no-op. The upstream close happens when
    //      the browser closes the WS — we don't slam it here because
    //      Gemini's own tool-response ack requires the socket alive.
    if (name === 'end_call') {
      const reason = typeof args.reason === 'string' ? String(args.reason).slice(0, 200) : undefined;
      dlog(sessionId, 'agent_end_call reason=' + (reason || '(none)'));
      const payload = { ok: true, result: { ended: true, reason: reason || null } };
      sendToolResponse(id, name, payload);
      if (!agentEndCallInFlight) {
        agentEndCallInFlight = true;
        safeSendJson(browserWs, { type: 'end_call_requested', reason: reason || null });
      } else {
        dlog(sessionId, 'agent_end_call duplicate — not re-notifying browser');
      }
      return;
    }

    // Short-circuit obviously-malformed map-tool args server-side so the model
    // sees a clean error envelope without a browser round-trip. Keeps shape
    // identical to what the widget returns (ok:false + error string).
    const guardErr = validateMapToolArgs(name, args);
    if (guardErr) {
      sendToolResponse(id, name, { ok: false, error: guardErr });
      return;
    }

    safeSendJson(browserWs, { type: 'tool_call', id, name, args });
    emitState('tool_executing', name);

    const timer = setTimeout(() => {
      if (pendingToolResponses.has(id)) {
        pendingToolResponses.delete(id);
        sendToolResponse(id, name, { ok: false, error: 'Browser tool timeout.' });
      }
    }, 10_000);
    pendingToolResponses.set(id, { name, timer });
  }

  function normaliseToolResponse(payload) {
    if (!payload || typeof payload !== 'object') return { result: 'ok' };
    if (payload.ok === false) {
      // Canonical shape is `{ error }`. When the browser attaches a
      // structured `result.fill_failure` (or similar), flatten it into
      // the error string so the model sees exactly what format the
      // input expected — the `error` value can be any JSON-able thing,
      // but making it a descriptive string is the most portable shape.
      const msg = String(payload.error || 'Tool call failed.');
      const extra = payload.result && typeof payload.result === 'object'
        ? ' DETAIL: ' + JSON.stringify(payload.result)
        : '';
      return { error: msg + extra };
    }
    if (payload.result === undefined || payload.result === null) {
      return { result: 'ok' };
    }
    return { result: payload.result };
  }

  function sendToolResponse(id, name, payload) {
    if (!upstream) return;
    try {
      upstream.sendToolResponse({
        functionResponses: [
          { id, name, response: normaliseToolResponse(payload) }
        ]
      });
    } catch (err) {
      dlog(sessionId, 'sendToolResponse error', err.message || String(err));
    }
  }

  async function openUpstream({ reuseHandle = true, explicitHandle = null } = {}) {
    emitState('connecting');
    if (!genai) {
      try {
        genai = buildGenaiClient(apiKey);
      } catch (err) {
        emitError('invalid_key', 'Failed to initialise Gemini client. Check GEMINI_API_KEY.', false);
        emitState('error', 'invalid_key');
        return false;
      }
    }

    const voice = KNOWN_VOICES.includes(persona.voice) ? persona.voice : 'Kore';
    const systemInstruction = buildSystemInstruction({
      personaFragment: persona.fragment,
      pageName
    });
    // Prefer an explicit handle supplied by the caller (cross-page handoff
    // from the browser's sessionStorage) over the in-memory one we captured
    // during this process's lifetime.
    const handle = explicitHandle != null
      ? explicitHandle
      : (reuseHandle ? resumptionHandle : null);
    attemptedResumeHandle = handle || null;
    resumeAckSent = false;
    const config = buildLiveConfig({
      systemInstruction,
      voiceName: voice,
      functionDeclarations: STATIC_TOOL_DECLARATIONS,
      mode,
      resumptionHandle: handle
    });

    // latency-pass: tighten end-of-speech detection for LIVE mode. The upstream
    // default in gemini-config.js is 500 ms of trailing silence before Gemini
    // marks end-of-turn and fires the model — felt like a perceptible "wait".
    // Override to 350 ms here (near the floor of "natural" turn-taking latency
    // for native English; the human conversation floor is ~200–300 ms). Going
    // lower starts clipping brief mid-sentence pauses. Wake-word mode keeps
    // its 700 ms because users trail off after "Hey Jarvis" before the real
    // request. Done post-build so gemini-config.js stays unchanged.
    if (mode === 'live'
        && config.realtimeInputConfig
        && config.realtimeInputConfig.automaticActivityDetection) {
      config.realtimeInputConfig.automaticActivityDetection.silenceDurationMs = 350;
    }

    const modelsToTry = [LIVE_MODEL_ID, LIVE_MODEL_FALLBACK];
    let lastErr = null;

    for (const modelId of modelsToTry) {
      dlog(sessionId, 'upstream connect requested model=' + modelId, 'voice=' + voice, 'persona=' + persona.id, 'mode=' + mode, 'resume=' + (handle ? 'yes' : 'no'));
      try {
        upstream = await genai.live.connect({
          model: modelId,
          config,
          callbacks: {
            onopen: () => {
              modelUsed = modelId;
              dlog(sessionId, 'onopen model=' + modelId);
              emitState('connecting', `model=${modelId}`);
            },
            onmessage: (msg) => onUpstreamMessage(msg),
            onerror: (evt) => {
              const err = evt && (evt.error || evt);
              const info = isErrorEphemeral(err);
              dlog(sessionId, 'onerror', info.code, (err && err.message) || String(err));
              emitError(info.code, (err && err.message) || 'Upstream error', info.retriable);
              emitState('error', info.code);
            },
            onclose: (evt) => {
              const code = evt && (evt.code || evt.statusCode);
              const reason = (evt && evt.reason && evt.reason.toString()) || '';
              dlog(sessionId, 'onclose code=' + (code || '?'), 'reason=' + (reason || '?'), 'hadData=' + upstreamEverProducedData);
              if (!upstreamEverProducedData && !closed) {
                let errCode = 'ws_closed';
                if (code === 1008 || code === 1007 || code === 4401 || code === 4003) errCode = 'invalid_key';
                if (/api.key|unauthor|permission|invalid/i.test(reason)) errCode = 'invalid_key';
                if (/quota|rate|exhaust/i.test(reason)) errCode = 'rate_limited';
                if (/not.found|unsupported.model/i.test(reason)) errCode = 'model_unavailable';
                emitError(errCode, reason || `Upstream closed before setupComplete (code=${code || '?'})`, false);
                emitState('error', errCode);
              } else if (!closed) {
                emitState('idle');
              }
              upstream = null;
              upstreamEverProducedData = false;
            }
          }
        });
        dlog(sessionId, 'ai.live.connect resolved');
        startHeartbeat();
        return true;
      } catch (err) {
        lastErr = err;
        const info = isErrorEphemeral(err);
        dlog(sessionId, 'ai.live.connect threw', info.code, err.message || String(err));
        if (info.code === 'invalid_key') {
          emitError('invalid_key', 'Gemini rejected the API key. Set a valid GEMINI_API_KEY and restart the server.', false);
          emitState('error', 'invalid_key');
          return false;
        }
        if (info.code === 'model_unavailable' && modelId !== LIVE_MODEL_FALLBACK) continue;
        emitError(info.code, (err && err.message) || String(err), info.retriable);
        emitState('error', info.code);
        return false;
      }
    }
    emitError('model_unavailable', (lastErr && lastErr.message) || 'No Gemini Live model available.', false);
    emitState('error', 'model_unavailable');
    return false;
  }

  // greeting-fix + audio-flow: three-gate deterministic greeting fire.
  // Called from every site where any of the three gates could be closed:
  //   1. onUpstreamMessage, first message → upstreamSetupComplete (gate a).
  //   2. onBrowserText 'hello'            → pendingGreet           (gate b).
  //   3. onBrowserText 'greet_gate_open'  → clientGreetGateOpen   (gate c).
  // Guarded on (upstream && upstreamSetupComplete && pendingGreet &&
  // clientGreetGateOpen && !greetInjected). Uses `sendRealtimeInput({text})`
  // which IS honoured by Gemini 3.1 Flash Live as a trigger for immediate
  // model response. `sendClientContent` is documented as "only supported
  // for seeding initial context history" on 3.1 — it silently stashes
  // the turn and the model never speaks.
  function maybeFireGreeting(source) {
    if (greetInjected) return;
    if (!pendingGreet) return;
    if (!upstream) return;
    if (!upstreamSetupComplete) return;
    if (!clientGreetGateOpen) return; // audio-flow: gate (c) — wait for startCall chime
    try {
      const text = buildCallInitiatedText(pendingGreet);
      // greeting-fix: sendRealtimeInput({text}) is the 3.1-compatible
      // trigger. Model responds with audio immediately; turn boundary is
      // inferred from the text arriving without concurrent user audio.
      upstream.sendRealtimeInput({ text });
      greetInjected = true;
      dlog(sessionId, '[jarvis-phase] greeting_fired src=' + source + ' page=' + pendingGreet.page + ' textLen=' + text.length);
      pendingGreet = null;
    } catch (err) {
      dlog(sessionId, 'greeting fire error src=' + source, err.message || String(err));
    }
  }

  function onUpstreamMessage(msg) {
    if (!msg) return;
    touchTraffic();

    if (!upstreamEverProducedData) {
      upstreamEverProducedData = true;
      upstreamSetupComplete = true; // greeting-fix: gate (a) closes here.
      dlog(sessionId, 'first message — handshake OK');
      safeSendJson(browserWs, { type: 'setup_complete', sessionId });
      emitState('listening');

      // greeting-fix: fire greeting deterministically from the gate that
      // just closed. Previously used sendClientContent which 3.1 does not
      // honour as a turn trigger.
      maybeFireGreeting('upstream_setup_complete');
    }

    if (DEBUG) {
      const keys = Object.keys(msg || {}).filter((k) => msg[k] != null);
      dlog(sessionId, 'onmessage keys=' + keys.join(','));
    }

    if (msg.sessionResumptionUpdate) {
      const upd = msg.sessionResumptionUpdate;
      if (upd.newHandle) {
        resumptionHandle = String(upd.newHandle);
        dlog(sessionId, 'session_resumption handle updated len=' + resumptionHandle.length);
        safeSendJson(browserWs, { type: 'session_resumption', handle: resumptionHandle });
      }
      // The first resumption-update after a connect-with-handle tells us
      // whether the upstream accepted the resume. Surface this exactly once
      // so the client can style the restored transcript (e.g. un-dim it on
      // success, or silently fall back on failure).
      if (attemptedResumeHandle && !resumeAckSent) {
        const resumable = upd.resumable !== false; // default true when omitted
        resumeAckSent = true;
        if (resumable) {
          dlog(sessionId, 'session_resumed OK (handle honoured by upstream)');
          safeSendJson(browserWs, { type: 'session_resumed', handle: attemptedResumeHandle });
        } else {
          dlog(sessionId, 'session_resume_failed — upstream returned resumable=false, starting fresh');
          safeSendJson(browserWs, { type: 'session_resume_failed', reason: 'upstream_not_resumable' });
          attemptedResumeHandle = null;
        }
      }
    }

    if (msg.usageMetadata) {
      safeSendJson(browserWs, {
        type: 'usage',
        inputTokens: Number(msg.usageMetadata.promptTokenCount || 0),
        outputTokens: Number(msg.usageMetadata.responseTokenCount || 0),
        cachedTokens: Number(msg.usageMetadata.cachedContentTokenCount || 0)
      });
    }

    if (msg.toolCall && Array.isArray(msg.toolCall.functionCalls)) {
      for (const fc of msg.toolCall.functionCalls) handleFunctionCall(fc);
      return;
    }

    if (msg.toolCallCancellation && Array.isArray(msg.toolCallCancellation.ids)) {
      for (const id of msg.toolCallCancellation.ids) {
        const pending = pendingToolResponses.get(id);
        if (pending) {
          clearTimeout(pending.timer);
          pendingToolResponses.delete(id);
        }
      }
      return;
    }

    if (msg.serverContent) {
      const sc = msg.serverContent;

      // Transcripts — only surface to the client when SHOW_TEXT=true. When
      // SHOW_TEXT=false we intentionally drop the deltas on the floor so the
      // server never relays user/agent text to the browser (and the client
      // doesn't render a transcript panel). Length-only logs either way.
      if (sc.inputTranscription && sc.inputTranscription.text) {
        const t = sc.inputTranscription.text;
        dlog(sessionId, 'input_tx delta len=' + t.length, 'finished=' + !!sc.inputTranscription.finished);
        if (SHOW_TEXT) {
          safeSendJson(browserWs, {
            type: 'transcript_delta',
            from: 'user',
            delta: t,
            finished: !!sc.inputTranscription.finished,
            at: now()
          });
        }
      }
      if (sc.outputTranscription && sc.outputTranscription.text) {
        const t = sc.outputTranscription.text;
        dlog(sessionId, 'output_tx delta len=' + t.length, 'finished=' + !!sc.outputTranscription.finished);
        if (SHOW_TEXT) {
          safeSendJson(browserWs, {
            type: 'transcript_delta',
            from: 'agent',
            delta: t,
            finished: !!sc.outputTranscription.finished,
            at: now()
          });
        }
      }

      if (sc.modelTurn && Array.isArray(sc.modelTurn.parts)) {
        for (const part of sc.modelTurn.parts) {
          if (part.inlineData && typeof part.inlineData.data === 'string') {
            const pcm = Buffer.from(part.inlineData.data, 'base64');
            dlog(sessionId, 'audio chunk bytes=' + pcm.length);
            safeSendBinary(browserWs, pcm);
            emitState('speaking');
          }
          if (part.text && part.text.trim() && SHOW_TEXT) {
            safeSendJson(browserWs, {
              type: 'transcript_delta',
              from: 'agent',
              delta: part.text,
              finished: true,
              at: now()
            });
          }
        }
      }

      if (sc.interrupted) {
        dlog(sessionId, 'interrupted');
        safeSendJson(browserWs, { type: 'interrupted' });
      }
      if (sc.turnComplete) {
        dlog(sessionId, 'turn_complete');
        safeSendJson(browserWs, { type: 'turn_complete' });
        emitState('listening');
      }
    }

    if (msg.goAway) {
      dlog(sessionId, 'goAway received');
      emitState('reconnecting');
    }
  }

  function onBrowserText(msg) {
    let data;
    try { data = JSON.parse(msg); } catch { return; }
    if (!data || typeof data.type !== 'string') return;
    touchTraffic();

    switch (data.type) {
      case 'hello': {
        helloReceived = true;
        persona = getPersona((data.persona || '').toString() || DEFAULT_PERSONA_ID);
        pageName = String(data.page || '/').slice(0, 120);
        runtimeElements = Array.isArray(data.elements) ? data.elements.slice(0, 500) : [];
        if (data.mode === 'live' || data.mode === 'wakeword') mode = data.mode;

        // Cross-page handoff: the browser may supply a handle captured in a
        // previous page's sessionStorage. Honour it only when the handle
        // looks like a non-empty string and was issued within the resume
        // window (the browser also gates this, but defence-in-depth here is
        // cheap and catches stale storage from an older tab).
        let incomingHandle = null;
        const rh = data.resumeHandle;
        const issuedAt = Number(data.resumeHandleIssuedAt) || 0;
        if (typeof rh === 'string' && rh.length > 0 && rh.length < 8192) {
          const age = issuedAt > 0 ? (Date.now() - issuedAt) : 0;
          if (issuedAt === 0 || age <= SESSION_RESUME_WINDOW_MS) {
            incomingHandle = rh;
          } else {
            dlog(sessionId, 'hello resumeHandle dropped — age=' + age + 'ms > window=' + SESSION_RESUME_WINDOW_MS + 'ms');
          }
        }

        // latency-pass: accept an optional `greet` field so the server can
        // inject the <call_initiated> block on the first upstream message
        // (saves one browser ↔ server RTT vs waiting for `call_start`).
        // Shape: `{ page: string, title: string }`. Backwards-compatible —
        // old clients don't set it and the `call_start` path still works.
        // greeting-fix: the ack flag `eagerGreetAck` must only be set when
        // BOTH the greet field is present AND the client will send no
        // follow-up `call_start`. Since the client sets `_greetingSent=true`
        // on receiving the ack, a truthful ack requires we commit to firing
        // the greeting. We do so deterministically via `maybeFireGreeting`
        // below, which is safe to call before the upstream is ready — it
        // just no-ops until gate (a) closes.
        let greetAcked = false;
        if (data.greet && typeof data.greet === 'object') {
          const gPage = String(data.greet.page || pageName || '/').slice(0, 120);
          const gTitle = String(data.greet.title || '').slice(0, 120);
          pendingGreet = { page: gPage, title: gTitle };
          greetInjected = false;
          greetAcked = true;
        }

        dlog(sessionId, 'hello persona=' + persona.id, 'mode=' + mode, 'page=' + pageName, 'elements=' + runtimeElements.length, 'resume=' + (incomingHandle ? 'yes' : 'no'), 'eagerGreet=' + (greetAcked ? 'yes' : 'no'));
        safeSendJson(browserWs, {
          type: 'hello_ack',
          sessionId,
          model: LIVE_MODEL_ID,
          personas: publicPersonas(),
          mode,
          resumeRequested: !!incomingHandle,
          resumeWindowMs: SESSION_RESUME_WINDOW_MS,
          // latency-pass: tell client we honoured the eager-greet so it can
          // skip sending an additional `call_start` frame.
          eagerGreetAck: greetAcked
        });
        openUpstream({ reuseHandle: false, explicitHandle: incomingHandle });
        // greeting-fix: opportunistic fire. If setupComplete already landed
        // (unusual: upstream would need to have been kept open), this fires
        // immediately. Otherwise no-ops until onUpstreamMessage closes the
        // gate. Either way the greeting lands exactly once.
        maybeFireGreeting('hello_received');
        return;
      }
      case 'call_start': {
        // Browser signalled: the user just placed a call. Inject a
        // <call_initiated>…</call_initiated> block so the model greets
        // them immediately. Fires once per placeCall on the browser
        // side; on the server side we guard on upstream readiness.
        // greeting-fix: unified path. Stash a pendingGreet (if not already
        // stashed via hello.greet) and call maybeFireGreeting. When the
        // upstream is not yet ready, this is a no-op and the fire will
        // happen on the subsequent setup_complete. When the eager path
        // already fired, this is idempotent.
        if (greetInjected) {
          dlog(sessionId, 'call_start skipped — greet already fired');
          return;
        }
        const page = String(data.page || pageName || '/').slice(0, 120);
        const title = String(data.title || '').slice(0, 120);
        pageName = page;
        pendingGreet = pendingGreet || { page, title };
        maybeFireGreeting('call_start');
        return;
      }
      case 'call_end': {
        // Browser signalled: the user ended the call. Close the upstream
        // Gemini session cleanly. The browser WS stays open (the shell
        // persists across page changes) so that future placeCall can
        // reopen without round-tripping the WS.
        dlog(sessionId, 'call_end requested — closing upstream');
        closeUpstream('call_end');
        emitState('idle');
        return;
      }
      case 'greet_gate_open': {
        // audio-flow: gate (c) closes. The browser has finished playing
        // the startCall chime (or timed out); Gemini can now speak
        // without talking over it. If the other two gates are already
        // closed, the greeting fires immediately.
        if (clientGreetGateOpen) return;
        clientGreetGateOpen = true;
        dlog(sessionId, 'greet_gate_open received — client ready for greeting');
        maybeFireGreeting('client_greet_gate_open');
        return;
      }
      case 'page_context': {
        // Browser sends this after a navigation once the WS is live again.
        // Server builds a delimited text frame and injects it as a client
        // turn so the model can acknowledge the page change.
        if (!upstream || !upstreamEverProducedData) {
          // Not ready yet. Browser retries on next LIVE_READY.
          dlog(sessionId, 'page_context ignored — upstream not ready');
          return;
        }
        const page = String(data.page || '/').slice(0, 120);
        const title = String(data.title || '').slice(0, 120);
        const elements = Array.isArray(data.elements) ? data.elements.slice(0, PAGE_CONTEXT_MAX_ELEMENTS) : [];
        pageName = page;
        runtimeElements = Array.isArray(data.elements) ? data.elements.slice(0, 500) : runtimeElements;
        const text = buildPageContextText({ page, title, elements });
        try {
          // greeting-fix: same 3.1 fix as the greeting path — sendClientContent
          // is "seed-history only" on gemini-3.1-flash-live-preview. Using
          // sendRealtimeInput({text}) means the model treats this as a user
          // turn and (per the system prompt) acknowledges the nav in one
          // short sentence unless mid-task.
          upstream.sendRealtimeInput({ text });
          dlog(sessionId, 'page_context_injected page=' + page + ' elements=' + elements.length + ' textLen=' + text.length);
        } catch (err) {
          dlog(sessionId, 'page_context inject error', err.message || String(err));
        }
        return;
      }
      case 'set_mode': {
        const next = data.mode === 'live' ? 'live' : 'wakeword';
        if (next === mode) return;
        dlog(sessionId, 'mode switch ' + mode + ' -> ' + next);
        mode = next;
        closeUpstream('mode_switch');
        // VAD config differs between modes so we start fresh (no handle reuse).
        openUpstream({ reuseHandle: false });
        return;
      }
      case 'persona': {
        const next = getPersona((data.persona || '').toString() || DEFAULT_PERSONA_ID);
        if (next.id === persona.id) return;
        dlog(sessionId, 'persona switch to ' + next.id);
        persona = next;
        closeUpstream('persona_switch');
        openUpstream({ reuseHandle: false });
        return;
      }
      case 'reconnect': {
        dlog(sessionId, 'client-requested reconnect');
        closeUpstream('client_reconnect');
        openUpstream({ reuseHandle: true });
        return;
      }
      case 'elements': {
        pageName = String(data.page || pageName).slice(0, 120);
        runtimeElements = Array.isArray(data.elements) ? data.elements.slice(0, 500) : [];
        return;
      }
      case 'tool_result': {
        const id = String(data.id || '');
        const pending = pendingToolResponses.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        pendingToolResponses.delete(id);
        // Log name + ok/fail status only. The result object can contain
        // DOM text / read_text output — redact when SHOW_TEXT=false.
        dlog(sessionId, 'tool_result', data.name || pending.name, 'ok=' + (data.ok !== false));
        sendToolResponse(id, data.name || pending.name, {
          ok: data.ok !== false,
          result: data.result,
          error: data.error
        });
        emitState('listening');
        return;
      }
      case 'stream_end': {
        if (!upstream) return;
        try { upstream.sendRealtimeInput({ audioStreamEnd: true }); } catch { /* ignore */ }
        return;
      }
      case 'transcript_event': {
        // Local Web Speech transcripts from the browser side. We never
        // persist or log the text — only the kind + length so operators
        // can see traffic without exposing conversation content.
        const t = String(data.text || '').slice(0, 500);
        dlog(sessionId, 'stt_event kind=' + (data.kind || '?'), 'len=' + t.length);
        return;
      }
      case 'clear_transcript':
        return;
      case 'ping':
        safeSendJson(browserWs, { type: 'pong' });
        return;
    }
  }

  function onBrowserBinary(buf) {
    if (!upstream) return;
    if (!Buffer.isBuffer(buf) || buf.length === 0) return;
    if (!upstreamEverProducedData) {
      // Audio arrived before setup_complete. Drop it — client is supposed to
      // wait for setup_complete before sending. Logging so we can see if the
      // client regresses this contract.
      dlog(sessionId, 'drop pre-setup audio bytes=' + buf.length);
      return;
    }
    if (!frameLimiter()) return;
    touchTraffic();
    try {
      upstream.sendRealtimeInput({
        audio: {
          data: buf.toString('base64'),
          mimeType: 'audio/pcm;rate=16000'
        }
      });
    } catch (err) {
      const info = isErrorEphemeral(err);
      dlog(sessionId, 'sendRealtimeInput error', info.code, err.message || String(err));
      emitError(info.code, err.message || 'Failed to send audio.', info.retriable);
    }
  }

  function closeUpstream(reason) {
    stopHeartbeat();
    if (!upstream) return;
    dlog(sessionId, 'closeUpstream reason=' + reason);
    try { upstream.close(); } catch { /* ignore */ }
    upstream = null;
    upstreamEverProducedData = false;
    // latency-pass: reset the eager-greet gate so a re-opened upstream
    // (persona/mode switch, reconnect) can greet again if the browser asks.
    // `pendingGreet` is only set on hello; subsequent opens don't auto-greet
    // unless the client sends it again.
    greetInjected = false;
    // greeting-fix: reset gate (a) — the new upstream has to reach setup
    // again before we can fire any pending greet against it.
    upstreamSetupComplete = false;
    // audio-flow: reset gate (c). The new upstream is a new call (from
    // the browser's POV, a fresh hello on reopen) so the client will
    // send `greet_gate_open` again after its chime finishes.
    clientGreetGateOpen = false;
    // audio-flow: reset the end-call idempotency latch so a follow-up
    // call in the same WS can hang up again.
    agentEndCallInFlight = false;
    // greeting-fix: also drop any stale pendingGreet that survived a close
    // without firing. Persona/mode switch paths re-open upstream without
    // a fresh hello, so we want ZERO chance of a delayed greet sneaking in
    // after a switch. A fresh placeCall always arrives via a new hello.
    pendingGreet = null;
  }

  function cleanup() {
    if (closed) return;
    closed = true;
    dlog(sessionId, 'browser WS closed — cleanup');
    for (const p of pendingToolResponses.values()) clearTimeout(p.timer);
    pendingToolResponses.clear();
    closeUpstream('browser_close');
  }

  browserWs.on('message', (data, isBinary) => {
    if (closed) return;
    try {
      if (isBinary) {
        onBrowserBinary(Buffer.isBuffer(data) ? data : Buffer.from(data));
      } else {
        onBrowserText(data.toString('utf8'));
      }
    } catch (err) {
      dlog(sessionId, 'bridge caught exception', err.message || String(err));
      emitError('bridge_error', err.message || String(err), false);
    }
  });
  browserWs.on('close', cleanup);
  browserWs.on('error', cleanup);

  dlog(sessionId, 'attach complete — awaiting hello');
  emitState('idle');
}

module.exports = { attach };
