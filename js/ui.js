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
// "Expressive Console" voice dock v2. The dock defaults to a MINIMISED
// pill: a 60 px rounded rectangle anchored bottom-right (desktop) or
// bottom-full-width (mobile). The pill is actionable — it contains the
// Place Call button directly, so the user never needs to expand it to
// start a call.
//
// Pill layout (minimised — always visible):
//   [ state-dot + "Jarvis" | status-chip | timer-chip | muted-chip | mic | call-btn | settings | expand-caret ]
//
// Clicking the caret expands the dock into a full panel (28 px uniform
// radius, container-morph per §8.6). Expanded rows top→bottom:
//   1. Header pill (same as above — the Call button lives here in both states)
//   2. Error banner (hidden by default)
//   3. Visualiser — 5-bar vertical VU inside #voice-status-strip
//   4. Transcript pane (#voice-transcript)
//   5. Quick chips row (mounted by quick-chips.js inside .voice-dock-body)
//   6. Action footer — activity indicator + hint + kbd pips
//
// Settings sheet slides from right (desktop) or as bottom-sheet (mobile).
// Tabbed layout: Voice / Agent / Transcript / Theme. Every preserved ID
// from architecture §2 remains intact for JS wiring.

function buildDockMarkup() {
  const dock = document.createElement('section');
  dock.className = 'voice-dock';
  dock.id = 'voice-dock';
  dock.setAttribute('aria-label', 'Voice agent');
  dock.setAttribute('data-state', 'idle');
  dock.innerHTML = `
    <header class="voice-dock-header">
      <div class="voice-dock-brand">
        <span class="voice-state-dot" aria-hidden="true"></span>
        <span class="voice-dock-brand-name">Jarvis</span>
      </div>

      <div class="voice-dock-header-chips">
        <span class="voice-status-pill" id="voice-status-pill" data-state="idle" aria-live="polite">
          <span class="voice-status-pill-label label" id="voice-status-text">Stand by</span>
        </span>
        <span class="voice-chip voice-chip--live" id="voice-live-chip" hidden>
          <span class="voice-chip-label">On call</span>
          <span class="voice-chip-timer mono" id="voice-live-timer">0:00</span>
        </span>
        <span class="voice-chip voice-chip--muted" id="voice-muted-chip" hidden>
          <span class="voice-chip-label">Muted</span>
        </span>
        <span class="voice-chip voice-chip--ambient voice-ambient-chip" id="voice-ambient-chip" data-agent-id="voice.ambient_chip" hidden>
          <span class="voice-chip-label">Ambient</span>
        </span>
      </div>

      <div class="voice-dock-header-actions">
        <button class="voice-mic-btn mic-btn" id="voice-mic" data-agent-id="voice.mic" type="button" aria-pressed="false" aria-label="Mute microphone" title="Mute (M)" hidden>
          <svg class="mic-icon mic-icon--on" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 1 0 6 0V5a3 3 0 0 0-3-3Z" fill="currentColor"/>
            <path d="M5 11a7 7 0 0 0 14 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            <path d="M12 18v4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
          <svg class="mic-icon mic-icon--off" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path d="M12 2a3 3 0 0 0-3 3v4l6 6V5a3 3 0 0 0-3-3Z" fill="currentColor"/>
            <path d="M19 11a7 7 0 0 1-11.3 5.55L9 15a5 5 0 0 0 8-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            <path d="M12 18v4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            <path d="M3 3l18 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
          <span class="sr-only" id="voice-mic-label">Mute</span>
        </button>

        <button class="voice-call-btn call-btn call-btn--idle" id="voice-call-btn" data-agent-id="voice.call_btn" data-call-state="idle" type="button" aria-label="Place a call to Jarvis">
          <span class="voice-call-btn-icons" aria-hidden="true">
            <svg class="call-btn-icon call-btn-icon--phone" viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
              <path d="M6.6 10.8a15.5 15.5 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.6 1 1 0 0 1 1 1v3.5a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1 11.4 11.4 0 0 0 .6 3.6 1 1 0 0 1-.25 1l-2.25 2.2Z"/>
            </svg>
            <svg class="call-btn-icon call-btn-icon--end" viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
              <path d="M12 9c-3.6 0-7 1-9.4 2.6a1 1 0 0 0-.3 1.4l1.8 2.4a1 1 0 0 0 1.2.3L7.2 15a1 1 0 0 0 .6-.9V12a11 11 0 0 1 8.4 0v2.1a1 1 0 0 0 .6.9l1.9.8a1 1 0 0 0 1.2-.3l1.8-2.4a1 1 0 0 0-.3-1.4C19 10 15.6 9 12 9Z"/>
            </svg>
            <svg class="call-btn-icon call-btn-icon--cancel" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
              <path d="M6 6l12 12M18 6 6 18"/>
            </svg>
          </span>
          <span class="voice-call-btn-label call-btn-label" id="voice-call-btn-label">Place Call</span>
        </button>

        <button class="voice-icon-btn icon-btn" id="voice-settings" aria-label="Call settings" aria-expanded="false" aria-controls="voice-settings-sheet" title="Call settings" data-agent-id="voice.settings" type="button">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1A1.7 1.7 0 0 0 10 3.1V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>
          </svg>
        </button>

        <button class="voice-icon-btn voice-icon-btn--toggle icon-btn" id="voice-dock-toggle" aria-expanded="false" aria-controls="voice-dock-body" data-agent-id="voice.dock.collapse" title="Expand voice panel" type="button">
          <svg class="voice-icon voice-icon--caret" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M6 15l6-6 6 6"/>
          </svg>
          <span class="sr-only">Expand voice panel</span>
        </button>
      </div>
    </header>

    <div class="voice-error-banner" id="voice-error" role="alert" hidden></div>

    <div class="voice-dock-body" id="voice-dock-body">
      <section class="voice-visualiser" id="voice-status-strip" data-state="idle" aria-hidden="true">
        <div class="voice-vu" aria-hidden="true">
          <span class="bar"></span><span class="bar"></span><span class="bar"></span><span class="bar"></span><span class="bar"></span>
        </div>
        <div class="voice-visualiser-readout">
          <span class="voice-visualiser-label">Session</span>
          <span class="mono-id voice-visualiser-id" id="voice-session-id">—</span>
        </div>
      </section>

      <section class="voice-transcript-pane">
        <div class="voice-transcript" id="voice-transcript" aria-live="polite" aria-label="Conversation transcript"></div>
        <p class="voice-transcript-hint" id="voice-transcript-hint" hidden>Agent speech not transcribed (configured to save credits).</p>
        <p class="voice-transcript-hidden" id="voice-transcript-hidden" hidden>Transcripts hidden by configuration (SHOW_TEXT=false).</p>
      </section>
    </div>

    <div class="voice-dock-action">
      <div class="voice-dock-action-footer">
        <p class="voice-call-hint call-hint" id="voice-call-hint">Click Place Call to talk to Jarvis.</p>
      </div>
    </div>

    <aside class="voice-settings-sheet" id="voice-settings-sheet" role="dialog" aria-modal="true" aria-labelledby="voice-settings-title" aria-hidden="true" hidden>
      <span class="voice-settings-handle" aria-hidden="true"></span>
      <header class="voice-settings-header">
        <h2 id="voice-settings-title" class="voice-settings-title">Call settings</h2>
        <button class="voice-icon-btn icon-btn" id="voice-settings-close" aria-label="Close settings" title="Close" type="button">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>
        </button>
      </header>

      <!-- FIX (requirement 10): single scrollable settings page. Tabs
           removed. All agent settings — Voice/Persona/Transcript/Theme —
           live in one container that scrolls vertically when content
           overflows. Section headers (<h3>) aid scannability. Every JS
           wiring hook (ids, data-agent-id, segmented class names)
           is preserved. -->
      <div class="voice-settings-body voice-settings-body--single" id="voice-settings-body">

        <section class="voice-settings-section" aria-labelledby="voice-settings-h-voice">
          <h3 class="voice-settings-section-title" id="voice-settings-h-voice">Voice</h3>

          <div class="voice-settings-row voice-settings-row--labeled voice-settings-row--segmented" role="radiogroup" aria-label="Listening mode">
            <div class="voice-settings-row-text">
              <span class="voice-settings-row-label">Mode</span>
            </div>
            <div class="voice-settings-row-control">
              <div class="segmented mode-seg" id="voice-mode-seg">
                <button role="radio" type="button" data-mode="live" data-agent-id="voice.mode.live" aria-checked="true" title="Place Call mode — default.">
                  <span>Place Call</span>
                </button>
                <button role="radio" type="button" data-mode="wakeword" data-agent-id="voice.mode.wakeword" aria-checked="false" title="Wake word ('Hey Jarvis') — advanced.">
                  <span>Wake Word</span>
                </button>
              </div>
            </div>
          </div>
          <p class="voice-settings-note" id="voice-mode-note"></p>

          <div class="voice-settings-row voice-settings-row--toggle">
            <div class="voice-settings-row-text">
              <span class="voice-settings-row-label">Background audio</span>
              <span class="voice-settings-row-helper">Ambience loop plays during the call.</span>
            </div>
            <label class="toggle" for="voice-background-toggle" title="Play a quiet ambience loop during the call.">
              <input type="checkbox" id="voice-background-toggle" data-agent-id="voice.background_toggle" checked />
              <span class="track"></span>
              <span class="sr-only">Background audio</span>
            </label>
          </div>

          <div class="voice-settings-row voice-settings-row--toggle">
            <div class="voice-settings-row-text">
              <span class="voice-settings-row-label">Phone-line compression</span>
              <span class="voice-settings-row-helper">Adds call-center warmth and uses narrowband audio for lower latency.</span>
            </div>
            <label class="toggle" for="voice-phone-compression-toggle" title="Apply telephone-style compression to the agent's voice. Uses narrowband audio for faster delivery.">
              <input type="checkbox" id="voice-phone-compression-toggle" data-agent-id="voice.phone_compression_toggle" checked />
              <span class="track"></span>
              <span class="sr-only">Phone-line compression</span>
            </label>
          </div>

          <div class="voice-settings-row voice-settings-row--labeled voice-settings-row--volume">
            <div class="voice-settings-row-text">
              <span class="voice-settings-row-label">Volume</span>
            </div>
            <div class="voice-settings-row-control">
              <input class="slider" type="range" id="voice-volume" data-agent-id="voice.output_volume" min="0" max="150" value="100" aria-label="Agent output volume" />
              <output class="voice-volume-readout" id="voice-volume-readout" for="voice-volume">100%</output>
              <div class="voice-volume-ticks" aria-hidden="true">
                <span style="left: 0%"></span>
                <span style="left: 33.33%"></span>
                <span style="left: 66.66%"></span>
                <span style="left: 100%"></span>
              </div>
            </div>
          </div>
        </section>

        <section class="voice-settings-section" aria-labelledby="voice-settings-h-agent">
          <h3 class="voice-settings-section-title" id="voice-settings-h-agent">Agent</h3>
          <div class="voice-settings-row voice-settings-row--segmented">
            <div class="voice-settings-row-text">
              <span class="voice-settings-row-label">Persona</span>
              <span class="voice-settings-row-helper">Choose the personality Jarvis uses on the call.</span>
            </div>
            <div class="voice-settings-row-control">
              <div class="segmented persona-seg" id="voice-persona-seg"></div>
            </div>
          </div>
        </section>

        <section class="voice-settings-section" aria-labelledby="voice-settings-h-voice-picker">
          <h3 class="voice-settings-section-title" id="voice-settings-h-voice-picker">Voice</h3>
          <div class="voice-tile-row" id="voice-tile-row" role="radiogroup" aria-label="Voice selection">
            <div class="voice-tile" role="radio" tabindex="0" data-voice="Kore" aria-checked="true">
              <span class="voice-tile-name">Kore</span>
              <button class="voice-tile-play" type="button" aria-label="Preview Kore" title="Preview">&#9654;</button>
            </div>
            <div class="voice-tile" role="radio" tabindex="-1" data-voice="Aoede" aria-checked="false">
              <span class="voice-tile-name">Aoede</span>
              <button class="voice-tile-play" type="button" aria-label="Preview Aoede" title="Preview">&#9654;</button>
            </div>
            <div class="voice-tile" role="radio" tabindex="-1" data-voice="Puck" aria-checked="false">
              <span class="voice-tile-name">Puck</span>
              <button class="voice-tile-play" type="button" aria-label="Preview Puck" title="Preview">&#9654;</button>
            </div>
            <div class="voice-tile" role="radio" tabindex="-1" data-voice="Charon" aria-checked="false">
              <span class="voice-tile-name">Charon</span>
              <button class="voice-tile-play" type="button" aria-label="Preview Charon" title="Preview">&#9654;</button>
            </div>
            <div class="voice-tile" role="radio" tabindex="-1" data-voice="Orus" aria-checked="false">
              <span class="voice-tile-name">Orus</span>
              <button class="voice-tile-play" type="button" aria-label="Preview Orus" title="Preview">&#9654;</button>
            </div>
            <div class="voice-tile" role="radio" tabindex="-1" data-voice="Fenrir" aria-checked="false">
              <span class="voice-tile-name">Fenrir</span>
              <button class="voice-tile-play" type="button" aria-label="Preview Fenrir" title="Preview">&#9654;</button>
            </div>
            <div class="voice-tile" role="radio" tabindex="-1" data-voice="Leda" aria-checked="false">
              <span class="voice-tile-name">Leda</span>
              <button class="voice-tile-play" type="button" aria-label="Preview Leda" title="Preview">&#9654;</button>
            </div>
            <div class="voice-tile" role="radio" tabindex="-1" data-voice="Zephyr" aria-checked="false">
              <span class="voice-tile-name">Zephyr</span>
              <button class="voice-tile-play" type="button" aria-label="Preview Zephyr" title="Preview">&#9654;</button>
            </div>
          </div>
        </section>

        <section class="voice-settings-section" aria-labelledby="voice-settings-h-transcript">
          <h3 class="voice-settings-section-title" id="voice-settings-h-transcript">Transcript</h3>
          <div class="voice-settings-row voice-settings-row--labeled voice-settings-row--segmented" role="radiogroup" aria-label="Transcript mode">
            <div class="voice-settings-row-text">
              <span class="voice-settings-row-label">Mode</span>
            </div>
            <div class="voice-settings-row-control">
              <!-- Round-2 req 2: ship-time default is "Full" (mirrors
                   VoiceAgent's DEFAULT_TRANSCRIPT_MODE). applyTranscriptMode
                   still re-syncs aria-checked from the agent on boot, so a
                   legacy localStorage pick wins if present. -->
              <div class="segmented transcript-seg" id="voice-transcript-seg" data-agent-id="transcript.mode_seg">
                <button role="radio" type="button" data-mode="off" data-agent-id="transcript.mode.off" aria-checked="false">Off</button>
                <button role="radio" type="button" data-mode="captions" data-agent-id="transcript.mode.captions" aria-checked="false">Captions</button>
                <button role="radio" type="button" data-mode="full" data-agent-id="transcript.mode.full" aria-checked="true">Full</button>
              </div>
            </div>
          </div>
          <p class="voice-settings-note" id="voice-transcript-note"></p>
          <div class="voice-settings-actions">
            <button class="btn btn--ghost btn--sm" id="voice-clear" data-agent-id="voice.clear_transcript" type="button">Clear transcript</button>
          </div>
        </section>

        <section class="voice-settings-section" aria-labelledby="voice-settings-h-theme">
          <h3 class="voice-settings-section-title" id="voice-settings-h-theme">Theme</h3>
          <div class="voice-settings-row voice-settings-row--labeled voice-settings-row--segmented" role="radiogroup" aria-label="Theme">
            <div class="voice-settings-row-text">
              <span class="voice-settings-row-label">Theme</span>
            </div>
            <div class="voice-settings-row-control">
              <div class="segmented theme-seg" id="voice-theme-seg" data-agent-id="theme.toggle">
                <button role="radio" type="button" data-theme-value="dark" data-agent-id="theme.dark" aria-checked="false">Dark</button>
                <button role="radio" type="button" data-theme-value="light" data-agent-id="theme.light" aria-checked="false">Light</button>
                <button role="radio" type="button" data-theme-value="system" data-agent-id="theme.system" aria-checked="false">System</button>
              </div>
            </div>
          </div>
        </section>

        <section class="voice-debug-panel" id="voice-debug-panel" hidden>
          <span class="voice-settings-row-label">Debug</span>
          <pre class="debug-metrics mono" id="voice-debug-metrics"></pre>
        </section>
      </div>
      <div class="voice-settings-footer">
        <button class="btn btn--primary btn--sm" id="voice-settings-done" type="button">Done</button>
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

// Expressive Console pill copy per §8.1 of the v2 design spec. Sentence
// case, no all-caps, no wide tracking. Falls back to voice-agent's
// STATE_COPY when the state isn't in this table.
const PILL_COPY = Object.freeze({
  idle: 'Stand by',
  arming: 'Armed',
  dialing: 'Dialling',
  live_opening: 'Connecting',
  live_ready: 'Listening',
  model_thinking: 'Thinking',
  model_speaking: 'Speaking',
  tool_executing: 'Taking action',
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
  // Both `label` and `txt` resolve to `#voice-status-text` in v2 — the
  // status-pill label IS the status text. `label.textContent` is set
  // first; the fallback path writes to `#voice-status-text` directly in
  // case the pill markup is ever restructured again.
  if (label) label.textContent = copy;
  if (txt && txt !== label) txt.textContent = copy;
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

// --- VU meter ---

// Drives the five `.voice-vu .bar` children inside #voice-status-strip.
// Per v2 §8.4 this is the ONLY visualiser — no canvas, no scope, no
// compass. Bars are 6 px wide vertical columns that scale in height
// (4 px floor, 48 px ceiling) as the mic / ambient level changes. Colour
// is driven by `[data-state]` on the strip via CSS; JS only touches
// heights. Safe no-op if any of agent / pipeline / bars are missing
// (preserves the pre-call / route-change edge cases in the original
// contract).
function wireVuMeter(agent) {
  const strip = document.getElementById('voice-status-strip');
  const bars = strip ? strip.querySelectorAll('.voice-vu .bar') : [];
  if (!bars.length) return;

  // Symmetric weighting: centre bar leads, outer bars follow. Gives a
  // pleasant "breathing" shape when the level is steady.
  const WEIGHTS = [0.55, 0.82, 1.0, 0.82, 0.55];
  const BAR_MIN = 4;   // px
  const BAR_MAX = 48;  // px — matches §8.4

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

  function tick() {
    const level = readLevel();
    bars.forEach((b, i) => {
      const weight = WEIGHTS[i] != null ? WEIGHTS[i] : 1;
      const h = Math.max(BAR_MIN, Math.round(BAR_MIN + level * (BAR_MAX - BAR_MIN) * weight));
      b.style.height = h + 'px';
    });
    requestAnimationFrame(tick);
  }

  requestAnimationFrame(tick);
}

// --- Persona buttons ---
// FIX (Decision 3): persona tiles use a grid layout with `aria-pressed`
// as the single source of truth. No `aria-checked` anywhere.
// `selectPersonaTile(id)` is the unified handler used by both initial
// build and `personas-ready` rebuild.

function selectPersonaTile(id, agent) {
  if (agent && typeof agent.setPersona === 'function') {
    agent.setPersona(id);
  }
  document.querySelectorAll('[data-persona-id]').forEach((b) => {
    b.setAttribute('aria-pressed', b.getAttribute('data-persona-id') === id ? 'true' : 'false');
  });
}

function buildPersonaButtons(container, personas, current, onSelect) {
  if (!container) return;
  container.innerHTML = '';
  container.className = 'persona-grid';
  container.removeAttribute('role');
  personas.forEach((p) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'persona-tile';
    btn.setAttribute('aria-pressed', p.id === current ? 'true' : 'false');
    btn.setAttribute('data-persona-id', p.id);
    btn.setAttribute('data-agent-id', `voice.persona.${p.id}`);
    const label = document.createElement('span');
    label.className = 'persona-tile-label';
    label.textContent = p.label;
    btn.appendChild(label);
    if (p.description) {
      const desc = document.createElement('span');
      desc.className = 'persona-tile-desc';
      desc.textContent = p.description;
      btn.appendChild(desc);
    }
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

// FIX (requirement 10): tabs retired — all settings live in one
// scrollable page. This function is kept as a no-op shim so callers in
// `bootstrapVoiceShell` don't need to change wiring and downstream tests
// that check for its existence keep passing.
function wireSettingsTabs() { /* intentional no-op — single-page layout */ }

// --- Bootstrap ---

/** Build the persistent chrome + instantiate the VoiceAgent exactly once. */
export async function bootstrapVoiceShell() {
  buildSkipLink();
  buildHeader();

  const dock = buildDockMarkup();
  document.body.appendChild(dock);

  // v2 "Expressive Console": the dock defaults to MINIMISED on ALL
  // viewports (desktop + mobile). The minimised pill is actionable — it
  // contains the Place Call button directly, so users can start a call
  // without expanding. The caret (`#voice-dock-toggle`) opens the full
  // panel (transcript, quick-chips, visualiser, kbd pips) on demand.
  dock.classList.add('is-collapsed');
  try {
    const toggle = dock.querySelector('#voice-dock-toggle');
    if (toggle) {
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('title', 'Expand voice panel');
    }
  } catch {}

  const transcriptEl = $('#voice-transcript');
  const agent = new VoiceAgent({ transcriptEl });

  // --- Persona
  const personaContainer = $('#voice-persona-seg');
  buildPersonaButtons(personaContainer, agent.getPersonas(), agent.getCurrentPersonaId(), (id) => {
    selectPersonaTile(id, agent);
  });
  agent.addEventListener('personas-ready', (e) => {
    buildPersonaButtons(personaContainer, e.detail.personas, agent.getCurrentPersonaId(), (id) => {
      selectPersonaTile(id, agent);
    });
  });

  // Sync persona tile visuals when persona changes programmatically
  window.addEventListener('persona-changed', (e) => {
    const id = e.detail && (e.detail.personaId || e.detail.id);
    if (id) selectPersonaTile(id, null);
  });
  agent.addEventListener('persona-changed', (e) => {
    const id = e.detail && (e.detail.personaId || e.detail.id);
    if (id) selectPersonaTile(id, null);
  });

  // --- Voice picker tiles
  const voiceTileRow = $('#voice-tile-row');
  if (voiceTileRow) {
    const voiceTiles = voiceTileRow.querySelectorAll('.voice-tile');
    voiceTiles.forEach((tile) => {
      tile.addEventListener('click', (ev) => {
        // Don't select if play button was clicked
        if (ev.target.closest('.voice-tile-play')) return;
        // Don't change voice mid-call
        if (agent.callOpen === true || agent.isInCall()) {
          return;
        }
        const voice = tile.getAttribute('data-voice');
        voiceTiles.forEach((t) => {
          const sel = t.getAttribute('data-voice') === voice;
          // role="radio" → aria-checked is the canonical state attribute.
          t.setAttribute('aria-checked', sel ? 'true' : 'false');
          t.setAttribute('tabindex', sel ? '0' : '-1');
          t.removeAttribute('aria-pressed');
        });
        if (typeof agent.setSelectedVoice === 'function') {
          agent.setSelectedVoice(voice);
        }
      });
      tile.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          tile.click();
        }
      });
    });
    // Play buttons — no-op / log (no sample audio exists yet)
    voiceTileRow.querySelectorAll('.voice-tile-play').forEach((playBtn) => {
      playBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const voice = playBtn.closest('.voice-tile')?.getAttribute('data-voice');
        console.log(`[ui] Voice preview requested: ${voice} (no sample audio available)`);
      });
    });
    // Grey out tiles mid-call
    const updateCallActiveState = () => {
      const inCall = agent.callOpen === true || (typeof agent.isInCall === 'function' && agent.isInCall());
      voiceTileRow.setAttribute('data-call-active', inCall ? 'true' : 'false');
      voiceTiles.forEach((t) => {
        if (inCall) {
          t.setAttribute('title', 'End call to change voice.');
        } else {
          t.removeAttribute('title');
        }
      });
    };
    agent.addEventListener('state', updateCallActiveState);
    agent.addEventListener('call-audio-all-stopped', updateCallActiveState);
  }

  // --- Settings Done button
  const doneBtn = $('#voice-settings-done');
  if (doneBtn) {
    on(doneBtn, 'click', () => closeSettings());
  }

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
  //
  // FIX (requirement 7): when the user clicks End Call, ALL audio
  // (agent speech, background ambience, any in-flight chime) must stop
  // THEN AND THERE. `agent.endCall()` handles the graceful transition
  // (which plays the hangup chime), but we also synchronously flush any
  // already-scheduled PCM + HTMLAudioElement playback here so there's
  // zero delay before silence. The hangup chime that follows is re-armed
  // inside `_gracefullyEndCall`.
  const callBtn = $('#voice-call-btn');
  on(callBtn, 'click', async () => {
    // unlockAudioSync must run BEFORE any await.
    try { agent.unlockAudioSync(); } catch {}
    const state = agent.getState();
    if (IS_IN_CALL_STATES.has(state) || state === STATES.RECONNECTING) {
      // Kill any in-flight audio immediately (synchronous on this tick).
      try { agent.pipeline.stopAllAudio(); } catch {}
      await agent.endCall();
    } else if (state === STATES.DIALING || state === STATES.LIVE_OPENING) {
      // Cancel during dial — also hard-stop any playing open-chime.
      try { agent.pipeline.stopAllAudio(); } catch {}
      await agent.cancelDial();
    } else if (state === STATES.CLOSING) {
      /* ignore */
    } else {
      await agent.placeCall();
    }
  });

  // FIX (requirement 6): when every managed audio element has stopped,
  // force a re-render of the call button so it reverts to green. The
  // state machine already transitions to IDLE after `playCallClose`
  // resolves, but this listener is a belt-and-braces guarantee — any
  // race where the button's DOM classes fall out of sync with state
  // gets corrected here. Also hide the live chip since the call is
  // fully over.
  agent.addEventListener('call-audio-all-stopped', () => {
    renderCallButton(agent.getState());
    const chip = $('#voice-live-chip');
    if (chip && !agent.isInCall()) chip.hidden = true;
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

  // --- audio-flow: Background audio toggle + phone-line compression +
  // output volume. The noise dropdown, noise-volume slider, the original
  // phone-compression checkbox and compression-strength slider were
  // retired alongside the procedural noise system. The two toggles below
  // expose the remaining user-facing knobs.
  const backgroundToggle = $('#voice-background-toggle');
  if (backgroundToggle) {
    backgroundToggle.checked = !!agent.getBackgroundEnabled();
    on(backgroundToggle, 'change', () => agent.setBackgroundEnabled(!!backgroundToggle.checked));
    // Keep the checkbox in sync when the agent changes the value from
    // elsewhere (e.g. a future tool call or cross-tab event).
    agent.addEventListener('background-changed', (e) => {
      const d = e && e.detail;
      if (d && typeof d.enabled === 'boolean') {
        backgroundToggle.checked = !!d.enabled;
      }
    });
  }

  // Phone-line compression. Persistence is owned by the agent
  // (`voice-agent.js` writes 'on'/'off' to localStorage.jarvis.phoneCompression).
  // The UI reads initial state via `agent.getPhoneCompression()` so the two
  // never disagree on serialisation format.
  const phoneCompressionToggle = $('#voice-phone-compression-toggle');
  if (phoneCompressionToggle) {
    const initial = typeof agent.getPhoneCompression === 'function'
      ? !!agent.getPhoneCompression()
      : false;
    phoneCompressionToggle.checked = initial;
    on(phoneCompressionToggle, 'change', () => {
      if (typeof agent.setPhoneCompression === 'function') {
        agent.setPhoneCompression(!!phoneCompressionToggle.checked);
      }
    });
  }

  const volume = $('#voice-volume');
  const volumeReadout = $('#voice-volume-readout');
  function reflectVolumeReadout(val) {
    if (!volumeReadout) return;
    volumeReadout.textContent = `${Math.round(Number(val) || 0)}%`;
  }
  if (volume) {
    const initialVol = (agent.outputVolume != null && Number.isFinite(agent.outputVolume)) ? agent.outputVolume : 1;
    volume.value = String(Math.round(initialVol * 100));
    reflectVolumeReadout(volume.value);
    on(volume, 'input', () => {
      reflectVolumeReadout(volume.value);
      agent.setVolume(Number(volume.value) / 100);
    });
  }

  // --- Ambient chip mirrors the background audio state. It remains in
  // the header as the only visible "call-audio is playing" affordance.
  //
  // FIX (requirement 8): previously the chip only reacted to the
  // `background-changed` event, which fires when the *preference* flips
  // — not when playback itself starts/stops. We now also listen for
  // `call-audio-changed`, which fires from the pipeline every time the
  // background element actually starts or stops. That keeps the chip in
  // sync with real audio state even if the `startBackground()` retry
  // path takes effect.
  const ambientChip = $('#voice-ambient-chip');
  if (ambientChip) {
    const reflectAmbient = (on) => { ambientChip.hidden = !on; };
    agent.addEventListener('background-changed', (e) => {
      reflectAmbient(!!(e && e.detail && e.detail.playing));
    });
    agent.addEventListener('call-audio-changed', (e) => {
      const d = e && e.detail;
      if (!d) return;
      if (typeof d.backgroundPlaying === 'boolean') {
        reflectAmbient(!!d.backgroundPlaying);
      }
    });
    agent.addEventListener('state', () => {
      if (!agent.isInCall()) reflectAmbient(false);
    });
    agent.addEventListener('call-audio-all-stopped', () => reflectAmbient(false));
  }

  // --- latency-pass: Debug HUD under ?debug=1. Hidden in prod; 2-line
  // fixed panel bottom-left showing agent rate + decode p50/p95 + encode
  // p50/p95 from the server. Purely informational; never on the critical
  // path. Built lazily so the cost on non-debug loads is a single class
  // check inside DOMContentLoaded.
  if (DEBUG) {
    const hud = document.createElement('aside');
    hud.className = 'voice-latency-hud';
    hud.id = 'voice-latency-hud';
    hud.setAttribute('role', 'status');
    hud.setAttribute('aria-label', 'Voice-agent latency metrics');
    hud.innerHTML = `
      <div class="voice-latency-hud-row">
        <span class="voice-latency-hud-label">rate</span>
        <span class="voice-latency-hud-value mono" id="voice-hud-rate">—</span>
      </div>
      <div class="voice-latency-hud-row">
        <span class="voice-latency-hud-label">decode</span>
        <span class="voice-latency-hud-value mono" id="voice-hud-decode">—</span>
      </div>
      <div class="voice-latency-hud-row">
        <span class="voice-latency-hud-label">encode</span>
        <span class="voice-latency-hud-value mono" id="voice-hud-encode">—</span>
      </div>
    `;
    document.body.appendChild(hud);
    const rateEl   = $('#voice-hud-rate');
    const decodeEl = $('#voice-hud-decode');
    const encodeEl = $('#voice-hud-encode');
    const reflectRate = () => {
      if (!rateEl) return;
      const r = agent.getAgentAudioRate();
      const pl = agent.getAgentAudioPhoneLine();
      rateEl.textContent = r + ' Hz ' + (pl ? '(narrowband)' : '(wideband)');
    };
    const reflectDecode = () => {
      if (!decodeEl) return;
      const s = agent.getDecodeLatencyStats();
      decodeEl.textContent = 'p50 ' + s.p50.toFixed(2) + ' ms · p95 ' + s.p95.toFixed(2) + ' ms · n=' + s.n;
    };
    reflectRate();
    reflectDecode();
    agent.addEventListener('audio-format-changed', reflectRate);
    agent.addEventListener('phone-compression-changed', reflectRate);
    // Poll decode stats 4 Hz while a call is live (it'd be event-storm
    // to update per-chunk; 250 ms is plenty).
    setInterval(() => {
      if (agent.isInCall()) reflectDecode();
    }, 250);
    // Pluck the encode_stats frame from the WS and display it.
    agent.addEventListener('server-frame', (e) => {
      const f = e && e.detail;
      if (!f || f.type !== 'encode_stats') return;
      if (!encodeEl) return;
      encodeEl.textContent = 'p50 ' + f.p50_us + ' µs · p95 ' + f.p95_us + ' µs · n=' + f.chunks;
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
  //     before calling). audio-flow: the unlock now also primes the
  //     three HTMLAudioElement lifecycle clips so the first
  //     pipeline.callAudio.playStart() isn't blocked by Safari.
  const firstGesture = () => {
    try { agent.unlockAudioSync(); } catch {}
    if (volume) agent.pipeline.setOutputVolume(Number(volume.value) / 100);
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
