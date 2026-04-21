// Shared UI shell. Builds the persistent chrome (header, skip link, voice
// dock) exactly once on initial document load. The VoiceAgent is created
// once here; every in-app navigation reuses the same agent.
//
// The primary UX is a phone-call metaphor:
//   - On page load, the dock shows a big "Place Call" button.
//   - Clicking it starts dialling (ambient noise in, WS opens, mic opens).
//   - Once connected, Jarvis greets the user and the button becomes "End Call".
//   - While dialling, the button shows "Cancel" so the user can bail.
//   - Mode (Live Call vs Wake Word) is an advanced setting in the gear
//     overlay, not a primary toggle.

import { VoiceAgent, STATE_COPY, STATES, IS_IN_CALL_STATES, IS_DIALING_STATES, IS_CLOSING_STATES } from './voice-agent.js';

const DEBUG = (() => {
  try {
    if (new URLSearchParams(location.search).get('debug') === '1') return true;
    if (localStorage.getItem('jarvis.debug') === '1') return true;
  } catch {}
  return false;
})();

// iOS Safari detection (Web Speech API is unreliable there).
function isIosSafari() {
  const ua = navigator.userAgent || '';
  const isIos = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isSafari = /^((?!chrome|android).)*safari/i.test(ua);
  return isIos && (isSafari || /CriOS|FxiOS/.test(ua));
}

function $(sel, root = document) { return root.querySelector(sel); }
function on(el, ev, fn, opts) { el.addEventListener(ev, fn, opts); }

// --- Dock markup ---

function buildDockMarkup() {
  const dock = document.createElement('section');
  dock.className = 'voice-dock';
  dock.id = 'voice-dock';
  dock.setAttribute('aria-label', 'Voice agent');
  dock.innerHTML = `
    <div class="voice-dock-header">
      <div class="voice-dock-title">
        <span class="app-brand" aria-hidden="true"><span class="dot"></span></span>
        <span class="voice-dock-brand-name">Jarvis</span>
        <span class="status-pill" id="voice-status-pill" data-state="idle" aria-live="polite">
          <span class="dot" aria-hidden="true"></span>
          <span class="label">Not connected</span>
        </span>
        <span class="chip chip--danger" id="voice-muted-chip" hidden>Muted</span>
        <span class="chip chip--ok" id="voice-live-chip" hidden>
          <span class="live-dot" aria-hidden="true"></span>
          <span id="voice-live-timer">0:00</span>
        </span>
      </div>
      <div class="voice-dock-header-actions">
        <button class="icon-btn" id="voice-settings" aria-label="Call settings" title="Call settings" data-agent-id="voice.settings">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="currentColor">
            <path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0 6a2 2 0 1 1 0-4 2 2 0 0 1 0 4Z"/>
            <path d="m19.4 13.3 1.8-1.1-1.9-3.3-2 .7a7.8 7.8 0 0 0-1.7-1l-.4-2.1h-3.8l-.4 2.1c-.6.2-1.2.6-1.7 1l-2-.7L5.4 12l1.8 1.1a7.6 7.6 0 0 0 0 2l-1.8 1.1 1.9 3.3 2-.7c.5.4 1.1.7 1.7 1l.4 2.1h3.8l.4-2.1c.6-.3 1.2-.6 1.7-1l2 .7 1.9-3.3-1.8-1.1c.1-.3.1-.7.1-1s0-.7-.1-1Z"/>
          </svg>
        </button>
        <button class="icon-btn voice-dock-collapse" id="voice-dock-toggle" aria-expanded="true" aria-controls="voice-dock" data-agent-id="voice.dock.collapse" title="Collapse voice panel">
          <span aria-hidden="true">–</span>
          <span class="sr-only">Collapse voice panel</span>
        </button>
      </div>
    </div>
    <div class="voice-error-banner" id="voice-error" role="alert" hidden></div>
    <div class="voice-dock-body">
      <div class="voice-transcript" id="voice-transcript" aria-live="polite" aria-label="Conversation transcript"></div>
      <div class="voice-status-strip" id="voice-status-strip" data-state="idle">
        <div class="voice-vu" aria-hidden="true">
          <span class="bar"></span><span class="bar"></span><span class="bar"></span>
          <span class="bar"></span><span class="bar"></span>
        </div>
        <span class="voice-status-text" id="voice-status-text">Not connected</span>
        <div class="spacer"></div>
        <span class="mono-id" id="voice-session-id"></span>
      </div>
    </div>
    <div class="voice-dock-action">
      <button class="call-btn call-btn--place" id="voice-call-btn" data-agent-id="voice.call_btn" data-call-state="idle" type="button">
        <svg class="call-btn-icon call-btn-icon--phone" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="currentColor">
          <path d="M6.6 10.8a15.5 15.5 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.6 1 1 0 0 1 1 1v3.5a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1 11.4 11.4 0 0 0 .6 3.6 1 1 0 0 1-.25 1l-2.25 2.2Z"/>
        </svg>
        <svg class="call-btn-icon call-btn-icon--end" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="currentColor">
          <path d="M12 9c-3.6 0-7 1-9.4 2.6a1 1 0 0 0-.3 1.4l1.8 2.4a1 1 0 0 0 1.2.3L7.2 15a1 1 0 0 0 .6-.9V12a11 11 0 0 1 8.4 0v2.1a1 1 0 0 0 .6.9l1.9.8a1 1 0 0 0 1.2-.3l1.8-2.4a1 1 0 0 0-.3-1.4C19 10 15.6 9 12 9Z"/>
        </svg>
        <span class="call-btn-label" id="voice-call-btn-label">Place Call</span>
      </button>
      <button class="mic-btn mic-btn--inline" id="voice-mic" data-agent-id="voice.mic" aria-pressed="false" title="Mute (M)" hidden>
        <svg class="mic-icon mic-icon--on" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 1 0 6 0V5a3 3 0 0 0-3-3Z" fill="currentColor"/>
          <path d="M5 11a7 7 0 0 0 14 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          <path d="M12 18v4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        </svg>
        <svg class="mic-icon mic-icon--off" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 2a3 3 0 0 0-3 3v4l6 6V5a3 3 0 0 0-3-3Z" fill="currentColor"/>
          <path d="M19 11a7 7 0 0 1-11.3 5.55L9 15a5 5 0 0 0 8-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          <path d="M12 18v4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          <path d="M3 3l18 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        </svg>
        <span class="sr-only" id="voice-mic-label">Mute</span>
      </button>
      <p class="call-hint" id="voice-call-hint">Click Place Call to talk to Jarvis.</p>
    </div>
    <div class="voice-settings-sheet" id="voice-settings-sheet" role="dialog" aria-label="Call settings" aria-modal="false" hidden>
      <div class="voice-settings-header">
        <span>Call settings</span>
        <button class="icon-btn" id="voice-settings-close" aria-label="Close settings" title="Close">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="currentColor"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>
        </button>
      </div>
      <div class="voice-settings-body">
        <div class="voice-control-row">
          <span class="voice-control-label">Persona</span>
          <div class="segmented persona-seg" role="tablist" id="voice-persona-seg"></div>
        </div>
        <div class="voice-control-row noise-row">
          <span class="voice-control-label">Noise</span>
          <select class="select" id="voice-noise" data-agent-id="voice.noise">
            <option value="off">Off</option>
            <option value="phone">Phone line hiss</option>
            <option value="office" selected>Office chatter</option>
            <option value="static">Static</option>
          </select>
          <input class="slider" type="range" id="voice-noise-vol" data-agent-id="voice.noise_volume" min="0" max="100" value="15" aria-label="Noise volume" />
        </div>
        <div class="voice-control-row">
          <label class="toggle" for="voice-phone" title="Narrowband phone compression">
            <input type="checkbox" id="voice-phone" data-agent-id="voice.phone_compression" checked />
            <span class="track"></span>
            <span>Phone-line compression</span>
          </label>
          <div class="spacer"></div>
          <input class="slider" type="range" id="voice-volume" data-agent-id="voice.output_volume" min="0" max="150" value="100" aria-label="Agent output volume" />
        </div>
        <div class="voice-control-row" role="radiogroup" aria-label="Listening mode">
          <span class="voice-control-label">Mode</span>
          <div class="segmented mode-seg" id="voice-mode-seg">
            <button role="radio" type="button" data-mode="live" data-agent-id="voice.mode.live" aria-checked="true" title="Place Call mode — default.">
              <span>Place Call</span>
            </button>
            <button role="radio" type="button" data-mode="wakeword" data-agent-id="voice.mode.wakeword" aria-checked="false" title="Wake word ('Hey Jarvis') — advanced.">
              <span>Wake Word</span>
            </button>
          </div>
        </div>
        <p class="voice-settings-note" id="voice-mode-note"></p>
        <div class="voice-control-row voice-settings-actions">
          <button class="btn btn--ghost btn--sm" id="voice-clear" data-agent-id="voice.clear_transcript">Clear transcript</button>
        </div>
        <div class="voice-control-row debug-panel" id="voice-debug-panel" hidden>
          <span class="voice-control-label">Debug</span>
          <pre class="debug-metrics" id="voice-debug-metrics"></pre>
        </div>
      </div>
    </div>
  `;
  return dock;
}

// --- Header + skip link ---

function buildHeader() {
  if (document.querySelector('.app-header')) return;
  const header = document.createElement('header');
  header.className = 'app-header';
  header.innerHTML = `
    <div class="app-brand" data-agent-id="nav.brand">
      <span class="dot" aria-hidden="true"></span>
      <span>HappyRobot FreightOps</span>
    </div>
    <nav class="app-nav" aria-label="Primary">
      <a href="/" data-agent-id="nav.dispatch">Dispatch</a>
      <a href="/carriers.html" data-agent-id="nav.carriers">Carriers</a>
      <a href="/negotiate.html" data-agent-id="nav.negotiate">Negotiate</a>
      <a href="/contact.html" data-agent-id="nav.contact">Contact</a>
    </nav>
    <div class="app-header-right">
      <span class="mono-id" id="header-model"></span>
      <a href="#voice-dock" class="btn btn--ghost btn--sm" data-agent-id="nav.voice_dock" data-external>Voice</a>
    </div>
  `;
  document.body.insertBefore(header, document.body.firstChild);
  fetch('/api/config').then((r) => r.json()).then((cfg) => {
    const el = document.getElementById('header-model');
    if (el && cfg && cfg.model) el.textContent = cfg.model;
  }).catch(() => {});
}

function buildSkipLink() {
  if (document.querySelector('.skip-link')) return;
  const link = document.createElement('a');
  link.className = 'skip-link';
  link.href = '#main';
  link.setAttribute('data-external', 'true');
  link.textContent = 'Skip to main content';
  document.body.insertBefore(link, document.body.firstChild);
}

// --- State rendering (single sink) ---

function setPill(state, detail) {
  const pill = $('#voice-status-pill');
  const strip = $('#voice-status-strip');
  const txt = $('#voice-status-text');
  const label = pill && pill.querySelector('.label');
  if (!pill || !strip) return;
  pill.setAttribute('data-state', state);
  strip.setAttribute('data-state', state);
  const copy = STATE_COPY[state] || state || 'Not connected';
  if (label) label.textContent = copy;
  if (txt) txt.textContent = copy;
}

/** Render the Place/End/Cancel/Ending-call button for the given state. */
function renderCallButton(state) {
  const btn = $('#voice-call-btn');
  const label = $('#voice-call-btn-label');
  const hint = $('#voice-call-hint');
  const mic = $('#voice-mic');
  if (!btn || !label) return;

  const inCall = IS_IN_CALL_STATES.has(state);
  const dialing = IS_DIALING_STATES.has(state) || state === STATES.LIVE_OPENING;
  const closing = IS_CLOSING_STATES.has(state);
  const reconnecting = state === STATES.RECONNECTING;
  const error = state === STATES.ERROR;

  btn.classList.remove('call-btn--place', 'call-btn--end', 'call-btn--cancel', 'call-btn--closing', 'call-btn--reconnect');
  btn.disabled = false;

  if (closing) {
    btn.classList.add('call-btn--closing');
    btn.setAttribute('data-call-state', 'closing');
    btn.disabled = true;
    label.textContent = 'Ending…';
    btn.setAttribute('aria-label', 'Ending call');
    if (hint) hint.textContent = 'Wrapping up.';
  } else if (dialing) {
    btn.classList.add('call-btn--cancel');
    btn.setAttribute('data-call-state', 'cancel');
    label.textContent = 'Cancel';
    btn.setAttribute('aria-label', 'Cancel dialing');
    if (hint) hint.textContent = state === STATES.DIALING ? 'Dialing…' : 'Connecting…';
  } else if (inCall || reconnecting) {
    btn.classList.add(reconnecting ? 'call-btn--reconnect' : 'call-btn--end');
    btn.setAttribute('data-call-state', reconnecting ? 'reconnect' : 'end');
    label.textContent = reconnecting ? 'End Call' : 'End Call';
    btn.setAttribute('aria-label', 'End call');
    if (hint) hint.textContent = reconnecting ? 'Reconnecting — still on the call.' : 'On the call. Press M to mute.';
  } else {
    btn.classList.add('call-btn--place');
    btn.setAttribute('data-call-state', 'idle');
    label.textContent = error ? 'Try Again' : 'Place Call';
    btn.setAttribute('aria-label', error ? 'Try placing the call again' : 'Place a call to Jarvis');
    if (hint) {
      if (error) hint.textContent = 'Call failed. Tap Try Again.';
      else if (state === STATES.ARMING) hint.textContent = 'Wake word armed. Say "Hey Jarvis" or tap Place Call.';
      else hint.textContent = 'Click Place Call to talk to Jarvis.';
    }
  }

  // Mic button only visible while in-call.
  if (mic) {
    mic.hidden = !(inCall || reconnecting || state === STATES.LIVE_OPENING || state === STATES.DIALING);
  }

  // Live chip only during an active call.
  const chip = $('#voice-live-chip');
  if (chip) chip.hidden = !(inCall || reconnecting || state === STATES.DIALING || state === STATES.LIVE_OPENING);
}

function setMutedBadge(muted) {
  const chip = $('#voice-muted-chip');
  const btn = $('#voice-mic');
  if (chip) chip.hidden = !muted;
  if (btn) {
    btn.classList.toggle('is-muted', muted);
    btn.setAttribute('aria-pressed', muted ? 'true' : 'false');
  }
}

function setModeSegmented(mode) {
  document.querySelectorAll('#voice-mode-seg button').forEach((b) => {
    const active = b.getAttribute('data-mode') === mode;
    b.setAttribute('aria-checked', active ? 'true' : 'false');
    b.classList.toggle('is-active', active);
  });
  const note = $('#voice-mode-note');
  if (note) {
    note.textContent = mode === 'wakeword'
      ? 'Wake Word: say "Hey Jarvis" to start a call. Not supported on iOS Safari.'
      : 'Place Call: click the big button to start a call. Default.';
  }
}

// --- Live timer ---

function startLiveTimer(agent) {
  const el = $('#voice-live-timer');
  if (!el) return () => {};
  let running = true;
  function tick() {
    if (!running) return;
    if (!agent.isInCall() && agent.getState() !== STATES.DIALING && agent.getState() !== STATES.RECONNECTING) {
      el.textContent = '0:00';
    } else {
      const ms = agent.getMetrics().liveElapsedMs;
      const s = Math.floor(ms / 1000);
      el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }
    setTimeout(tick, 500);
  }
  tick();
  return () => { running = false; };
}

// --- Error + playback-blocked banner ---

function showError(code, message) {
  const el = $('#voice-error');
  if (!el) return;
  el.replaceChildren();
  if (!code) { el.hidden = true; return; }
  const FRIENDLY = {
    invalid_key: ['Gemini rejected the API key. Set a valid ', 'GEMINI_API_KEY', ' and restart the server.'],
    model_unavailable: ['Configured Live model is not available. Set ', 'GEMINI_LIVE_MODEL', ' or accept the fallback.'],
    mic_denied: ['Microphone access was denied. Click the mic icon in your browser bar, grant access, then reload.'],
    mic_ended: ['Microphone was disconnected. Reconnect your mic and try again.'],
    mic_failed: ['Could not start the microphone.'],
    ws_disconnected: ['Voice connection lost. Tap Try Again.'],
    rate_limited: ['Rate-limited. Slow down and try again shortly.'],
    dial_timeout: ['Could not connect in time. Check your API key and network, then tap Try Again.']
  };
  const spec = FRIENDLY[code];
  if (spec) {
    spec.forEach((chunk, i) => {
      if (i % 2 === 1) {
        const c = document.createElement('code');
        c.textContent = chunk;
        el.appendChild(c);
      } else {
        el.appendChild(document.createTextNode(chunk));
      }
    });
  } else {
    el.appendChild(document.createTextNode(message ? String(message) : `Error: ${code}`));
  }
  el.hidden = false;
}

let _playbackHintShown = false;
function showPlaybackBlockedHint(agent) {
  if (_playbackHintShown) return;
  const el = document.getElementById('voice-error');
  if (!el) return;
  _playbackHintShown = true;
  el.replaceChildren();
  el.appendChild(document.createTextNode('Click to enable audio playback. '));
  const enable = document.createElement('button');
  enable.textContent = 'Enable audio';
  enable.setAttribute('data-agent-id', 'voice.enable_playback');
  enable.style.marginLeft = '8px';
  enable.addEventListener('click', async () => { try { await agent.unlockAudio(); } catch {} });
  el.appendChild(enable);
  el.hidden = false;
  const t = setInterval(() => {
    if (!agent.pipeline.isPlaybackBlocked()) {
      clearInterval(t);
      _playbackHintShown = false;
      el.hidden = true;
      el.replaceChildren();
    }
  }, 300);
  setTimeout(() => clearInterval(t), 30_000);
}

// --- VU meter ---

function wireVuMeter(agent) {
  const bars = document.querySelectorAll('#voice-status-strip .voice-vu .bar');
  if (!bars.length) return;
  function tick() {
    const inCall = agent.isInCall();
    const level = inCall && !agent.isMuted()
      ? agent.pipeline.readMicLevel()
      : agent.pipeline.readVuLevel();
    bars.forEach((b, i) => {
      const weight = [0.35, 0.55, 0.75, 0.9, 1.0][i] || 1;
      const h = Math.max(4, Math.round(4 + level * 18 * weight));
      b.style.height = h + 'px';
    });
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

// --- Persona buttons ---

function buildPersonaButtons(container, personas, current, onSelect) {
  if (!container) return;
  container.innerHTML = '';
  personas.forEach((p) => {
    const btn = document.createElement('button');
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-pressed', p.id === current ? 'true' : 'false');
    btn.setAttribute('data-persona-id', p.id);
    btn.setAttribute('data-agent-id', `voice.persona.${p.id}`);
    btn.style.setProperty('--persona-color', p.dotColor);
    btn.innerHTML = '<span class="persona-dot" aria-hidden="true"></span>';
    const label = document.createElement('span');
    label.textContent = p.label;
    btn.appendChild(label);
    btn.addEventListener('click', () => onSelect(p.id));
    container.appendChild(btn);
  });
}

// --- Debug panel ---

function wireDebugPanel(agent) {
  if (!DEBUG) return;
  const panel = $('#voice-debug-panel');
  const pre = $('#voice-debug-metrics');
  if (!panel || !pre) return;
  panel.hidden = false;
  function tick() {
    const m = agent.getMetrics();
    pre.textContent =
      `state=${m.state} mode=${m.mode} muted=${m.muted}\n` +
      `ws=${m.wsState} ctx=${m.ctxState} cap=${m.captureState}\n` +
      `audioIn=${m.framesIn}f/${m.audioBytesIn}B out=${m.framesOut}f/${m.audioBytesOut}B\n` +
      `tools=${m.toolCalls} reconnects=${m.reconnects} calls=${m.callsPlaced}\n` +
      `live=${(m.liveElapsedMs/1000)|0}s setup=${m.setupComplete} greet=${m.greetingSent}`;
    setTimeout(tick, 500);
  }
  tick();
}

// --- Settings sheet open/close ---

function openSettings() {
  const sheet = $('#voice-settings-sheet');
  const btn = $('#voice-settings');
  if (!sheet) return;
  sheet.hidden = false;
  sheet.classList.add('is-open');
  if (btn) btn.setAttribute('aria-expanded', 'true');
  const closer = $('#voice-settings-close');
  if (closer) closer.focus();
}
function closeSettings() {
  const sheet = $('#voice-settings-sheet');
  const btn = $('#voice-settings');
  if (!sheet) return;
  sheet.classList.remove('is-open');
  sheet.hidden = true;
  if (btn) { btn.setAttribute('aria-expanded', 'false'); btn.focus(); }
}

// --- Bootstrap ---

/** Build the persistent chrome + instantiate the VoiceAgent exactly once. */
export async function bootstrapVoiceShell() {
  buildSkipLink();
  buildHeader();

  const dock = buildDockMarkup();
  document.body.appendChild(dock);

  const transcriptEl = $('#voice-transcript');
  const agent = new VoiceAgent({ transcriptEl });

  // --- Persona
  const personaContainer = $('#voice-persona-seg');
  buildPersonaButtons(personaContainer, agent.getPersonas(), agent.getCurrentPersonaId(), (id) => {
    agent.setPersona(id);
    document.querySelectorAll('#voice-persona-seg button').forEach((b) => {
      b.setAttribute('aria-pressed', b.getAttribute('data-persona-id') === id ? 'true' : 'false');
    });
  });
  agent.addEventListener('personas-ready', (e) => {
    buildPersonaButtons(personaContainer, e.detail.personas, agent.getCurrentPersonaId(), (id) => {
      agent.setPersona(id);
      document.querySelectorAll('#voice-persona-seg button').forEach((b) => {
        b.setAttribute('aria-pressed', b.getAttribute('data-persona-id') === id ? 'true' : 'false');
      });
    });
  });

  // --- Single state sink
  agent.addEventListener('state', (e) => {
    const { state, detail } = e.detail;
    setPill(state, detail);
    renderCallButton(state);
    if (state === STATES.ERROR) showError(detail);
    else if (state !== STATES.RECONNECTING) showError(null);
    if (state === STATES.MODEL_SPEAKING && agent.pipeline.isPlaybackBlocked()) {
      showPlaybackBlockedHint(agent);
    }
  });

  agent.addEventListener('mute-changed', (e) => setMutedBadge(!!e.detail.muted));
  agent.addEventListener('mode-changed', (e) => setModeSegmented(e.detail.mode));

  // --- Place / End Call button. SYNCHRONOUS unlock on click.
  const callBtn = $('#voice-call-btn');
  on(callBtn, 'click', async () => {
    // unlockAudioSync must run BEFORE any await.
    try { agent.unlockAudioSync(); } catch {}
    const state = agent.getState();
    if (IS_IN_CALL_STATES.has(state) || state === STATES.RECONNECTING) {
      await agent.endCall();
    } else if (state === STATES.DIALING || state === STATES.LIVE_OPENING) {
      await agent.cancelDial();
    } else if (state === STATES.CLOSING) {
      /* ignore */
    } else {
      await agent.placeCall();
    }
  });

  // Enter / Space on the call button also toggles the call (buttons do
  // this natively, but we also bind a document-level shortcut for
  // accessibility when the button is focused elsewhere).
  on(document, 'keydown', (e) => {
    if (e.code !== 'Space' && e.code !== 'Enter') return;
    if (document.activeElement !== callBtn) return;
    // Let the native button click handler run.
  });

  // --- Mic mute button (visible only during active call).
  const micBtn = $('#voice-mic');
  on(micBtn, 'click', () => {
    if (!agent.isInCall()) return;
    try { agent.unlockAudioSync(); } catch {}
    agent.toggleMuted();
  });

  // --- Settings sheet
  const settingsBtn = $('#voice-settings');
  const settingsClose = $('#voice-settings-close');
  on(settingsBtn, 'click', () => {
    if ($('#voice-settings-sheet').classList.contains('is-open')) closeSettings();
    else openSettings();
  });
  on(settingsClose, 'click', () => closeSettings());
  // Close on Esc.
  on(document, 'keydown', (e) => {
    if (e.code === 'Escape' && $('#voice-settings-sheet').classList.contains('is-open')) closeSettings();
  });

  // --- Mode toggle (inside settings). Disabled during an active call.
  const modeBtns = document.querySelectorAll('#voice-mode-seg button');
  modeBtns.forEach((b) => on(b, 'click', () => {
    if (agent.isInCall() || agent.getState() === STATES.DIALING || agent.getState() === STATES.CLOSING) return;
    agent.setMode(b.getAttribute('data-mode'));
  }));
  setModeSegmented(agent.getMode());

  // Disable Wake Word on iOS Safari (SpeechRecognition unreliable).
  if (isIosSafari()) {
    const wakeBtn = document.querySelector('#voice-mode-seg button[data-mode="wakeword"]');
    if (wakeBtn) {
      wakeBtn.disabled = true;
      wakeBtn.title = 'Wake Word is not supported on iOS Safari.';
      wakeBtn.setAttribute('aria-disabled', 'true');
    }
    if (agent.getMode() === 'wakeword') {
      agent.setMode('live');
    }
  }

  // --- Noise + volume + phone compression
  const noiseSel = $('#voice-noise');
  noiseSel.value = agent.getNoiseMode();
  on(noiseSel, 'change', () => agent.setNoiseMode(noiseSel.value));
  const noiseVol = $('#voice-noise-vol');
  noiseVol.value = String(Math.round((agent.getNoiseVolume() || 0) * 100));
  on(noiseVol, 'input', () => agent.setNoiseVolume(Number(noiseVol.value) / 100));
  const phoneToggle = $('#voice-phone');
  phoneToggle.checked = !!agent.getCompressionEnabled();
  on(phoneToggle, 'change', () => agent.setCompressionEnabled(phoneToggle.checked));
  const volume = $('#voice-volume');
  on(volume, 'input', () => agent.pipeline.setOutputVolume(Number(volume.value) / 100));

  // --- Dock collapse + clear
  const collapseBtn = $('#voice-dock-toggle');
  on(collapseBtn, 'click', () => {
    const d = $('#voice-dock');
    const expanded = d.classList.toggle('is-collapsed');
    collapseBtn.setAttribute('aria-expanded', expanded ? 'false' : 'true');
  });
  const clearBtn = $('#voice-clear');
  if (clearBtn) on(clearBtn, 'click', () => agent.clearTranscript());

  // --- Elements rescan.
  const rescan = debounce(() => agent.sendElementsSnapshot(), 400);
  const mo = new MutationObserver((mutations) => {
    const dockEl = document.getElementById('voice-dock');
    const significant = mutations.some((m) => !dockEl || !dockEl.contains(m.target));
    if (significant) rescan();
  });
  const observeRoot = document.getElementById('route-target') || document.body;
  mo.observe(observeRoot, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-agent-id'] });

  // --- Graceful-degradation banners
  if (!window.AudioWorkletNode) {
    showError('unsupported_browser', 'Your browser is missing AudioWorklet. Use a recent Chrome or Edge.');
  }
  agent.addEventListener('wake-ready', (e) => {
    if (!e.detail.supported && agent.getMode() === 'wakeword') {
      agent.setMode('live');
    }
  });

  // --- Unlock AudioContext on first gesture (fallback for anything
  //     other than the Place Call button — e.g. user clicks a nav link
  //     before calling).
  const firstGesture = () => {
    try { agent.unlockAudioSync(); } catch {}
    agent.pipeline.setNoiseMode(agent.getNoiseMode());
    agent.pipeline.setOutputVolume(Number(volume.value) / 100);
    agent.pipeline.setNoiseVolume(agent.getNoiseVolume());
    agent.pipeline.setBandPassEnabled(agent.getCompressionEnabled());
    wireVuMeter(agent);
    document.removeEventListener('click', firstGesture);
    document.removeEventListener('keydown', firstGesture);
  };
  document.addEventListener('click', firstGesture, { once: false });
  document.addEventListener('keydown', firstGesture, { once: false });

  startLiveTimer(agent);

  await agent.init();
  setPill(agent.getState());
  renderCallButton(agent.getState());
  setModeSegmented(agent.getMode());
  setMutedBadge(agent.isMuted());
  wireDebugPanel(agent);

  // Nav breadcrumb (from previous agent-initiated page navigation).
  try {
    const note = sessionStorage.getItem('jarvis.lastNavNote');
    if (note) {
      sessionStorage.removeItem('jarvis.lastNavNote');
      if (agent.transcript) agent.transcript.add({ from: 'system', text: note });
    }
  } catch {}

  return agent;
}

function debounce(fn, ms) {
  let t;
  return function () { clearTimeout(t); t = setTimeout(fn, ms); };
}
