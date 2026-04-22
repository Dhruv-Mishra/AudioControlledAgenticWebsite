// Voice-agent controller. Instantiated ONCE per document load (from
// js/app.js) and survives every SPA route change.
//
// UX model: the user must EXPLICITLY place a call. Nothing happens on
// page load — no WS, no mic, no noise, nothing. When the user clicks
// "Place Call", the agent transitions IDLE → DIALING, starts ambient
// noise IMMEDIATELY (so the dialling feels real), opens the WS, waits
// for Gemini `setup_complete`, and emits a `<call_initiated>` block so
// the model greets the user before they say anything.
//
// State machine (single source of truth — `VoiceAgent.state`):
//
//   IDLE           ← default on page load, after endCall, after idle-timeout
//   DIALING        ← user clicked Place Call; WS/mic coming up
//   LIVE_OPENING   ← WS connected, awaiting Gemini setup_complete
//   LIVE_READY     ← setup_complete received; ambient active; greeting injected
//   MODEL_THINKING ← user audio ended, model hasn't spoken yet
//   MODEL_SPEAKING ← audio chunks streaming back
//   TOOL_EXECUTING ← model requested a tool
//   ARMING         ← wake-word mode (advanced): listening for "Hey Jarvis"
//   CLOSING        ← graceful shutdown in progress (End Call clicked)
//   RECONNECTING   ← transient network blip mid-call; auto-retry with backoff
//   ERROR          ← terminal (until user retries Place Call)
//
// Ambient noise state machine (overlaid on main state):
//   ON  for {DIALING, LIVE_OPENING, LIVE_READY, MODEL_*, TOOL_EXECUTING, RECONNECTING}
//   OFF for {IDLE, ARMING, CLOSING, ERROR}
//   Fade-in 220 ms; fade-out 300 ms on endCall.
//
// Greeting injection:
//   On the first LIVE_READY AFTER a placeCall, VoiceAgent sends a
//   `call_start` text message to the server which wraps it in a
//   <call_initiated>…</call_initiated> block and injects via
//   session.sendClientContent({turnComplete: true}). Fires exactly once
//   per placeCall (`_greetingSent` flag). Reset on endCall.
//
// Cross-page / cross-reload resumption:
//   Session handle is still captured and persisted. Used on:
//     - explicit reconnect after network blip (auto)
//     - full tab reload (user re-places the call)
//   SPA navigation during a live call uses handleRouteChange() which
//   ships one page_context frame — no WS churn.
//
// Debug: ?debug=1 in URL or localStorage['jarvis.debug']='1'.

import { AudioPipeline } from './audio-pipeline.js';
import { WakeWordEngine } from './wake-word.js';
import { TranscriptLog } from './stt-logger.js';
import { ToolRegistry, scanAgentElements } from './tool-registry.js';
import { DEFAULT_PERSONAS, DEFAULT_PERSONA_ID } from './personas.js';
import { LocalStt } from './local-stt.js';

const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];
const MAX_RECONNECTS = 5;
const LIVE_IDLE_TIMEOUT_MS = 3 * 60 * 1000;
const PRESETUP_BUFFER_MAX_BYTES = 96 * 1024;
const AMBIENT_FADE_IN_MS = 220;
const AMBIENT_FADE_OUT_MS = 300;
const DIAL_TIMEOUT_MS = 15 * 1000; // if WS/setup doesn't complete in 15s → error

export const RESUME_WINDOW_MS = 10 * 60 * 1000;
export const IDLE_EXPIRY_MS = 10 * 60 * 1000;

const SESSION_STORAGE_KEY = 'jarvis.session';
const MAX_PERSISTED_TRANSCRIPT_LINES = 120;
const MAX_PERSISTED_TRANSCRIPT_BYTES = 80 * 1024;

const DEFAULT_COMPRESSION_ENABLED = true;
const DEFAULT_NOISE_MODE = 'office';
const DEFAULT_NOISE_VOLUME = 0.15;

export const STATES = Object.freeze({
  IDLE: 'idle',
  ARMING: 'arming',
  DIALING: 'dialing',
  LIVE_OPENING: 'live_opening',
  LIVE_READY: 'live_ready',
  MODEL_THINKING: 'model_thinking',
  MODEL_SPEAKING: 'model_speaking',
  TOOL_EXECUTING: 'tool_executing',
  CLOSING: 'closing',
  RECONNECTING: 'reconnecting',
  ERROR: 'error'
});

export const STATE_COPY = Object.freeze({
  idle: 'Not connected',
  arming: 'Listening for "Hey Jarvis"',
  dialing: 'Dialing…',
  live_opening: 'Connecting…',
  live_ready: 'Live — on call',
  model_thinking: 'Jarvis is thinking',
  model_speaking: 'Jarvis is speaking',
  tool_executing: 'Taking action',
  closing: 'Ending call',
  reconnecting: 'Reconnecting',
  error: 'Error'
});

// Single source of truth: a "call is active" from the moment the user
// clicks Place Call until the teardown begins. Ambient noise MUST play
// steadily during every one of these states — no exceptions. Any new
// mid-call state (e.g. USER_SPEAKING if we ever add one) must be added
// here so the invariant holds.
const CALL_ACTIVE_STATES = new Set([
  STATES.DIALING,
  STATES.LIVE_OPENING,
  STATES.LIVE_READY,
  STATES.MODEL_THINKING,
  STATES.MODEL_SPEAKING,
  STATES.TOOL_EXECUTING,
  STATES.RECONNECTING
]);

// States in which the Place/End call button should show "End Call".
export const IS_IN_CALL_STATES = new Set([
  STATES.LIVE_OPENING,
  STATES.LIVE_READY,
  STATES.MODEL_THINKING,
  STATES.MODEL_SPEAKING,
  STATES.TOOL_EXECUTING
]);
// States in which the button should show "Cancel" (call is still dialing).
export const IS_DIALING_STATES = new Set([
  STATES.DIALING
]);
// States in which the button is disabled (ending in progress).
export const IS_CLOSING_STATES = new Set([
  STATES.CLOSING
]);

const DEBUG = (() => {
  try {
    if (new URLSearchParams(location.search).get('debug') === '1') return true;
    if (localStorage.getItem('jarvis.debug') === '1') return true;
  } catch {}
  return false;
})();

function dlog(...args) {
  if (!DEBUG) return;
  // eslint-disable-next-line no-console
  console.log('[jarvis]', ...args);
}

function isLikelyInteractive(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

function loadPref(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    if (v == null) return fallback;
    return v;
  } catch { return fallback; }
}
function savePref(key, value) {
  try { localStorage.setItem(key, String(value)); } catch {}
}

function readSessionBlob() {
  let raw;
  try {
    raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
  } catch { return null; }
  if (!raw) return null;
  let obj;
  try { obj = JSON.parse(raw); } catch {
    try { sessionStorage.removeItem(SESSION_STORAGE_KEY); } catch {}
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const issuedAt = Number(obj.handleIssuedAt) || 0;
  if (issuedAt > 0 && Date.now() - issuedAt > IDLE_EXPIRY_MS) {
    try { sessionStorage.removeItem(SESSION_STORAGE_KEY); } catch {}
    return null;
  }
  return obj;
}

function writeSessionBlob(patch) {
  let current = readSessionBlob() || {};
  const next = { ...current, ...patch };
  if (Array.isArray(next.transcript)) {
    let arr = next.transcript.slice(-MAX_PERSISTED_TRANSCRIPT_LINES);
    let totalBytes = 0;
    const out = [];
    for (let i = arr.length - 1; i >= 0; i--) {
      const line = arr[i];
      const size = (line && line.text ? String(line.text).length : 0) + 32;
      if (totalBytes + size > MAX_PERSISTED_TRANSCRIPT_BYTES) break;
      totalBytes += size;
      out.unshift(line);
    }
    next.transcript = out;
  }
  try {
    sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(next));
  } catch {
    try {
      sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({
        handle: next.handle,
        handleIssuedAt: next.handleIssuedAt,
        mode: next.mode,
        persona: next.persona,
        muted: next.muted,
        compression: next.compression,
        noise: next.noise,
        noiseVolume: next.noiseVolume,
        transcript: []
      }));
    } catch {}
  }
}

function clearSessionBlob() {
  try { sessionStorage.removeItem(SESSION_STORAGE_KEY); } catch {}
}

export class VoiceAgent extends EventTarget {
  constructor({ transcriptEl, onNavigate } = {}) {
    super();
    this.pipeline = new AudioPipeline();
    this.transcript = transcriptEl ? new TranscriptLog(transcriptEl) : null;
    this.wake = null;
    this.ws = null;
    this.wsUrl = null;

    // Runtime feature flags — populated by init() from /api/config. Defaults
    // match the server defaults so pre-flag UI doesn't flash the wrong state.
    this.flags = {
      geminiTranscription: false,
      showText: true
    };
    // Local Web Speech transcriber — USER side only. Instantiated lazily in
    // init() only when the server disabled Gemini transcription AND
    // SHOW_TEXT=true; otherwise stays null.
    this.localStt = null;

    this.personas = DEFAULT_PERSONAS.slice();
    this.personaId = DEFAULT_PERSONA_ID;

    const restored = readSessionBlob();
    this._restored = restored;

    if (restored && restored.persona) this.personaId = String(restored.persona);
    // Mode is now an "advanced" setting. Default Live for Place Call, but
    // persist Wake Word opt-in. Mode is NOT auto-activated on boot.
    if (restored && (restored.mode === 'live' || restored.mode === 'wakeword')) {
      this.mode = restored.mode;
    } else {
      this.mode = loadPref('jarvis.mode', 'live') === 'wakeword' ? 'wakeword' : 'live';
    }

    this.resumeHandle = null;
    this.resumeHandleIssuedAt = null;
    if (restored && typeof restored.handle === 'string' && restored.handle) {
      const age = Date.now() - (Number(restored.handleIssuedAt) || 0);
      if (age <= RESUME_WINDOW_MS) {
        this.resumeHandle = restored.handle;
        this.resumeHandleIssuedAt = Number(restored.handleIssuedAt) || Date.now();
      }
    }
    this.resuming = !!this.resumeHandle;
    this.resumeOutcome = null;

    this.state = STATES.IDLE;
    this.lastDetail = null;

    this.muted = false; // mute is call-scoped; starts off each call
    this.playbackBlocked = false;

    this.compressionEnabled = typeof (restored && restored.compression) === 'boolean'
      ? restored.compression : DEFAULT_COMPRESSION_ENABLED;
    this.noiseMode = (restored && typeof restored.noise === 'string')
      ? restored.noise : DEFAULT_NOISE_MODE;
    this.noiseVolume = Number((restored && restored.noiseVolume) ?? NaN);
    if (!Number.isFinite(this.noiseVolume)) this.noiseVolume = DEFAULT_NOISE_VOLUME;
    this.noiseVolume = Math.max(0, Math.min(1, this.noiseVolume));

    this.setupComplete = false;
    this.preSetupBuffer = [];
    this.preSetupBytes = 0;
    this.closedByUser = false;
    this.reconnectIdx = 0;
    this.reconnectTimer = null;
    this.dialTimer = null;

    // Call-scoped flag: the greeting is sent exactly once per placeCall.
    // Reset on endCall / error.
    this._greetingSent = false;
    // Set while an explicit placeCall/endCall is in progress so downstream
    // state machines know this is user-initiated, not a reconnect.
    this._callActive = false;

    this.pageContextInjected = false;
    this._prevPathname = null;
    try {
      if (restored && restored.lastPath && restored.lastPath !== location.pathname) {
        this._prevPathname = restored.lastPath;
      }
    } catch {}
    this._currentPathname = location.pathname;

    this._pendingPageContext = null;

    this.liveStartedAt = null;
    this.liveIdleTimer = null;
    this.liveLastVoiceAt = null;

    this.metrics = {
      framesIn: 0,
      framesOut: 0,
      audioBytesIn: 0,
      audioBytesOut: 0,
      toolCalls: 0,
      reconnects: 0,
      connectedAt: null,
      callsPlaced: 0
    };

    this.toolRegistry = new ToolRegistry({
      sendTextMessage: (m) => this._sendJson(m),
      onNavigate: onNavigate || ((p) => { this._onAgentNavigate(p); }),
      onToolNote: (s) => this._logTool(s),
      // Live getter so the flag change after init() takes effect without
      // having to rebuild the registry.
      showText: () => !!this.flags.showText
    });

    // Wrap the registry's tool dispatch so activity indicator + other
    // listeners can observe tool-call lifecycle events. The original
    // handler is preserved; we just emit bracketing events.
    const origHandle = this.toolRegistry.handleToolCall.bind(this.toolRegistry);
    this.toolRegistry.handleToolCall = async (payload) => {
      const name = (payload && payload.name) || '';
      this._publishEvent('tool-call-start', { name, id: payload && payload.id });
      try {
        return await origHandle(payload);
      } finally {
        this._publishEvent('tool-call-end', { name, id: payload && payload.id });
      }
    };

    // Transcript mode: 'off' (hidden), 'captions' (overlay only), 'full'
    // (transcript panel). Default off-first-run per upgrade spec.
    // `localStorage['jarvis.ui.transcriptMode']` is the persistence key.
    this.transcriptMode = this._loadTranscriptMode();

    if (this.transcript && restored && Array.isArray(restored.transcript) && restored.transcript.length) {
      this.transcript.hydrate({ lines: restored.transcript });
    }

    this._onPageHide = () => this._persistSessionBlob();
    window.addEventListener('pagehide', this._onPageHide);
    window.addEventListener('beforeunload', this._onPageHide);

    this.pipeline.addEventListener('mic-ended', () => {
      dlog('mic track ended');
      this._announce({ from: 'system', text: 'Microphone disconnected. Check your input device.' });
      this._setState(STATES.ERROR, 'mic_ended');
      this._tearDownCall();
    });
    this.pipeline.addEventListener('mic-hw-mute', (e) => {
      if (e && e.detail && e.detail.muted) {
        this._announce({ from: 'system', text: 'Mic was muted by the system.' });
      }
    });
  }

  // ---------- public getters ----------
  getPersonas() { return this.personas; }
  getCurrentPersonaId() { return this.personaId; }
  getState() { return this.state; }
  getMode() { return this.mode; }
  isMuted() { return !!this.muted; }
  /** Current transcript display mode — 'off' | 'captions' | 'full'. Falls
   *  back to 'off' when the server flag `showText` is disabled. */
  getTranscriptMode() {
    if (!this.flags.showText) return 'off';
    return this.transcriptMode || 'off';
  }
  isPlaybackBlocked() { return this.pipeline.isPlaybackBlocked(); }
  getCompressionEnabled() { return !!this.compressionEnabled; }
  getNoiseMode() { return this.noiseMode; }
  getNoiseVolume() { return this.noiseVolume; }
  isResuming() { return !!this.resuming; }
  /** Runtime feature flags fetched from /api/config. Clone so callers
   *  can't mutate our copy. */
  getFlags() { return { ...this.flags }; }
  /** True whenever the UI should treat the call as "in progress" — from
   *  Place Call click until teardown begins. Covers DIALING, LIVE_*,
   *  MODEL_*, TOOL_EXECUTING, RECONNECTING. Single source of truth for
   *  the ambient-noise invariant: ambient ON ⟺ `isInCall()`. */
  isInCall() { return CALL_ACTIVE_STATES.has(this.state); }

  getMetrics() {
    return {
      ...this.metrics,
      state: this.state,
      mode: this.mode,
      muted: this.muted,
      resuming: this.resuming,
      resumeOutcome: this.resumeOutcome,
      ctxState: this.pipeline.ctx ? this.pipeline.ctx.state : 'none',
      captureState: this.pipeline.ctx && this.pipeline.capture ? 'capturing' : 'none',
      liveElapsedMs: this.liveStartedAt ? Date.now() - this.liveStartedAt : 0,
      wsState: this.ws ? this.ws.readyState : -1,
      setupComplete: !!this.setupComplete,
      greetingSent: !!this._greetingSent
    };
  }

  /** Create + resume AudioContext synchronously from a user gesture. */
  unlockAudioSync() {
    return this.pipeline.unlockAudioSync();
  }
  async unlockAudio() {
    return this.pipeline.ensureCtx();
  }

  // ---------- Call lifecycle (the new primary UX) ----------

  /**
   * User-initiated call start. MUST be called from inside a click/keydown
   * handler so the AudioContext unlock + getUserMedia gesture lineage
   * works on Chrome/iOS Safari.
   *
   * Flow:
   *   1. Unlock AudioContext synchronously (no await yet).
   *   2. Start ambient noise immediately — user hears the call "dial".
   *   3. Mark state DIALING.
   *   4. Open mic (await getUserMedia).
   *   5. Open WS → hello → wait for setup_complete.
   *   6. On setup_complete: transition to LIVE_READY + inject greeting.
   *
   * If the user clicks Cancel during dialing, `cancelDial()` tears down
   * without reaching LIVE_READY and returns to IDLE.
   */
  async placeCall() {
    if (this.state !== STATES.IDLE && this.state !== STATES.ERROR) {
      dlog('placeCall ignored — state=' + this.state);
      return false;
    }
    dlog('placeCall: user initiated');

    // Synchronously unlock audio BEFORE any await so Chrome honours the gesture.
    try { this.pipeline.unlockAudioSync(); } catch {}

    // Force this call to be Live (continuous) unless the user explicitly
    // chose Wake Word. Mode persists in storage but is not coercive here.
    if (this.mode !== 'live' && this.mode !== 'wakeword') this.mode = 'live';

    this._callActive = true;
    this._greetingSent = false;
    this.closedByUser = false;
    this.reconnectIdx = 0;
    this.muted = false;
    this.metrics.callsPlaced += 1;
    this.liveStartedAt = Date.now();
    this.liveLastVoiceAt = Date.now();

    // Stop wake-word (if running) — mode toggles are for between-calls only.
    if (this.wake) this.wake.stop();

    this._setState(STATES.DIALING);

    // Start the dial watchdog. If setup_complete isn't reached within
    // DIAL_TIMEOUT_MS, give up and surface an error.
    this._armDialTimer();

    // Open the mic (async). getUserMedia gesture lineage works because
    // placeCall was called synchronously from a click handler.
    try {
      await this._openMic();
    } catch (err) {
      dlog('placeCall mic open failed', err && err.message);
      this._setState(STATES.ERROR, 'mic_failed');
      this._tearDownCall();
      return false;
    }

    // Start local STT (user side only) — only runs when server has
    // GEMINI_TRANSCRIPTION=false AND SHOW_TEXT=true. Try the Whisper
    // controller first; fall back to Web Speech if unavailable.
    this._ensureSttController().then((ctrl) => {
      if (ctrl) {
        try { ctrl.start(); } catch {}
      } else if (this.localStt && this.localStt.supported) {
        this.localStt.start();
      }
    }).catch(() => {
      if (this.localStt && this.localStt.supported) this.localStt.start();
    });

    // Open the WS (non-blocking — onopen handles the rest).
    this._connect();
    return true;
  }

  /**
   * User clicked Cancel while dialing. Graceful: close WS and mic, fade
   * ambient out, return to IDLE.
   */
  async cancelDial() {
    if (this.state !== STATES.DIALING && this.state !== STATES.LIVE_OPENING) return;
    dlog('cancelDial: user initiated');
    await this._gracefullyEndCall('user_cancel');
  }

  /**
   * User clicked End Call. Graceful: send server close, fade ambient,
   * close mic + WS, return to IDLE.
   */
  async endCall() {
    if (!this.isInCall() && this.state !== STATES.DIALING) return;
    dlog('endCall: user initiated');
    await this._gracefullyEndCall('user_end');
  }

  async _gracefullyEndCall(reason) {
    const prevState = this.state;
    // _setState(CLOSING) drives _updateAmbient → OFF with fade-out.
    this._setState(STATES.CLOSING, reason);
    this.closedByUser = true;
    clearTimeout(this.dialTimer); this.dialTimer = null;
    clearInterval(this.liveIdleTimer); this.liveIdleTimer = null;
    if (this.localStt) this.localStt.stop();
    if (this._sttController) {
      try { this._sttController.stop(); } catch {}
    }

    // Flush any in-flight playback (no more Jarvis audio).
    this.pipeline.flushPlayback();
    if (this.transcript) this.transcript.turnBreak();

    // Tell the server we're done — they'll close upstream cleanly.
    try { this._sendJson({ type: 'call_end' }); } catch {}

    // Close mic + WS.
    try { await this._closeMic(); } catch {}
    this.pipeline.stopCapture();
    try { if (this.ws) this.ws.close(); } catch {}
    this.ws = null;

    this._callActive = false;
    this._greetingSent = false;
    this.setupComplete = false;
    this.preSetupBuffer = [];
    this.preSetupBytes = 0;
    this.liveStartedAt = null;
    this.liveLastVoiceAt = null;

    // Announce in the transcript so the user has a visual confirmation.
    this._announce({ from: 'system', text: 'Call ended.' });

    // Back to IDLE. Wake-word mode is opt-in and not auto-restarted
    // unless the user explicitly chose it as their default.
    if (this.mode === 'wakeword' && this.wake && this.wake.supported) {
      this.wake.start();
      this._setState(STATES.ARMING);
    } else {
      this._setState(STATES.IDLE);
    }

    this._persistSessionBlob();
    this._publishEvent('call-ended', { reason, prevState });
  }

  /** Internal teardown on fatal error (mic dies, invalid key, etc). */
  _tearDownCall() {
    clearTimeout(this.dialTimer); this.dialTimer = null;
    clearInterval(this.liveIdleTimer); this.liveIdleTimer = null;
    if (this.localStt) this.localStt.stop();
    if (this._sttController) {
      try { this._sttController.stop(); } catch {}
    }
    this.pipeline.flushPlayback();
    this.pipeline.stopCapture();
    try { if (this.ws) this.ws.close(); } catch {}
    this.ws = null;
    this._callActive = false;
    this._greetingSent = false;
    this.setupComplete = false;
    this.preSetupBuffer = [];
    this.preSetupBytes = 0;
    this.liveStartedAt = null;
    this.liveLastVoiceAt = null;
    // Ambient follows isInCall() via _updateAmbient when state becomes
    // ERROR (which the caller of _tearDownCall typically sets first).
    // Defensive call in case caller didn't transition state:
    this._updateAmbient();
  }

  _armDialTimer() {
    clearTimeout(this.dialTimer);
    this.dialTimer = setTimeout(() => {
      if (this.state === STATES.DIALING || this.state === STATES.LIVE_OPENING) {
        dlog('dial watchdog fired — giving up');
        this._announce({ from: 'system', text: 'Could not connect. Check your connection and API key, then try again.' });
        this._setState(STATES.ERROR, 'dial_timeout');
        this._tearDownCall();
      }
    }, DIAL_TIMEOUT_MS);
  }

  // ---------- Preferences ----------

  _loadTranscriptMode() {
    try {
      const raw = localStorage.getItem('jarvis.ui.transcriptMode');
      if (raw === 'off' || raw === 'captions' || raw === 'full') return raw;
    } catch {}
    return 'off';
  }

  /** Persist + broadcast a transcript display mode. Server override takes
   *  precedence at render time (see `getTranscriptMode`). */
  setTranscriptMode(mode) {
    const next = (mode === 'off' || mode === 'captions' || mode === 'full') ? mode : 'off';
    if (next === this.transcriptMode) {
      this._publishEvent('transcript-mode-changed', { mode: this.getTranscriptMode(), serverForced: !this.flags.showText });
      return next;
    }
    this.transcriptMode = next;
    try { localStorage.setItem('jarvis.ui.transcriptMode', next); } catch {}
    this._publishEvent('transcript-mode-changed', { mode: this.getTranscriptMode(), serverForced: !this.flags.showText });
    return next;
  }

  /** Shortcut for tool handlers — flip captions on/off without touching 'full'. */
  setCaptionsEnabled(enabled) {
    const curr = this.transcriptMode;
    if (enabled) {
      if (curr !== 'full') this.setTranscriptMode('captions');
    } else {
      if (curr === 'captions') this.setTranscriptMode('off');
    }
    return this.getTranscriptMode();
  }

  clearTranscript() {
    if (this.transcript) this.transcript.clearAll();
    clearSessionBlob();
    this.resumeHandle = null;
    this.resumeHandleIssuedAt = null;
    this.resuming = false;
    this.resumeOutcome = null;
    this._publishEvent('transcript-cleared', {});
  }

  setCompressionEnabled(on) {
    this.compressionEnabled = !!on;
    this.pipeline.setBandPassEnabled(this.compressionEnabled);
    this._persistSessionBlob();
    this._publishEvent('compression-changed', { enabled: this.compressionEnabled });
  }
  setNoiseMode(mode) {
    this.noiseMode = String(mode || 'off');
    this.pipeline.setNoiseMode(this.noiseMode);
    // Delegate to the single ambient driver — respects isInCall() and
    // the updated noiseMode together.
    this._updateAmbient();
    this._persistSessionBlob();
    this._publishEvent('noise-changed', { mode: this.noiseMode, volume: this.noiseVolume });
  }
  setNoiseVolume(v) {
    const n = Number(v);
    this.noiseVolume = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
    this.pipeline.setNoiseVolume(this.noiseVolume);
    this._persistSessionBlob();
    this._publishEvent('noise-changed', { mode: this.noiseMode, volume: this.noiseVolume });
  }

  /** Advanced-setting: switch between live-call and wake-word modes.
   *  Only meaningful when NOT in a call. During a call, is a no-op. */
  async setMode(nextMode) {
    const m = nextMode === 'wakeword' ? 'wakeword' : 'live';
    if (m === this.mode) return;
    // Don't let the user flip mode mid-call — End Call first.
    if (this.isInCall() || this.state === STATES.DIALING || this.state === STATES.CLOSING) {
      dlog('setMode ignored — in call');
      return;
    }
    dlog('mode switch', this.mode, '->', m);
    this.mode = m;
    savePref('jarvis.mode', m);

    // Stop or start wake-word appropriately.
    if (m === 'wakeword') {
      if (this.wake && this.wake.supported) this.wake.start();
      this._setState(STATES.ARMING);
    } else {
      if (this.wake) this.wake.stop();
      this._setState(STATES.IDLE);
    }

    this._persistSessionBlob();
    this._publishEvent('mode-changed', { mode: m });
  }

  async setPersona(id) {
    if (!this.personas.some((p) => p.id === id)) return;
    if (id === this.personaId) return;
    this.personaId = id;
    // If we're mid-call, a persona switch closes + reopens the upstream.
    // Reset setup gate and re-send.
    if (this.isInCall()) {
      this._resetSetupGate();
      this._sendJson({ type: 'persona', persona: id });
      this.pipeline.flushPlayback();
      if (this.transcript) this.transcript.turnBreak();
      this.resumeHandle = null;
      this.resumeHandleIssuedAt = null;
      // Ambient stays ON — the call is still alive, just reconfiguring.
      this._setState(STATES.LIVE_OPENING, 'persona_switch');
    }
    this._persistSessionBlob();
    this._publishEvent('persona-changed', { personaId: id });
  }

  _resetSetupGate() {
    this.setupComplete = false;
    this.preSetupBuffer = [];
    this.preSetupBytes = 0;
  }

  setMuted(muted) {
    const next = !!muted;
    if (next === this.muted) return;
    this.muted = next;
    this.pipeline.setMuted(next);
    // Local STT follows mute — no need to transcribe silence.
    if (this.localStt && this.isInCall()) this.localStt.setMuted(next);
    if (this._sttController && this.isInCall()) {
      try { this._sttController.setMuted(next); } catch {}
    }
    if (next && this.setupComplete) {
      this._sendJson({ type: 'stream_end' });
    }
    this._publishEvent('mute-changed', { muted: this.muted });
  }
  toggleMuted() { this.setMuted(!this.muted); }

  requestReconnect() {
    if (!this._callActive) { this.placeCall(); return; }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this._connect();
      return;
    }
    this._resetSetupGate();
    this._sendJson({ type: 'reconnect' });
  }

  // ---------- mic capture ----------
  async _ensureCaptureStarted() {
    try {
      await this.pipeline.ensureCtx();
      if (!this.pipeline.capture || this.pipeline.isMicEnded()) {
        await this.pipeline.startCapture({
          onPcmFrame: (int16) => this._sendAudio(int16)
        });
      }
      return true;
    } catch (err) {
      if (err && err.name === 'NotAllowedError') {
        this._setState(STATES.ERROR, 'mic_denied');
        this._announce({ from: 'system', text: 'Microphone access denied. Click the mic icon in your browser to grant it.' });
      } else {
        this._setState(STATES.ERROR, 'mic_failed');
        this._announce({ from: 'system', text: `Mic error: ${err.message || String(err)}` });
      }
      throw err;
    }
  }

  async _openMic() {
    await this._ensureCaptureStarted();
    this.pipeline.setCapturePaused(false);
    return true;
  }

  async _closeMic() {
    this.pipeline.setCapturePaused(true);
  }

  // ---------- WebSocket lifecycle (only used while a call is active) ----------
  _connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.wsUrl = `${proto}://${location.host}/api/live`;
    this._setState(STATES.LIVE_OPENING);
    try {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.binaryType = 'arraybuffer';
    } catch (err) {
      this._setState(STATES.ERROR, 'ws_failed');
      this._tearDownCall();
      return;
    }
    this.ws.onopen = () => {
      this.reconnectIdx = 0;
      this.metrics.connectedAt = Date.now();
      const elements = scanAgentElements();
      dlog('ws onopen, sending hello mode=' + this.mode + ' resume=' + (this.resumeHandle ? 'yes' : 'no'));
      const hello = {
        type: 'hello',
        persona: this.personaId,
        elements,
        page: this._currentPathname || location.pathname,
        mode: this.mode,
        userAgent: navigator.userAgent.slice(0, 120)
      };
      if (this.resumeHandle) {
        hello.resumeHandle = this.resumeHandle;
        hello.resumeHandleIssuedAt = this.resumeHandleIssuedAt || Date.now();
      }
      this._sendJson(hello);
    };
    this.ws.onmessage = (e) => this._onWsMessage(e);
    this.ws.onclose = () => this._onWsClose();
    this.ws.onerror = () => {};
  }

  _onWsClose() {
    this.ws = null;
    this._resetSetupGate();
    if (this.closedByUser) return;
    // Call isn't active (e.g. server shut during cleanup) — nothing to do.
    if (!this._callActive) return;
    if (this.state === STATES.ERROR && this.lastDetail === 'invalid_key') {
      this._tearDownCall();
      return;
    }
    if (this.reconnectIdx >= MAX_RECONNECTS) {
      this._setState(STATES.ERROR, 'ws_disconnected');
      this._tearDownCall();
      return;
    }
    const base = RECONNECT_DELAYS_MS[Math.min(this.reconnectIdx, RECONNECT_DELAYS_MS.length - 1)];
    const jitter = 0.5 + Math.random();
    const delay = Math.round(base * jitter);
    this.reconnectIdx += 1;
    this.metrics.reconnects += 1;
    this._setState(STATES.RECONNECTING, `retry in ${Math.round(delay / 1000)}s (${this.reconnectIdx}/${MAX_RECONNECTS})`);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this._connect(), delay);
  }

  _onWsMessage(e) {
    const data = e.data;
    if (typeof data === 'string') {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      this._onServerMessage(msg);
      return;
    }
    if (data instanceof ArrayBuffer) {
      if (data.byteLength === 0 || data.byteLength % 2 !== 0) {
        dlog('dropping bad audio frame bytes=' + data.byteLength);
        return;
      }
      const pcm = new Int16Array(data);
      this.metrics.framesIn += 1;
      this.metrics.audioBytesIn += data.byteLength;
      dlog('audio frame bytes=' + data.byteLength, 'samples=' + pcm.length, 'ctx=' + (this.pipeline.ctx ? this.pipeline.ctx.state : 'none'));
      this.pipeline.enqueuePcm24k(pcm);
      this._setState(STATES.MODEL_SPEAKING);
    }
  }

  _onServerMessage(msg) {
    dlog('server msg', msg.type, msg.state || msg.from || msg.code || '');
    switch (msg.type) {
      case 'hello_ack':
        if (Array.isArray(msg.personas) && msg.personas.length) this.personas = msg.personas;
        if (msg.mode && msg.mode !== this.mode) this.mode = msg.mode;
        this._publishEvent('personas-ready', { personas: this.personas });
        return;
      case 'setup_complete':
        this._onSetupComplete();
        return;
      case 'session_resumption':
        if (typeof msg.handle === 'string' && msg.handle) {
          this.resumeHandle = msg.handle;
          this.resumeHandleIssuedAt = Date.now();
          this._persistSessionBlob();
        }
        return;
      case 'session_resumed':
        this.resuming = false;
        this.resumeOutcome = 'ok';
        if (this.transcript) this.transcript.setPriorRowsDimmed(false);
        this._publishEvent('resume-result', { ok: true });
        return;
      case 'session_resume_failed':
        this.resuming = false;
        this.resumeOutcome = 'failed';
        this.resumeHandle = null;
        this.resumeHandleIssuedAt = null;
        if (this.transcript) this.transcript.setPriorRowsDimmed(true);
        this._persistSessionBlob();
        this._publishEvent('resume-result', { ok: false, reason: msg.reason || 'unknown' });
        return;
      case 'state':
        this._onServerStateHint(msg.state, msg.detail);
        return;
      case 'tool_call':
        this.metrics.toolCalls += 1;
        this._setState(STATES.TOOL_EXECUTING, msg.name);
        this.toolRegistry.handleToolCall(msg);
        return;
      case 'transcript_delta':
        this._onTranscriptDelta(msg);
        if (msg.from === 'user') this.liveLastVoiceAt = Date.now();
        return;
      case 'usage':
        this._publishEvent('usage', msg);
        return;
      case 'interrupted':
        if (this.transcript) this.transcript.turnBreak();
        this.pipeline.flushPlayback();
        this._setState(STATES.LIVE_READY);
        return;
      case 'turn_complete':
        if (this.transcript) this.transcript.turnBreak();
        this._setState(STATES.LIVE_READY);
        this._persistSessionBlob();
        this._publishEvent('turn-complete', {});
        return;
      case 'error':
        this._onServerError(msg);
        return;
      case 'pong':
        return;
    }
  }

  _onServerStateHint(s, detail) {
    if (s === 'error') { this._setState(STATES.ERROR, detail); return; }
    if (s === 'reconnecting') { this._setState(STATES.RECONNECTING, detail); return; }
    if (s === 'tool_executing') { this._setState(STATES.TOOL_EXECUTING, detail); return; }
    if (s === 'speaking') { this._setState(STATES.MODEL_SPEAKING); return; }
  }

  _onSetupComplete() {
    dlog('setup_complete');
    this.setupComplete = true;
    // Clear the dial watchdog — we made it.
    clearTimeout(this.dialTimer); this.dialTimer = null;
    this._setState(STATES.LIVE_READY);

    if (this.preSetupBuffer.length) {
      dlog('flushing preSetupBuffer frames=' + this.preSetupBuffer.length + ' bytes=' + this.preSetupBytes);
      for (const chunk of this.preSetupBuffer) this._sendBinaryRaw(chunk);
      this.preSetupBuffer = [];
      this.preSetupBytes = 0;
    }

    // Ensure the mic is open. setMode/placeCall should already have done this.
    if (!this.pipeline.capture) {
      this._openMic().catch(() => {});
    }

    // Greeting injection — exactly once per placeCall cycle.
    if (this._callActive && !this._greetingSent) {
      this._greetingSent = true;
      const page = this._currentPathname || location.pathname;
      const title = (document.title || '').slice(0, 120);
      dlog('greeting injection for page=' + page);
      this._sendJson({ type: 'call_start', page, title });
      // Mark page_context as injected too — the greeting covers the page.
      this.pageContextInjected = true;
    } else if (this._pendingPageContext) {
      // Normal mid-call navigation drain.
      const pc = this._pendingPageContext;
      this._pendingPageContext = null;
      this._sendPageContextFrame(pc);
      this.pageContextInjected = true;
    } else if (!this.pageContextInjected && this._currentPathname) {
      this.pageContextInjected = true;
      this._tryInjectPageContext();
    }

    this._armLiveIdleTimer();
  }

  handleRouteChange({ path }) {
    if (!path) return;
    if (path === this._currentPathname && this.pageContextInjected) return;
    this._prevPathname = this._currentPathname;
    this._currentPathname = path;
    this.pageContextInjected = false;
    this._persistSessionBlob();
    // Only ship page_context if a call is active; otherwise nothing to notify.
    if (this._callActive) this._tryInjectPageContext();
  }

  _persistSessionBlob() {
    const transcript = this.transcript ? this.transcript.serialize() : [];
    writeSessionBlob({
      handle: this.resumeHandle,
      handleIssuedAt: this.resumeHandleIssuedAt || (this.resumeHandle ? Date.now() : null),
      mode: this.mode,
      persona: this.personaId,
      muted: !!this.muted,
      compression: !!this.compressionEnabled,
      noise: this.noiseMode,
      noiseVolume: this.noiseVolume,
      lastPath: this._currentPathname || location.pathname,
      transcript
    });
  }

  _onAgentNavigate(path) {
    if (!path) return;
    try {
      sessionStorage.setItem('jarvis.lastNavNote', `Navigated here by Jarvis (${new Date().toLocaleTimeString()}).`);
    } catch {}
    this._persistSessionBlob();
    if (typeof window !== 'undefined' && window.__router && typeof window.__router.navigate === 'function') {
      window.__router.navigate(path);
    } else {
      location.href = path;
    }
  }

  _tryInjectPageContext() {
    const elements = scanAgentElements();
    const page = this._currentPathname || location.pathname;
    const title = (document.title || '').slice(0, 120);
    const payload = { page, title, elements };

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.setupComplete) {
      this._pendingPageContext = payload;
      dlog('queued page_context page=' + page + ' elements=' + elements.length + ' (ws/setup not ready)');
      return;
    }
    this._sendPageContextFrame(payload);
    this.pageContextInjected = true;
  }

  _sendPageContextFrame({ page, title, elements }) {
    dlog('inject page_context page=' + page + ' elements=' + elements.length);
    this._sendJson({ type: 'page_context', page, title, elements });
  }

  _onServerError(msg) {
    const code = msg.code || 'error';
    this._setState(STATES.ERROR, code);
    const text =
      code === 'invalid_key'
        ? 'Gemini rejected the API key. Set a valid GEMINI_API_KEY and restart the server.'
        : code === 'model_unavailable'
          ? 'Configured Gemini Live model is not available.'
          : code === 'rate_limited'
            ? 'Rate-limited by upstream. Give it a moment.'
            : code === 'mic_ended'
              ? 'Microphone disconnected.'
              : msg.message || `Error: ${code}`;
    this._announce({ from: 'system', text });
    // Fatal upstream errors end the call.
    this._tearDownCall();
  }

  _onTranscriptDelta(msg) {
    if (this.transcript) {
      this.transcript.addDelta({
        from: msg.from === 'agent' ? 'agent' : 'user',
        delta: msg.delta,
        finished: !!msg.finished
      });
    }
    // Republish agent-side deltas so the captions overlay (and any other
    // listener) can consume without poking the DOM transcript.
    if (msg && msg.from === 'agent') {
      this._publishEvent('agent-delta', {
        text: String(msg.delta || ''),
        finished: !!msg.finished
      });
    }
  }

  _sendJson(obj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try { this.ws.send(JSON.stringify(obj)); } catch {}
  }

  _sendBinaryRaw(buf) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(buf);
      this.metrics.framesOut += 1;
      this.metrics.audioBytesOut += buf.byteLength;
    } catch {}
  }

  _sendAudio(int16) {
    // Feed PCM to the on-device STT controller FIRST (non-blocking).
    // The controller handles VAD gating internally.
    if (this._sttController && typeof this._sttController.feedPcm === 'function' && !this.muted) {
      try { this._sttController.feedPcm(int16); } catch {}
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.muted) return;
    const view = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
    const copy = new Uint8Array(view.byteLength);
    copy.set(view);

    if (!this.setupComplete) {
      if (this.preSetupBytes + copy.byteLength > PRESETUP_BUFFER_MAX_BYTES) {
        while (this.preSetupBuffer.length && this.preSetupBytes + copy.byteLength > PRESETUP_BUFFER_MAX_BYTES) {
          const dropped = this.preSetupBuffer.shift();
          this.preSetupBytes -= dropped.byteLength;
        }
      }
      this.preSetupBuffer.push(copy.buffer);
      this.preSetupBytes += copy.byteLength;
      return;
    }
    this._sendBinaryRaw(copy.buffer);
    this.liveLastVoiceAt = Date.now();
  }

  sendElementsSnapshot() {
    const elements = scanAgentElements();
    this._sendJson({ type: 'elements', page: this._currentPathname || location.pathname, elements });
  }

  // ---------- wake word (advanced opt-in only) ----------
  _bootWakeWord() {
    this.wake = new WakeWordEngine({
      onWake: () => this._onWake(),
      onTranscript: ({ kind, text }) => this._onWakeTranscript(kind, text),
      onError: (err) => {
        if (/denied/i.test(err?.message || '')) this._setState(STATES.ERROR, 'mic_denied');
      },
      debug: DEBUG
    });
    if (this.mode === 'wakeword' && this.wake.supported) {
      this.wake.start();
      this._setState(STATES.ARMING);
    }
    this._publishEvent('wake-ready', { supported: this.wake.supported });
  }

  _onWake() {
    if (this.mode !== 'wakeword') return;
    if (this.isInCall()) return;
    if (Date.now() - (this._lastWakeAt || 0) < 2000) return;
    this._lastWakeAt = Date.now();
    this._announce({ from: 'system', text: 'Wake word heard.' });
    // Treat "Hey Jarvis" as a placeCall — transition cleanly.
    this.placeCall().catch(() => {});
  }

  _onWakeTranscript(kind, text) {
    if (kind !== 'final') return;
    this._sendJson({ type: 'transcript_event', kind, text, at: Date.now() });
  }

  _armLiveIdleTimer() {
    clearInterval(this.liveIdleTimer);
    this.liveIdleTimer = setInterval(() => {
      if (!this.isInCall()) return;
      const idle = Date.now() - (this.liveLastVoiceAt || Date.now());
      if (idle > LIVE_IDLE_TIMEOUT_MS) {
        dlog('Live call idle timeout — ending call');
        this._announce({ from: 'system', text: 'Call ended due to inactivity.' });
        this.endCall().catch(() => {});
      }
    }, 15_000);
  }

  // ---------- init ----------
  /**
   * Called once after the UI shell is built. Does NOT open the WS, does
   * NOT open the mic, does NOT start ambient. The user must click
   * Place Call to do any of that.
   *
   * The one exception: if `mode === 'wakeword'` was explicitly persisted,
   * we arm the wake-word listener so "Hey Jarvis" can start a call.
   */
  async init() {
    try {
      const cfg = await fetch('/api/config', { cache: 'no-store' }).then((r) => r.json());
      if (Array.isArray(cfg.personas) && cfg.personas.length) this.personas = cfg.personas;
      if (cfg.defaultPersona && !(this._restored && this._restored.persona)) {
        this.personaId = cfg.defaultPersona;
      }
      if (cfg.flags && typeof cfg.flags === 'object') {
        this.flags.geminiTranscription = !!cfg.flags.geminiTranscription;
        this.flags.showText = cfg.flags.showText !== false; // default true
      }
      // STT backend preference — used by stt-controller.js.
      if (typeof cfg.sttBackend === 'string') {
        this.flags.sttBackend = cfg.sttBackend === 'web-speech' ? 'web-speech' : 'whisper';
      }
    } catch {}
    this._setupKeyHotkey();
    this._bootWakeWord();
    this._initLocalStt();
    // No _connect() — WS opens only on placeCall.
    this._publishEvent('flags-ready', { flags: { ...this.flags } });
    this._publishEvent('personas-ready', { personas: this.personas });
  }

  /** Configure the local (browser-native) STT engine that transcribes USER
   *  speech when GEMINI_TRANSCRIPTION=false AND SHOW_TEXT=true. Idempotent.
   *  Attempts to upgrade to the Whisper-based `stt-controller` when
   *  available; falls back to Web Speech. */
  _initLocalStt() {
    const needLocal = this.flags.showText && !this.flags.geminiTranscription;
    if (!needLocal) {
      if (this.localStt) { this.localStt.stop(); this.localStt = null; }
      return;
    }
    if (this.localStt) return;
    this.localStt = new LocalStt({ debug: DEBUG });
    if (!this.localStt.supported) {
      dlog('LocalStt unsupported — user-side transcript will be empty.');
    } else {
      this.localStt.addEventListener('transcript', (ev) => {
        const { text, finished } = ev.detail || {};
        if (!this.transcript) return;
        this.transcript.addDelta({ from: 'user', delta: text, finished: !!finished });
        if (finished) {
          // Mirror the Gemini-side contract — a finished line emits a
          // transcript_event to the server for logging.
          this._sendJson({ type: 'transcript_event', kind: 'final', text, at: Date.now() });
        }
      });
    }
    // Try to upgrade to Whisper on the first placeCall. We don't import
    // here to keep the initial bundle small — `placeCall` does the
    // dynamic import on demand.
    this._sttController = null;
  }

  /** Dynamic-import the on-device STT controller on the first placeCall.
   *  Matches the contract in `specs/upgrade-stt-contract.md`. If the module
   *  isn't available or init fails unrecoverably, we fall back to Web
   *  Speech (`this.localStt`). Non-blocking. */
  async _ensureSttController() {
    if (this._sttController || this._sttControllerLoading) return this._sttController;
    if (!(this.flags.showText && !this.flags.geminiTranscription)) return null;
    this._sttControllerLoading = true;
    try {
      const mod = await import('./stt-controller.js');
      if (!mod || typeof mod.SttController !== 'function') {
        dlog('stt-controller missing SttController class; using LocalStt.');
        this._sttControllerLoading = false;
        return null;
      }
      const ctrl = new mod.SttController({
        debug: DEBUG,
        backend: this.flags.sttBackend || 'whisper',
        onPcmMicLevel: () => this.pipeline.readMicLevel()
      });
      this._sttController = ctrl;

      let lastSegmentId = null;
      ctrl.addEventListener('transcript', (ev) => {
        const { text, finished, segmentId } = ev.detail || {};
        if (!text) return;
        // When a new segment starts, close the previous live user row so
        // the next partial starts fresh (prevents the repeat-phrase bug).
        if (this.transcript && segmentId && segmentId !== lastSegmentId) {
          if (lastSegmentId) {
            try { this.transcript.turnBreak(); } catch {}
          }
          lastSegmentId = segmentId;
        }
        if (this.transcript) {
          this.transcript.addDelta({ from: 'user', delta: text, finished: !!finished });
        }
        if (finished) {
          this._sendJson({ type: 'transcript_event', kind: 'final', text, at: Date.now() });
        }
      });
      ctrl.addEventListener('progress', (ev) => {
        const d = ev.detail || {};
        dlog('stt progress', d.stage, d.loaded, '/', d.total);
      });
      ctrl.addEventListener('ready', (ev) => {
        const backend = ev.detail && ev.detail.backend;
        dlog('stt ready backend=' + backend);
      });
      ctrl.addEventListener('error', (ev) => {
        const code = ev.detail && ev.detail.code;
        dlog('stt error', code);
        if (code === 'model_fetch') {
          this._showSttRetryBanner(ctrl);
        } else if (code === 'worker_crash') {
          this._announce({ from: 'system', text: 'Transcription worker crashed. Continuing without captions.' });
          try { ctrl.destroy && ctrl.destroy(); } catch {}
          this._sttController = null;
          if (this.localStt && this.localStt.supported) this.localStt.start();
        } else if (code === 'no_backend') {
          this._announce({ from: 'system', text: 'Transcription unavailable in this browser.' });
          try { ctrl.destroy && ctrl.destroy(); } catch {}
          this._sttController = null;
        }
      });
      ctrl.addEventListener('needs_consent', () => this._showSttConsentBanner(ctrl));
      ctrl.addEventListener('backend_changed', (ev) => {
        const d = ev.detail || {};
        dlog('stt backend_changed', d.from, '->', d.to, d.reason);
      });

      // Kick off init. This downloads the model on first call unless
      // needs_consent is emitted and the user accepts later.
      ctrl.init().catch((err) => {
        dlog('stt init rejected', err && err.message);
      });

      this._sttControllerLoading = false;
      return ctrl;
    } catch (err) {
      dlog('stt-controller import failed', err && err.message);
      this._sttControllerLoading = false;
      return null;
    }
  }

  _showSttRetryBanner(ctrl) {
    const el = document.getElementById('voice-error');
    if (!el) return;
    el.replaceChildren();
    el.appendChild(document.createTextNode("Couldn't download transcription model. "));
    const retry = document.createElement('button');
    retry.textContent = 'Retry';
    retry.setAttribute('data-agent-id', 'voice.stt.retry');
    retry.style.marginLeft = '8px';
    retry.addEventListener('click', () => {
      el.hidden = true;
      try { ctrl.init && ctrl.init({ acceptLargeDownload: true }); } catch {}
    });
    el.appendChild(retry);
    el.hidden = false;
  }

  _showSttConsentBanner(ctrl) {
    const el = document.getElementById('voice-error');
    if (!el) return;
    el.replaceChildren();
    el.appendChild(document.createTextNode('Download 40 MB transcription model for better captions? '));
    const dl = document.createElement('button');
    dl.textContent = 'Download';
    dl.setAttribute('data-agent-id', 'voice.stt.consent.accept');
    dl.style.marginLeft = '8px';
    dl.addEventListener('click', () => {
      try { ctrl.init && ctrl.init({ acceptLargeDownload: true }); } catch {}
      try { localStorage.setItem('jarvis.stt.opted', '1'); } catch {}
      el.hidden = true;
    });
    const skip = document.createElement('button');
    skip.textContent = 'Skip';
    skip.setAttribute('data-agent-id', 'voice.stt.consent.skip');
    skip.style.marginLeft = '8px';
    skip.addEventListener('click', () => {
      try { ctrl.destroy && ctrl.destroy(); } catch {}
      this._sttController = null;
      if (this.localStt && this.localStt.supported) this.localStt.start();
      try { localStorage.setItem('jarvis.stt.opted', '0'); } catch {}
      el.hidden = true;
    });
    el.appendChild(dl);
    el.appendChild(skip);
    el.hidden = false;
  }

  _setupKeyHotkey() {
    window.addEventListener('keydown', (e) => {
      // M = toggle mute (only meaningful during a call).
      if (e.code === 'KeyM' && !isLikelyInteractive(e.target) && !e.repeat) {
        if (this.isInCall()) {
          e.preventDefault();
          this.toggleMuted();
        }
      }
    });
  }

  _setState(state, detail) {
    if (this.state === state && this.lastDetail === detail) return;
    const wasActive = CALL_ACTIVE_STATES.has(this.state);
    this.state = state;
    this.lastDetail = detail;
    dlog('state ->', state, detail || '');

    // Ambient noise: single-point driver. Invariant is "isInCall()"
    // AND the user hasn't picked noise=off. No other code path in the
    // agent should touch setAmbientOn directly.
    this._updateAmbient({ wasActive });

    this._publishEvent('state', { state, detail });
  }

  /** Single place that maps agent state → AudioPipeline.setAmbientOn.
   *  Called from _setState on every transition AND from setNoiseMode
   *  (so flipping noise mode mid-call reflects immediately). Idempotent:
   *  setAmbientOn with the same target is a cheap no-op ramp. */
  _updateAmbient({ wasActive = CALL_ACTIVE_STATES.has(this.state) } = {}) {
    const shouldBeOn = this.isInCall() && this.noiseMode !== 'off';
    // Use the fade-in constant only when we were NOT previously in a
    // call state; on transitions between call states (e.g. LIVE_READY ↔
    // MODEL_SPEAKING) we keep ambient steadily at target with a
    // near-instant ramp. The AudioPipeline's setTargetAtTime is already
    // smooth so even re-asserting the same target mid-call is safe.
    const fadeMs = shouldBeOn
      ? (wasActive ? 40 : AMBIENT_FADE_IN_MS)
      : AMBIENT_FADE_OUT_MS;
    this.pipeline.setAmbientOn(shouldBeOn, { fadeMs });
  }

  _publishEvent(name, payload) {
    this.dispatchEvent(new CustomEvent(name, { detail: payload }));
  }

  _announce({ from, text }) {
    if (!this.transcript) return;
    this.transcript.add({ from: from || 'system', text });
  }

  _logTool(note) {
    if (!this.transcript) return;
    this.transcript.add({ from: 'tool', text: note });
  }

  async close() {
    this.closedByUser = true;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.dialTimer);
    clearInterval(this.liveIdleTimer);
    try { window.removeEventListener('pagehide', this._onPageHide); } catch {}
    try { window.removeEventListener('beforeunload', this._onPageHide); } catch {}
    try { this.ws && this.ws.close(); } catch {}
    try { this.wake && this.wake.stop(); } catch {}
    try { this.localStt && this.localStt.stop(); } catch {}
    try { this._sttController && this._sttController.destroy && this._sttController.destroy(); } catch {}
    await this.pipeline.close();
  }
}
