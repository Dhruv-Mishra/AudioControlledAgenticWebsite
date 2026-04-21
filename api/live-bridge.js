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
 *      injected via session.sendClientContent({ turnComplete: true }). The
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
  try { ws.send(buf, { binary: true }); } catch { /* ignore */ }
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

  function onUpstreamMessage(msg) {
    if (!msg) return;
    touchTraffic();

    if (!upstreamEverProducedData) {
      upstreamEverProducedData = true;
      dlog(sessionId, 'first message — handshake OK');
      safeSendJson(browserWs, { type: 'setup_complete', sessionId });
      emitState('listening');
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

        dlog(sessionId, 'hello persona=' + persona.id, 'mode=' + mode, 'page=' + pageName, 'elements=' + runtimeElements.length, 'resume=' + (incomingHandle ? 'yes' : 'no'));
        safeSendJson(browserWs, {
          type: 'hello_ack',
          sessionId,
          model: LIVE_MODEL_ID,
          personas: publicPersonas(),
          mode,
          resumeRequested: !!incomingHandle,
          resumeWindowMs: SESSION_RESUME_WINDOW_MS
        });
        openUpstream({ reuseHandle: false, explicitHandle: incomingHandle });
        return;
      }
      case 'call_start': {
        // Browser signalled: the user just placed a call. Inject a
        // <call_initiated>…</call_initiated> block so the model greets
        // them immediately. Fires once per placeCall on the browser
        // side; on the server side we guard on upstream readiness.
        if (!upstream || !upstreamEverProducedData) {
          dlog(sessionId, 'call_start ignored — upstream not ready');
          return;
        }
        const page = String(data.page || pageName || '/').slice(0, 120);
        const title = String(data.title || '').slice(0, 120);
        pageName = page;
        const text = buildCallInitiatedText({ page, title });
        try {
          upstream.sendClientContent({
            turns: [{ role: 'user', parts: [{ text }] }],
            turnComplete: true
          });
          dlog(sessionId, 'call_initiated_injected page=' + page + ' textLen=' + text.length);
        } catch (err) {
          dlog(sessionId, 'call_start inject error', err.message || String(err));
        }
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
          upstream.sendClientContent({
            turns: [{ role: 'user', parts: [{ text }] }],
            turnComplete: true
          });
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
