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
//
// "Harbor Bridge" voice dock. Five stacked rows when expanded:
//   1. Header     — brand + state pill + chips + icon actions
//   2. Scope      — canvas-driven radar visualiser + VU baton
//   3. Transcript — ledger-ruled conversation feed
//   4. Quick chips — in-call horizontal chip strip (mounted by quick-chips.js)
//   5. Action      — Place / End call button + mute + hint + kbd pips
//
// Settings sheet slides in from the right of the dock (desktop) or occupies
// the full bottom-sheet (mobile). Uses a tabbed layout (Voice / Agent /
// Transcript / Theme) but every control ID from the old single-column layout
// is preserved so no JS wiring breaks.

function buildDockMarkup() {
  const dock = document.createElement('section');
  dock.className = 'voice-dock';
  dock.id = 'voice-dock';
  dock.setAttribute('aria-label', 'Voice agent');
  dock.innerHTML = `
    <div class="voice-dock-halo" aria-hidden="true"></div>
    <div class="voice-dock-grab" aria-hidden="true"></div>

    <header class="voice-dock-header">
      <div class="voice-dock-brand">
        <span class="voice-dock-radar" aria-hidden="true">
          <span class="voice-dock-radar-dot"></span>
        </span>
        <span class="voice-dock-brand-name">Jarvis</span>
      </div>
      <div class="voice-dock-header-chips">
        <span class="voice-status-pill" id="voice-status-pill" data-state="idle" aria-live="polite">
          <span class="voice-status-pill-dot" aria-hidden="true"></span>
          <span class="voice-status-pill-label label">Stand by</span>
        </span>
        <span class="voice-chip voice-chip--live" id="voice-live-chip" hidden>
          <span class="voice-chip-dot" aria-hidden="true"></span>
          <span class="voice-chip-label">LIVE</span>
          <span class="voice-chip-timer mono" id="voice-live-timer">0:00</span>
        </span>
        <span class="voice-chip voice-chip--muted" id="voice-muted-chip" hidden>
          <span class="voice-chip-dot" aria-hidden="true"></span>
          <span class="voice-chip-label">Muted</span>
        </span>
        <span class="voice-chip voice-chip--ambient voice-ambient-chip" id="voice-ambient-chip" data-agent-id="voice.ambient_chip" hidden>
          <span class="voice-chip-dot" aria-hidden="true"></span>
          <span class="voice-chip-label">Ambient</span>
        </span>
      </div>
      <div class="voice-dock-header-actions">
        <button class="voice-icon-btn icon-btn" id="voice-settings" aria-label="Call settings" aria-expanded="false" aria-controls="voice-settings-sheet" title="Call settings" data-agent-id="voice.settings">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1A1.7 1.7 0 0 0 10 3.1V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>
          </svg>
        </button>
        <button class="voice-icon-btn voice-icon-btn--collapse icon-btn" id="voice-dock-toggle" aria-expanded="true" aria-controls="voice-dock-body" data-agent-id="voice.dock.collapse" title="Collapse voice panel">
          <svg class="voice-icon voice-icon--collapse" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M6 14l6 6 6-6"/>
            <path d="M6 10l6-6 6 6"/>
          </svg>
          <svg class="voice-icon voice-icon--expand" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M6 9l6 6 6-6"/>
          </svg>
          <span class="sr-only">Collapse voice panel</span>
        </button>
      </div>
    </header>

    <div class="voice-error-banner" id="voice-error" role="alert" hidden></div>

    <div class="voice-dock-body" id="voice-dock-body">
      <section class="voice-scope" id="voice-status-strip" data-state="idle" aria-hidden="true">
        <canvas class="voice-scope-canvas" aria-hidden="true"></canvas>
        <svg class="voice-scope-compass" viewBox="0 0 280 140" aria-hidden="true" preserveAspectRatio="xMidYMid meet">
          <defs>
            <radialGradient id="voice-scope-gradient" cx="50%" cy="50%" r="55%">
              <stop offset="0%" stop-color="var(--color-accent, #F7B32B)" stop-opacity="0.10"/>
              <stop offset="70%" stop-color="var(--color-accent, #F7B32B)" stop-opacity="0"/>
            </radialGradient>
          </defs>
          <g transform="translate(140 70)">
            <circle r="58" fill="url(#voice-scope-gradient)"/>
            <circle class="voice-scope-ring voice-scope-ring--outer" r="58" fill="none" stroke="currentColor" stroke-width="0.6" stroke-opacity="0.32"/>
            <circle class="voice-scope-ring" r="40" fill="none" stroke="currentColor" stroke-width="0.4" stroke-opacity="0.22"/>
            <circle class="voice-scope-ring" r="22" fill="none" stroke="currentColor" stroke-width="0.4" stroke-opacity="0.20"/>
            <g class="voice-scope-ticks" stroke="currentColor" stroke-opacity="0.35" stroke-linecap="round">
              <line x1="0" y1="-58" x2="0" y2="-50" stroke-width="1.1"/>
              <line x1="58" y1="0" x2="50" y2="0" stroke-width="1.1"/>
              <line x1="0" y1="58" x2="0" y2="50" stroke-width="1.1"/>
              <line x1="-58" y1="0" x2="-50" y2="0" stroke-width="1.1"/>
              <line x1="29" y1="-50.23" x2="25.12" y2="-43.5" stroke-width="0.5"/>
              <line x1="50.23" y1="-29" x2="43.5" y2="-25.12" stroke-width="0.5"/>
              <line x1="50.23" y1="29" x2="43.5" y2="25.12" stroke-width="0.5"/>
              <line x1="29" y1="50.23" x2="25.12" y2="43.5" stroke-width="0.5"/>
              <line x1="-29" y1="50.23" x2="-25.12" y2="43.5" stroke-width="0.5"/>
              <line x1="-50.23" y1="29" x2="-43.5" y2="25.12" stroke-width="0.5"/>
              <line x1="-50.23" y1="-29" x2="-43.5" y2="-25.12" stroke-width="0.5"/>
              <line x1="-29" y1="-50.23" x2="-25.12" y2="-43.5" stroke-width="0.5"/>
            </g>
            <line class="voice-scope-needle" x1="0" y1="0" x2="0" y2="-58" stroke-linecap="round" stroke-width="1.4"/>
            <circle class="voice-scope-hub" r="3" fill="currentColor"/>
          </g>
        </svg>
        <div class="voice-vu" aria-hidden="true">
          <span class="bar"></span><span class="bar"></span><span class="bar"></span><span class="bar"></span><span class="bar"></span>
        </div>
        <div class="voice-scope-readout">
          <span class="voice-scope-readout-label">STATUS</span>
          <span class="voice-status-text" id="voice-status-text">Stand by</span>
          <span class="voice-scope-readout-sep" aria-hidden="true">·</span>
          <span class="voice-scope-readout-label">SESS</span>
          <span class="mono-id voice-scope-readout-id" id="voice-session-id">—</span>
        </div>
      </section>

      <section class="voice-transcript-pane">
        <div class="voice-transcript" id="voice-transcript" aria-live="polite" aria-label="Conversation transcript"></div>
        <p class="voice-transcript-hint" id="voice-transcript-hint" hidden>Agent speech not transcribed (configured to save credits).</p>
        <p class="voice-transcript-hidden" id="voice-transcript-hidden" hidden>Transcripts hidden by configuration (SHOW_TEXT=false).</p>
      </section>
    </div>

    <div class="voice-dock-action">
      <div class="voice-dock-action-row">
        <button class="voice-call-btn call-btn call-btn--place call-btn--idle" id="voice-call-btn" data-agent-id="voice.call_btn" data-call-state="idle" type="button">
          <span class="voice-call-btn-inner">
            <span class="voice-call-btn-icons" aria-hidden="true">
              <svg class="call-btn-icon call-btn-icon--phone" viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
                <path d="M6.6 10.8a15.5 15.5 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.6 1 1 0 0 1 1 1v3.5a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1 11.4 11.4 0 0 0 .6 3.6 1 1 0 0 1-.25 1l-2.25 2.2Z"/>
              </svg>
              <svg class="call-btn-icon call-btn-icon--end" viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
                <path d="M12 9c-3.6 0-7 1-9.4 2.6a1 1 0 0 0-.3 1.4l1.8 2.4a1 1 0 0 0 1.2.3L7.2 15a1 1 0 0 0 .6-.9V12a11 11 0 0 1 8.4 0v2.1a1 1 0 0 0 .6.9l1.9.8a1 1 0 0 0 1.2-.3l1.8-2.4a1 1 0 0 0-.3-1.4C19 10 15.6 9 12 9Z"/>
              </svg>
              <svg class="call-btn-icon call-btn-icon--cancel" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
                <path d="M6 6l12 12M18 6 6 18"/>
              </svg>
            </span>
            <span class="voice-call-btn-label call-btn-label" id="voice-call-btn-label">Place Call</span>
          </span>
        </button>
        <button class="voice-mic-btn mic-btn mic-btn--inline" id="voice-mic" data-agent-id="voice.mic" aria-pressed="false" title="Mute (M)" hidden>
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
      </div>
      <div class="voice-dock-action-footer">
        <p class="voice-call-hint call-hint" id="voice-call-hint">Click Place Call to talk to Jarvis.</p>
        <ul class="voice-kbd-hints" aria-label="Keyboard shortcuts">
          <li><kbd class="voice-kbd">Space</kbd><span>call</span></li>
          <li><kbd class="voice-kbd">M</kbd><span>mute</span></li>
          <li><kbd class="voice-kbd">Esc</kbd><span>close</span></li>
          <li><kbd class="voice-kbd">⌘K</kbd><span>cmd</span></li>
          <li><kbd class="voice-kbd">/</kbd><span>focus</span></li>
        </ul>
      </div>
    </div>

    <aside class="voice-settings-sheet" id="voice-settings-sheet" role="dialog" aria-modal="true" aria-labelledby="voice-settings-title" aria-hidden="true" hidden>
      <div class="voice-settings-grab" aria-hidden="true"></div>
      <header class="voice-settings-header">
        <h2 id="voice-settings-title" class="voice-settings-title">Call settings</h2>
        <button class="voice-icon-btn icon-btn" id="voice-settings-close" aria-label="Close settings" title="Close">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>
        </button>
      </header>

      <nav class="voice-settings-tabs" role="tablist" aria-label="Settings sections">
        <button class="voice-settings-tab is-active" role="tab" type="button" data-settings-tab="voice" aria-selected="true" aria-controls="voice-settings-panel-voice">Voice</button>
        <button class="voice-settings-tab" role="tab" type="button" data-settings-tab="agent" aria-selected="false" aria-controls="voice-settings-panel-agent">Agent</button>
        <button class="voice-settings-tab" role="tab" type="button" data-settings-tab="transcript" aria-selected="false" aria-controls="voice-settings-panel-transcript">Transcript</button>
        <button class="voice-settings-tab" role="tab" type="button" data-settings-tab="theme" aria-selected="false" aria-controls="voice-settings-panel-theme">Theme</button>
      </nav>

      <div class="voice-settings-body">
        <section class="voice-settings-panel is-active" id="voice-settings-panel-voice" role="tabpanel" data-settings-panel="voice" aria-labelledby="voice-settings-tab-voice">
          <div class="voice-control-row" role="radiogroup" aria-label="Listening mode">
            <span class="voice-control-label label-caps">Mode</span>
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

          <div class="voice-control-row noise-row">
            <span class="voice-control-label label-caps">Noise</span>
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
              <span class="label-caps">Phone-line compression</span>
            </label>
          </div>

          <div class="voice-control-row compression-strength-row">
            <span class="voice-control-label label-caps">Strength</span>
            <input
              class="slider"
              type="range"
              id="voice-compression-strength"
              data-agent-id="voice.compression_strength"
              min="0" max="100" step="1" value="50"
              aria-label="Phone-line compression strength"
              aria-valuemin="0" aria-valuemax="100" aria-valuenow="50"
              aria-describedby="voice-compression-strength-readout"
            />
            <span class="compression-strength-readout mono" id="voice-compression-strength-readout" aria-live="polite">50%</span>
          </div>

          <div class="voice-control-row">
            <span class="voice-control-label label-caps">Volume</span>
            <input class="slider" type="range" id="voice-volume" data-agent-id="voice.output_volume" min="0" max="150" value="100" aria-label="Agent output volume" />
          </div>
        </section>

        <section class="voice-settings-panel" id="voice-settings-panel-agent" role="tabpanel" data-settings-panel="agent" aria-labelledby="voice-settings-tab-agent" hidden>
          <div class="voice-control-row voice-control-row--stack">
            <span class="voice-control-label label-caps">Persona</span>
            <div class="segmented persona-seg" role="tablist" id="voice-persona-seg"></div>
          </div>
        </section>

        <section class="voice-settings-panel" id="voice-settings-panel-transcript" role="tabpanel" data-settings-panel="transcript" aria-labelledby="voice-settings-tab-transcript" hidden>
          <div class="voice-control-row" role="radiogroup" aria-label="Transcript mode">
            <span class="voice-control-label label-caps">Mode</span>
            <div class="segmented transcript-seg" id="voice-transcript-seg" data-agent-id="transcript.mode_seg">
              <button role="radio" type="button" data-mode="off" data-agent-id="transcript.mode.off" aria-checked="true">Off</button>
              <button role="radio" type="button" data-mode="captions" data-agent-id="transcript.mode.captions" aria-checked="false">Captions</button>
              <button role="radio" type="button" data-mode="full" data-agent-id="transcript.mode.full" aria-checked="false">Full</button>
            </div>
          </div>
          <p class="voice-settings-note" id="voice-transcript-note"></p>
          <div class="voice-control-row voice-settings-actions">
            <button class="btn btn--ghost btn--sm" id="voice-clear" data-agent-id="voice.clear_transcript">Clear transcript</button>
          </div>
        </section>

        <section class="voice-settings-panel" id="voice-settings-panel-theme" role="tabpanel" data-settings-panel="theme" aria-labelledby="voice-settings-tab-theme" hidden>
          <div class="voice-control-row" role="radiogroup" aria-label="Theme">
            <span class="voice-control-label label-caps">Theme</span>
            <div class="segmented theme-seg" id="voice-theme-seg" data-agent-id="theme.toggle">
              <button role="radio" type="button" data-theme-value="dark" data-agent-id="theme.dark" aria-checked="false">Dark</button>
              <button role="radio" type="button" data-theme-value="light" data-agent-id="theme.light" aria-checked="false">Light</button>
              <button role="radio" type="button" data-theme-value="system" data-agent-id="theme.system" aria-checked="false">System</button>
            </div>
          </div>
        </section>

        <section class="voice-control-row debug-panel" id="voice-debug-panel" hidden>
          <span class="voice-control-label label-caps">Debug</span>
          <pre class="debug-metrics mono" id="voice-debug-metrics"></pre>
        </section>
      </div>
    </aside>
  `;
  return dock;
}

// --- Header + skip link ---

function buildHeader() {
  if (document.querySelector('.app-header')) return;
  const header = document.createElement('header');
  header.className = 'app-header';
  header.innerHTML = `
    <a class="app-brand" href="/" data-agent-id="nav.brand" data-external>
      <span class="app-brand-mark" aria-hidden="true">
        <span class="app-brand-mark-dot"></span>
      </span>
      <span class="app-brand-name">
        <span class="app-brand-name-primary">Dhruv</span>
        <span class="app-brand-name-secondary">FreightOps</span>
      </span>
    </a>
    <nav class="app-nav" aria-label="Primary">
      <a href="/" data-agent-id="nav.dispatch">Dispatch</a>
      <a href="/carriers.html" data-agent-id="nav.carriers">Carriers</a>
      <a href="/negotiate.html" data-agent-id="nav.negotiate">Negotiate</a>
      <a href="/map.html" data-agent-id="nav.map">Map</a>
      <a href="/contact.html" data-agent-id="nav.contact">Contact</a>
    </nav>
    <div class="app-header-right">
      <a href="#voice-dock" class="btn btn--ghost btn--sm app-header-voice-link" data-agent-id="nav.voice_dock" data-external>
        <span class="app-header-voice-dot" aria-hidden="true"></span>
        <span>Voice</span>
      </a>
    </div>
  `;
  document.body.insertBefore(header, document.body.firstChild);
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

// Harbor Bridge pill copy per §6.3 of the design spec. Falls back to
// voice-agent's STATE_COPY when the state isn't in this table.
const PILL_COPY = Object.freeze({
  idle: 'Stand by',
  arming: 'Armed',
  dialing: 'Dialling…',
  live_opening: 'Connecting…',
  live_ready: 'Listening',
  model_thinking: 'Thinking',
  model_speaking: 'Jarvis speaks',
  tool_executing: 'Taking action…',
  closing: 'Hanging up',
  reconnecting: 'Reconnecting',
  error: 'Connection lost'
});

function setPill(state, detail) {
  const pill = $('#voice-status-pill');
  const strip = $('#voice-status-strip');
  const dock = $('#voice-dock');
  const txt = $('#voice-status-text');
  const label = pill && pill.querySelector('.label');
  if (!pill || !strip) return;
  pill.setAttribute('data-state', state);
  strip.setAttribute('data-state', state);
  if (dock) dock.setAttribute('data-state', state);
  const copy = PILL_COPY[state] || STATE_COPY[state] || state || 'Stand by';
  if (label) label.textContent = copy;
  if (txt) txt.textContent = copy;
}

/** Render the Place/End/Cancel/Ending-call button for the given state.
 *  Five data-call-state values: idle · cancel · end · reconnect · closing.
 *  Matching `call-btn--*` classes (legacy) and `call-btn--idle` added. */
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

  btn.classList.remove(
    'call-btn--place', 'call-btn--idle', 'call-btn--end',
    'call-btn--cancel', 'call-btn--closing', 'call-btn--reconnect'
  );
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
    if (hint) hint.textContent = state === STATES.DIALING ? 'Dialling Jarvis…' : 'Connecting…';
  } else if (reconnecting) {
    btn.classList.add('call-btn--reconnect');
    btn.setAttribute('data-call-state', 'reconnect');
    label.textContent = 'End Call';
    btn.setAttribute('aria-label', 'End call');
    if (hint) hint.textContent = 'Reconnecting — still on the call.';
  } else if (inCall) {
    btn.classList.add('call-btn--end');
    btn.setAttribute('data-call-state', 'end');
    label.textContent = 'End Call';
    btn.setAttribute('aria-label', 'End call');
    if (hint) hint.textContent = 'On the call. Press M to mute.';
  } else {
    btn.classList.add('call-btn--place', 'call-btn--idle');
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

// --- VU meter + Scope canvas ---

// Drives both (a) the five `.voice-vu .bar` children that the old contract
// requires, and (b) the new canvas "Scope" — a radar sweep + burst-dot
// visualisation whose glyph changes per voice-agent state. Runs as a
// single rAF loop. Safe if any of agent/pipeline/canvas are missing.
function wireVuMeter(agent) {
  const strip = document.getElementById('voice-status-strip');
  const bars = strip ? strip.querySelectorAll('.voice-vu .bar') : [];
  const canvas = strip ? strip.querySelector('.voice-scope-canvas') : null;
  const ctx = canvas ? canvas.getContext('2d') : null;

  const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  let cssW = 0, cssH = 0;

  function ensureCanvasSize() {
    if (!canvas) return false;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    if (w === cssW && h === cssH) return true;
    cssW = w; cssH = h;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    return true;
  }
  if (canvas) {
    ensureCanvasSize();
    window.addEventListener('resize', ensureCanvasSize);
  }

  // Rolling buffer of burst dots (radar pings).
  const BURSTS = [];
  const BURST_TTL = 1200; // ms

  // Rolling waveform window for idle bars (tiny history for smoother bars).
  const HIST_LEN = 32;
  const hist = new Array(HIST_LEN).fill(0);
  let histIdx = 0;

  let lastBurstAt = 0;
  let start = performance.now();

  function readLevel() {
    try {
      const inCall = agent.isInCall && agent.isInCall();
      const muted = agent.isMuted && agent.isMuted();
      if (inCall && !muted && agent.pipeline && agent.pipeline.readMicLevel) {
        return Math.min(1, Math.max(0, agent.pipeline.readMicLevel()));
      }
      if (agent.pipeline && agent.pipeline.readVuLevel) {
        return Math.min(1, Math.max(0, agent.pipeline.readVuLevel()));
      }
    } catch {}
    return 0;
  }

  function stateOf() {
    try {
      return agent.getState ? agent.getState() : 'idle';
    } catch { return 'idle'; }
  }

  // State → accent colour for canvas strokes. Kept in sync with §6.3.
  function stateColor(s) {
    const cs = getComputedStyle(document.documentElement);
    const pick = (v, fb) => (cs.getPropertyValue(v).trim() || fb);
    switch (s) {
      case 'live_ready':
      case 'listening':
        return pick('--color-state-listening', '#4FD1C5');
      case 'model_thinking':
      case 'thinking':
        return pick('--color-state-thinking', '#C39BE8');
      case 'model_speaking':
      case 'speaking':
        return pick('--color-state-speaking', '#F7B32B');
      case 'tool_executing':
        return pick('--color-state-tool', '#F59E3C');
      case 'error':
        return pick('--color-state-error', '#E15A4C');
      case 'dialing':
      case 'live_opening':
      case 'reconnecting':
        return pick('--color-warn', '#F59E3C');
      case 'closing':
        return pick('--color-text-dim', '#5B6675');
      default:
        return pick('--color-state-idle', '#5B6675');
    }
  }

  function tick(now) {
    // 1. Update bar heights (contract: five bars must animate).
    const level = readLevel();
    hist[histIdx] = level;
    histIdx = (histIdx + 1) % HIST_LEN;

    if (bars.length) {
      bars.forEach((b, i) => {
        const weight = [0.35, 0.55, 0.75, 0.9, 1.0][i] || 1;
        const h = Math.max(4, Math.round(4 + level * 22 * weight));
        b.style.height = h + 'px';
      });
    }

    // 2. Paint the scope canvas.
    if (ctx && canvas && cssW > 0 && cssH > 0) {
      ensureCanvasSize();
      const s = stateOf();
      const color = stateColor(s);
      const cx = cssW / 2;
      const cy = cssH / 2;
      const radius = Math.min(cssW, cssH) * 0.42;
      const t = (now - start) / 1000;

      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);

      // Radar sweep — only rotates when not reduced-motion. Speed varies
      // by state: fast during dialing, slow during listening.
      let sweepPeriod = 3.0;
      let drawSweep = true;
      if (s === 'dialing' || s === 'live_opening' || s === 'reconnecting') sweepPeriod = 1.2;
      else if (s === 'model_thinking' || s === 'thinking') sweepPeriod = 2.2;
      else if (s === 'model_speaking' || s === 'speaking') { drawSweep = false; }
      else if (s === 'tool_executing') sweepPeriod = 2.8;
      else if (s === 'error' || s === 'closing' || s === 'idle' || s === 'arming') drawSweep = false;

      if (drawSweep && !reducedMotion) {
        const sweepAngle = (t / sweepPeriod) * Math.PI * 2;
        const grad = ctx.createRadialGradient(
          cx + Math.cos(sweepAngle - Math.PI / 2) * radius * 0.3,
          cy + Math.sin(sweepAngle - Math.PI / 2) * radius * 0.3,
          2,
          cx, cy, radius
        );
        grad.addColorStop(0, withAlpha(color, 0.35));
        grad.addColorStop(1, withAlpha(color, 0));
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        const span = Math.PI / 3; // 60°
        ctx.arc(cx, cy, radius, sweepAngle - Math.PI / 2 - span, sweepAngle - Math.PI / 2);
        ctx.closePath();
        ctx.fill();

        // Leading edge.
        ctx.strokeStyle = withAlpha(color, 0.6);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(
          cx + Math.cos(sweepAngle - Math.PI / 2) * radius,
          cy + Math.sin(sweepAngle - Math.PI / 2) * radius
        );
        ctx.stroke();

        // Deposit burst dots when mic level spikes.
        if (level > 0.18 && now - lastBurstAt > 80) {
          lastBurstAt = now;
          const r = (0.4 + level * 0.55) * radius;
          BURSTS.push({
            x: cx + Math.cos(sweepAngle - Math.PI / 2) * r,
            y: cy + Math.sin(sweepAngle - Math.PI / 2) * r,
            born: now,
            life: BURST_TTL
          });
          if (BURSTS.length > 40) BURSTS.shift();
        }
      }

      // Equalizer bars for speaking / thinking states.
      if (s === 'model_speaking' || s === 'speaking' || s === 'model_thinking' || s === 'thinking') {
        const N = 24;
        const barW = Math.max(2, (radius * 1.6) / (N * 1.5));
        const gap = barW * 0.5;
        const totalW = N * barW + (N - 1) * gap;
        const startX = cx - totalW / 2;
        ctx.fillStyle = color;
        for (let i = 0; i < N; i++) {
          const idx = (histIdx - i + HIST_LEN) % HIST_LEN;
          const v = hist[idx] || 0;
          // Blend in a sine so there's movement even with zero input.
          const jitter = reducedMotion ? 0.5 : (0.35 + 0.35 * Math.sin(t * 3 + i * 0.6));
          const amp = Math.max(0.08, Math.min(1, v * 1.4 + jitter * 0.35));
          const h = Math.max(3, amp * radius * 0.9);
          const x = startX + i * (barW + gap);
          ctx.fillRect(x, cy - h / 2, barW, h);
        }
      }

      // Burst dots fade.
      for (let i = BURSTS.length - 1; i >= 0; i--) {
        const b = BURSTS[i];
        const age = now - b.born;
        if (age > b.life) { BURSTS.splice(i, 1); continue; }
        const a = 1 - age / b.life;
        ctx.fillStyle = withAlpha(color, a * 0.85);
        ctx.beginPath();
        ctx.arc(b.x, b.y, 2.2, 0, Math.PI * 2);
        ctx.fill();
      }

      // Error state — static red dash through centre.
      if (s === 'error') {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(cx - radius * 0.6, cy);
        ctx.lineTo(cx + radius * 0.6, cy);
        ctx.stroke();
      }

      ctx.restore();
    }

    requestAnimationFrame(tick);
  }

  // If everything's missing, bail — but safely (matches old contract).
  if (!bars.length && !canvas) return;
  requestAnimationFrame(tick);
}

// Parse CSS color token + apply alpha. Accepts #RRGGBB or rgb()/rgba().
function withAlpha(color, alpha) {
  const c = (color || '').trim();
  if (c.startsWith('#')) {
    const h = c.slice(1);
    const full = h.length === 3
      ? h.split('').map((x) => x + x).join('')
      : h.length === 6 ? h : '5B6675';
    const r = parseInt(full.slice(0, 2), 16);
    const g = parseInt(full.slice(2, 4), 16);
    const b = parseInt(full.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  if (c.startsWith('rgba')) return c.replace(/rgba\(([^,]+),([^,]+),([^,]+),[^)]+\)/, `rgba($1,$2,$3,${alpha})`);
  if (c.startsWith('rgb')) return c.replace(/rgb\(([^,]+),([^,]+),([^)]+)\)/, `rgba($1,$2,$3,${alpha})`);
  return `rgba(91,102,117,${alpha})`;
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
  // Next frame so the `is-open` transition catches after `hidden=false`.
  requestAnimationFrame(() => sheet.classList.add('is-open'));
  sheet.setAttribute('aria-hidden', 'false');
  if (btn) btn.setAttribute('aria-expanded', 'true');
  const closer = $('#voice-settings-close');
  if (closer) closer.focus();
}
function closeSettings() {
  const sheet = $('#voice-settings-sheet');
  const btn = $('#voice-settings');
  if (!sheet) return;
  sheet.classList.remove('is-open');
  sheet.setAttribute('aria-hidden', 'true');
  // Keep `hidden` in sync after the transition window so focus isn't
  // trapped on elements inside a visually-closed sheet.
  setTimeout(() => {
    if (!sheet.classList.contains('is-open')) sheet.hidden = true;
  }, 320);
  if (btn) { btn.setAttribute('aria-expanded', 'false'); btn.focus(); }
}

// Tabbed settings — Voice / Agent / Transcript / Theme.
function wireSettingsTabs() {
  const sheet = $('#voice-settings-sheet');
  if (!sheet) return;
  const tabs = sheet.querySelectorAll('[data-settings-tab]');
  const panels = sheet.querySelectorAll('[data-settings-panel]');
  if (!tabs.length) return;
  function activate(name) {
    tabs.forEach((t) => {
      const active = t.getAttribute('data-settings-tab') === name;
      t.classList.toggle('is-active', active);
      t.setAttribute('aria-selected', active ? 'true' : 'false');
      t.tabIndex = active ? 0 : -1;
    });
    panels.forEach((p) => {
      const active = p.getAttribute('data-settings-panel') === name;
      p.classList.toggle('is-active', active);
      p.hidden = !active;
    });
  }
  tabs.forEach((t) => {
    t.addEventListener('click', () => activate(t.getAttribute('data-settings-tab')));
    t.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const list = Array.from(tabs);
      const i = list.indexOf(t);
      const next = list[(i + (e.key === 'ArrowRight' ? 1 : -1) + list.length) % list.length];
      next.focus();
      activate(next.getAttribute('data-settings-tab'));
    });
  });
}

// --- Bootstrap ---

/** Build the persistent chrome + instantiate the VoiceAgent exactly once. */
export async function bootstrapVoiceShell() {
  buildSkipLink();
  buildHeader();

  const dock = buildDockMarkup();
  document.body.appendChild(dock);

  // On mobile the dock starts as a compact pill so first paint shows the
  // page content; user taps the toggle to expand. Desktop stays expanded
  // because the app shell reserves right-gutter space for it.
  try {
    const isMobile = window.matchMedia('(max-width: 640px)').matches;
    if (isMobile) {
      dock.classList.add('is-collapsed');
      const toggle = dock.querySelector('#voice-dock-toggle');
      if (toggle) {
        toggle.setAttribute('aria-expanded', 'false');
        toggle.setAttribute('title', 'Expand voice panel');
      }
    }
  } catch {}

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
  wireSettingsTabs();
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

  // --- Compression-strength slider (child of phone-compression).
  const strength = $('#voice-compression-strength');
  const strengthRow = strength && strength.closest('.compression-strength-row');
  const strengthReadout = $('#voice-compression-strength-readout');

  function syncStrengthEnabled() {
    if (!strength || !strengthRow) return;
    const on = phoneToggle.checked;
    strength.disabled = !on;
    strengthRow.setAttribute('aria-disabled', on ? 'false' : 'true');
  }

  function reflectStrength(value) {
    if (!strength || !strengthReadout) return;
    const v = String(Math.max(0, Math.min(100, Math.round(Number(value) || 0))));
    strength.value = v;
    strength.setAttribute('aria-valuenow', v);
    strengthReadout.textContent = `${v}%`;
  }

  if (strength) {
    reflectStrength(typeof agent.getCompressionStrength === 'function' ? agent.getCompressionStrength() : 50);
    syncStrengthEnabled();

    on(strength, 'input', () => {
      const v = Number(strength.value);
      reflectStrength(v);
      if (typeof agent.setCompressionStrength === 'function') {
        agent.setCompressionStrength(v);
      }
    });
    on(phoneToggle, 'change', syncStrengthEnabled);

    // Keep the slider in sync when the agent (or a tool call) changes
    // compression strength from elsewhere.
    agent.addEventListener('compression-changed', (e) => {
      const d = e && e.detail;
      if (d && typeof d.strength === 'number') reflectStrength(d.strength);
      syncStrengthEnabled();
    });
  }

  // --- Ambient chip toggles on `ambient-changed` events from the agent.
  const ambientChip = $('#voice-ambient-chip');
  if (ambientChip) {
    const reflectAmbient = (on) => { ambientChip.hidden = !on; };
    agent.addEventListener('ambient-changed', (e) => {
      reflectAmbient(!!(e && e.detail && e.detail.on));
    });
    // Mirror call-state transitions as a belt-and-suspenders: when the
    // user ends a call, the chip should drop regardless of whether
    // ambient-changed fires.
    agent.addEventListener('state', () => {
      if (!agent.isInCall()) reflectAmbient(false);
    });
  }

  // --- Dock collapse + clear
  const collapseBtn = $('#voice-dock-toggle');
  on(collapseBtn, 'click', () => {
    const d = $('#voice-dock');
    const isCollapsed = d.classList.toggle('is-collapsed');
    collapseBtn.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
    collapseBtn.setAttribute('title', isCollapsed ? 'Expand voice panel' : 'Collapse voice panel');
    // When collapsing, ensure the settings sheet is closed so it can't linger
    // behind a hidden body.
    if (isCollapsed && $('#voice-settings-sheet').classList.contains('is-open')) {
      closeSettings();
    }
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

  // --- Transcript tri-state toggle (Off / Captions / Full)
  const transcriptSegButtons = document.querySelectorAll('#voice-transcript-seg button[data-mode]');
  transcriptSegButtons.forEach((b) => on(b, 'click', () => {
    if (b.disabled) return;
    const mode = b.getAttribute('data-mode');
    agent.setTranscriptMode(mode);
  }));
  agent.addEventListener('transcript-mode-changed', () => {
    applyTranscriptMode(agent.getTranscriptMode(), agent.getFlags());
  });

  // --- Theme toggle (Dark / Light / System)
  const themeSegButtons = document.querySelectorAll('#voice-theme-seg button[data-theme-value]');
  themeSegButtons.forEach((b) => on(b, 'click', async () => {
    const mod = await import('./theme.js');
    mod.setTheme(b.getAttribute('data-theme-value'));
  }));

  // Apply feature flags as soon as /api/config lands. init() emits
  // flags-ready immediately after, so this handler fires once per page.
  agent.addEventListener('flags-ready', (e) => applyFlags(e.detail.flags, agent));
  // In case the agent already read flags before this listener attached.
  applyFlags(agent.getFlags(), agent);

  return agent;
}

/** Reflect the server-issued feature flags into the DOM. Called once on
 *  `flags-ready`. Idempotent. The transcript mode (`getTranscriptMode`)
 *  takes precedence over the raw showText flag for visibility decisions
 *  once the tri-state toggle is active. */
function applyFlags(flags, agent) {
  const transcript = document.getElementById('voice-transcript');
  const hint = document.getElementById('voice-transcript-hint');
  const hidden = document.getElementById('voice-transcript-hidden');
  if (!transcript) return;

  const note = document.getElementById('voice-transcript-note');
  const seg = document.getElementById('voice-transcript-seg');
  if (!flags.showText) {
    // Server forces transcript off; disable the tri-state toggle and
    // show the explanatory "hidden by server" card.
    transcript.hidden = true;
    if (hint) hint.hidden = true;
    if (hidden) hidden.hidden = false;
    if (note) note.textContent = 'Transcripts disabled by server config.';
    if (seg) seg.querySelectorAll('button').forEach((b) => {
      b.disabled = true;
      b.setAttribute('aria-disabled', 'true');
    });
    return;
  }
  if (seg) seg.querySelectorAll('button').forEach((b) => {
    b.disabled = false;
    b.removeAttribute('aria-disabled');
  });
  if (note) note.textContent = '';
  if (hidden) hidden.hidden = true;

  // Apply the user-selected transcript mode.
  const mode = (agent && typeof agent.getTranscriptMode === 'function') ? agent.getTranscriptMode() : 'off';
  applyTranscriptMode(mode, flags);
}

function applyTranscriptMode(mode, flags) {
  const transcript = document.getElementById('voice-transcript');
  const hint = document.getElementById('voice-transcript-hint');
  const hidden = document.getElementById('voice-transcript-hidden');
  const captions = document.getElementById('jarvis-captions');
  if (!transcript) return;

  const serverOff = !!(flags && flags.showText === false);
  const effective = serverOff ? 'off' : mode;

  if (effective === 'full') {
    transcript.hidden = false;
    if (hidden) hidden.hidden = true;
    // SHOW_TEXT=true but Gemini transcription off → hint about asymmetry.
    if (hint) hint.hidden = !flags || !!flags.geminiTranscription;
    if (captions) { captions.hidden = true; captions.classList.remove('is-visible'); }
  } else if (effective === 'captions') {
    transcript.hidden = true;
    if (hint) hint.hidden = true;
    if (hidden) hidden.hidden = true;
    // Captions overlay itself is controlled by voice-agent events +
    // captions-overlay.js. Just make sure it's mountable.
    if (captions) captions.hidden = false;
  } else {
    // mode === 'off' — hide everything transcript-related. The
    // voice-transcript-hidden announcement is only for the server-forced
    // case (`showText === false`).
    transcript.hidden = true;
    if (hint) hint.hidden = true;
    if (hidden) hidden.hidden = !serverOff;
    if (captions) { captions.hidden = true; captions.classList.remove('is-visible'); }
  }

  // When mode is off (user-selected), we also hide the dock body's
  // transcript panel but keep the dock visible — so still surface other
  // controls (status strip, chips, activity). Nothing more to do here.

  // Sync the segmented control visual state.
  const seg = document.getElementById('voice-transcript-seg');
  if (seg) seg.querySelectorAll('button[data-mode]').forEach((b) => {
    const active = b.getAttribute('data-mode') === effective;
    b.setAttribute('aria-checked', active ? 'true' : 'false');
    b.classList.toggle('is-active', active);
  });
}

function debounce(fn, ms) {
  let t;
  return function () { clearTimeout(t); t = setTimeout(fn, ms); };
}
