// Voice-agent controller. Instantiated ONCE per document load (from
// js/app.js) and survives every SPA route change.
//
// UX model: the user must EXPLICITLY place a call. Nothing happens on
// page load — no WS, no mic, no audio, nothing. When the user clicks
// "Place Call", the agent transitions IDLE → DIALING, plays the
// startCall chime while dialling the WS and opening the mic, holds
// Gemini's greeting until the chime ends AND setup_complete fires, then
// begins the looping background ambience.
//
// State machine (single source of truth — `VoiceAgent.state`):
//
//   IDLE           ← default on page load, after endCall, after idle-timeout
//   DIALING        ← user clicked Place Call; WS/mic coming up
//   LIVE_OPENING   ← WS connected, awaiting Gemini setup_complete
//   LIVE_READY     ← setup_complete received; background active; greeting injected
//   MODEL_THINKING ← user audio ended, model hasn't spoken yet
//   MODEL_SPEAKING ← audio chunks streaming back
//   TOOL_EXECUTING ← model requested a tool
//   ARMING         ← wake-word mode (advanced): listening for "Hey Jarvis"
//   CLOSING        ← graceful shutdown in progress (End Call clicked)
//   RECONNECTING   ← transient network blip mid-call; auto-retry with backoff
//   ERROR          ← terminal (until user retries Place Call)
//
// audio-flow: Call-audio choreography is owned by AudioPipeline.callAudio
// and driven from placeCall / the greet-gate / endCall. There is no
// procedural noise bed any more — just three clips:
//   • startCall  — plays once on Place Call; dialling buffer.
//   • background — loops at low volume while the call is live, guarded
//     by the user's Background audio toggle (default on).
//   • endCall    — plays once during hangup; awaited before WS close.
//
// Greeting injection (greeting-fix + audio-flow):
//   Three gates must close for the server to release the greeting:
//     (a) upstream `setup_complete` has arrived,
//     (b) a greet intent is pending (hello.greet or explicit call_start),
//     (c) the client's start-audio gate has opened.
//   Gate (c) is new — the client sends `{type:'greet_gate_open'}` to the
//   server once the startCall chime has ended (or timed out). Without it
//   Gemini would speak over the chime. Fires exactly once per placeCall
//   (`_greetingSent` + `_greetGateOpened` flags). Both reset on endCall.
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

// latency-pass: first retry drops 1000ms → 300ms. Transient WS blips (a WAN
// hiccup, a load-balancer restart) used to cost a full second of dead-air
// before the browser even tried to reconnect. 300ms is still long enough to
// let the socket layer settle but short enough that a brief stall doesn't
// feel like the call died. Subsequent retries keep exponential back-off
// unchanged so we never hammer the server during a real outage.
const RECONNECT_DELAYS_MS = [300, 1000, 2500, 6000, 12000];
const MAX_RECONNECTS = 5;
const LIVE_IDLE_TIMEOUT_MS = 3 * 60 * 1000;
const PRESETUP_BUFFER_MAX_BYTES = 96 * 1024;
const DIAL_TIMEOUT_MS = 15 * 1000; // if WS/setup doesn't complete in 15s → error

export const RESUME_WINDOW_MS = 10 * 60 * 1000;
export const IDLE_EXPIRY_MS = 10 * 60 * 1000;

const SESSION_STORAGE_KEY = 'jarvis.session';
const MAX_PERSISTED_TRANSCRIPT_LINES = 120;
const MAX_PERSISTED_TRANSCRIPT_BYTES = 80 * 1024;

// audio-flow: single source of truth for the Background audio toggle.
// Default ON. Persists to localStorage; takes effect immediately when
// flipped mid-call.
const BACKGROUND_AUDIO_STORAGE_KEY = 'jarvis.backgroundAudio';
const DEFAULT_BACKGROUND_ENABLED = true;

// audio-flow: phone-line compression toggle. Default ON so new visitors
// hear Jarvis with the intended call-center character. Persists to
// localStorage; takes effect immediately via a 50ms crossfade.
// latency-pass: when ON, the server also downshifts agent audio to
// narrowband (8 kHz mono PCM16) to halve network bytes per frame.
const PHONE_COMPRESSION_STORAGE_KEY = 'jarvis.phoneCompression';
const DEFAULT_PHONE_COMPRESSION = true;

// Round-2 req 2: transcript mode defaults to 'full' so first-run users
// see what Jarvis says. The canonical localStorage key is
// `liveAgent.transcriptMode`; the pre-round-2 builds wrote to
// `jarvis.ui.transcriptMode` — we read either (new first, legacy
// fallback), then write BOTH on every save so a browser cache from any
// era stays correct. Accepted values: 'off' | 'captions' | 'full'.
const TRANSCRIPT_MODE_STORAGE_KEY = 'liveAgent.transcriptMode';
const TRANSCRIPT_MODE_LEGACY_KEY = 'jarvis.ui.transcriptMode';
const DEFAULT_TRANSCRIPT_MODE = 'full';

// Round-2 req 2: persona, previously session-scoped (sessionStorage via
// the session blob), is promoted to localStorage so the user's pick
// survives browser restarts. The session blob still carries persona
// for mid-session resume — we just mirror it here too.
const PERSONA_STORAGE_KEY = 'liveAgent.persona';

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
// clicks Place Call until the teardown begins. audio-flow: background
// ambience follows `isInCall() && backgroundEnabled` — any new mid-call
// state MUST be added here so the invariant holds.
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
      // audio-flow: fallback blob no longer includes the retired compression /
      // noise keys. backgroundEnabled lives in localStorage, not the session
      // blob — it's a cross-call preference, not call-scoped.
      sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({
        handle: next.handle,
        handleIssuedAt: next.handleIssuedAt,
        mode: next.mode,
        persona: next.persona,
        muted: next.muted,
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
    // Round-8 test hook: if URL has `?r8hook=1`, stash this instance on
    // `window.__r8Agent` so the Playwright end-call harness can fire
    // synthetic server frames into `_onServerMessage`. Gated strictly
    // to `r8hook=1` so production pages don't expose the agent. Single
    // line; zero impact on the critical call path.
    try {
      if (typeof window !== 'undefined' && /[?&]r8hook=1(&|$)/.test(location.search)) {
        window.__r8Agent = this;
      }
    } catch {}
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

    // Voice pinning: user-selected voice persists across calls via
    // localStorage. Locked at call open; the server echoes back the
    // pinned voice in hello_ack.
    this.selectedVoice = null;
    this.pinnedVoice = null;
    // Transcription dedup: barge-in suppression window.
    this._suppressUserTxUntil = 0;
    // Transcription dedup: resume grace period.
    this._resumeGraceUntil = 0;
    try {
      const stored = localStorage.getItem('liveAgent.voice');
      if (stored && typeof stored === 'string') this.selectedVoice = stored;
    } catch {}

    this.personas = DEFAULT_PERSONAS.slice();
    this.personaId = DEFAULT_PERSONA_ID;

    // Drop any prior-call state (resume handle, transcript) so a page
    // refresh starts fresh — reduces upstream token cost and avoids the
    // agent "remembering" a previous conversation. Persona/mode survive
    // because they live in localStorage, read just below.
    clearSessionBlob();
    const restored = null;
    this._restored = null;

    // Round-2 req 2: persona now persists across browser restarts via
    // localStorage. Precedence: in-tab session blob (live call restore)
    // → localStorage pick → hard default. The session blob takes first
    // place so a mid-session change doesn't get clobbered by a stale
    // localStorage value from another tab that just wrote.
    if (restored && restored.persona) {
      this.personaId = String(restored.persona);
    } else {
      try {
        const stored = localStorage.getItem(PERSONA_STORAGE_KEY);
        if (stored && this.personas.some((p) => p.id === stored)) {
          this.personaId = stored;
        }
      } catch {}
    }
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

    // audio-flow: background-audio toggle. Persists in localStorage; the
    // session blob is no longer the source of truth so cross-tab changes
    // stay consistent. Default ON so a fresh visitor hears the ambience.
    this.backgroundEnabled = this._loadBackgroundEnabled();
    try { this.pipeline.callAudio.setBackgroundEnabled(this.backgroundEnabled); } catch {}

    // audio-flow: phone-line compression toggle. Persists in localStorage;
    // default OFF. Applied immediately to the pipeline so a pre-existing
    // preference survives reloads. The crossfade is a no-op until the
    // AudioContext exists (first placeCall), so loading it here is safe.
    this.phoneCompression = this._loadPhoneCompression();
    try { this.pipeline.setPhoneCompression(this.phoneCompression); } catch {}

    // Output volume. Persists to localStorage under 'liveAgent.volume';
    // range [0, 1.5], default 1.0. Applied immediately to the pipeline.
    this.outputVolume = this._loadVolume();
    try { this.pipeline.setOutputVolume(this.outputVolume); } catch {}

    // audio-prefs: the server may negotiate a narrowband output (8 kHz)
    // when phoneLine=true. Default 24 kHz tracks the Gemini Live native
    // output rate and is the safe fallback when the server hasn't sent
    // an `audio_format` message yet.
    this._agentAudioRate = 24000;
    this._agentAudioPhoneLine = !!this.phoneCompression;

    // latency-pass: rolling decode-latency buffer for the debug HUD. Keep
    // only the most recent 256 chunks so it can't leak memory on a long
    // call. p50 / p95 are computed on demand when the HUD renders.
    this._decodeLatencyBuf = [];

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
    // audio-flow: start-audio gate tracking. Resolves when the startCall
    // clip has either finished or hit its safety cap. Separate from
    // `_greetingSent` — we can send `greet_gate_open` to the server
    // independently of whether Gemini has yet issued the greeting.
    this._greetGateOpened = false;
    this._callOpenPromise = null;
    // audio-flow: idempotency flag for the end-call sequence. Guards
    // against a user click, a server `end_call_requested`, AND the
    // agent's own `end_call` tool all firing in quick succession.
    this._endingCall = false;
    // Round-6 fix 2: deterministic end-call chain state.
    //   `_agentEndingArmed` — true after `end_call_requested` arrives
    //     and until both turn_complete + agent-playback-drained have
    //     fired (or the safety timeout). Idempotent latch against
    //     duplicate frames.
    //   `_agentTurnComplete` / `_agentAudioDrained` — the two event
    //     flags; both must be true before we call `_gracefullyEndCall`.
    //   `_agentEndingTimer` — 10 s safety timeout.
    //   `_agentEndingListeners` — the handlers we attached (for
    //     teardown). Stored so we can remove them on early kill.
    this._agentEndingArmed = false;
    this._agentTurnComplete = false;
    this._agentAudioDrained = false;
    this._agentEndingTimer = null;
    this._agentEndingGraceTimer = null;
    this._agentEndingListeners = null;
    // Round-3 fix 1: label for the parallel-init `console.time` span.
    // Set at the top of placeCall; closed on setup_complete OR on any
    // teardown so the label never leaks between calls.
    this._initSpanLabel = null;
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
      showText: () => !!this.flags.showText,
      // Live getter for the transcript display mode. ToolRegistry only
      // emits UI notes when this returns 'full'; off/captions modes keep
      // the transcript clean. Tool execution itself is unaffected.
      transcriptMode: () => this.getTranscriptMode()
    });

    // Wrap the registry's tool dispatch so activity indicator + other
    // listeners can observe tool-call lifecycle events. The original
    // handler is preserved; we just emit bracketing events.
    const origHandle = this.toolRegistry.handleToolCall.bind(this.toolRegistry);
    // Capture the last tool_result ok status by intercepting the send path.
    this._lastToolResultOk = true;
    const origSendJson = this._sendJson.bind(this);
    const captureToolResult = (m) => {
      if (m && m.type === 'tool_result' && m.ok === false) {
        this._lastToolResultOk = false;
      } else if (m && m.type === 'tool_result') {
        this._lastToolResultOk = true;
      }
      origSendJson(m);
    };
    this.toolRegistry.send = captureToolResult;
    this._toolFailureSilenceTimer = null;
    this.toolRegistry.handleToolCall = async (payload) => {
      const name = (payload && payload.name) || '';
      this._publishEvent('tool-call-start', { name, id: payload && payload.id });
      try {
        const result = await origHandle(payload);
        // Tool-failure silence fallback: if the tool result was ok:false
        // and the model doesn't speak within 4 s, inject a notice.
        if (!this._lastToolResultOk) {
          this._startToolFailureSilenceTimer();
        }
        return result;
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
    // audio-flow: forward the "all audio stopped" signal so UI can flip
    // the End Call button back to green only after every last sample has
    // played out (requirement 6). Also forward state changes so the dock
    // can reflect background-playing status.
    this.pipeline.addEventListener('call-audio-all-stopped', () => {
      this._publishEvent('call-audio-all-stopped', {});
    });
    this.pipeline.addEventListener('call-audio-changed', (e) => {
      this._publishEvent('call-audio-changed', e && e.detail ? e.detail : {});
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
  /** audio-flow: whether the user wants background ambience during a call. */
  getBackgroundEnabled() { return !!this.backgroundEnabled; }
  /** audio-flow: whether the user wants Jarvis filtered through the
   *  phone-line compression sub-graph (bandpass + compressor). */
  getPhoneCompression() { return !!this.phoneCompression; }
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

  /** Create + resume AudioContext synchronously from a user gesture.
   *  audio-flow: also primes the HTMLAudioElement lifecycle clips so the
   *  first playCallOpen() isn't blocked by Safari's autoplay policy. */
  unlockAudioSync() {
    const ctx = this.pipeline.unlockAudioSync();
    return ctx;
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
   * audio-flow flow:
   *   1. Unlock AudioContext + <audio> elements synchronously (no await yet).
   *   2. Mark state DIALING.
   *   3. Kick off the callOpen clip WITHOUT awaiting it — it runs
   *      in parallel with the WS/mic handshake. We capture a promise
   *      (`_callOpenPromise`) that resolves on ended/error/timeout.
   *   4. Open mic (await getUserMedia).
   *   5. Open WS → hello (with greet intent) → wait for setup_complete.
   *   6. When BOTH the call-open promise resolves AND setup_complete
   *      fires, send `greet_gate_open` to the server — that releases
   *      Gemini's greeting — and start the background audio loop (if
   *      the user's toggle is on).
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

    // Round-3 fix 1: the critical-path ordering inside this click-tick
    // determines how much agent init overlaps with the callOpen audio.
    // We explicitly front-load the steps whose network/permission cost
    // is longest — WebSocket handshake + getUserMedia — BEFORE we start
    // playing the 15.7 s callOpen clip. The audio then runs in parallel
    // with WS handshake → hello → upstream Gemini handshake →
    // `setup_complete`. Both tracks converge at the listen-gate
    // (round-2 req 3): capture un-pauses when BOTH the near-end audio
    // event AND `setup_complete` have fired. Target: setup_complete
    // should land within ~0.5–2 s of the click, i.e. many seconds
    // BEFORE the audio's last-second listen-gate.

    // latency-pass (round-3 fix 1): phase telemetry stamped AT THE VERY
    // TOP of the tick so every downstream sub-span is measurable. Zero
    // cost unless `jarvis.debug=1` — `_logPhase` is a no-op then — but
    // we still stamp the timestamps so production can be instrumented
    // without re-deploying. Also writes a pair of `console.time` marks
    // so DevTools' Performance panel shows the parallel init span.
    const placeCallAt = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this._phaseTimestamps = {
      placeCallAt,
      wsCreatedAt: null,
      wsOpenAt: null,
      micRequestedAt: null,
      micReadyAt: null,
      audioPlayStartedAt: null,
      audioListenGateAt: null,  // retained for round-2 compat (no longer wired)
      audioEndedAt: null,        // round-4: callOpen fully finished
      firstFrameSentAt: null,
      setupCompleteAt: null,
      firstTokenAt: null
    };
    if (DEBUG && typeof console !== 'undefined' && typeof console.time === 'function') {
      // A unique label per placeCall avoids collisions across retries.
      this._initSpanLabel = 'jarvis.init-parallel-span.' + Math.random().toString(36).slice(2, 8);
      try { console.time(this._initSpanLabel); } catch {}
    } else {
      this._initSpanLabel = null;
    }

    // 1. SYNC: unlock the AudioContext + <audio> elements. Must happen
    //    before anything awaits so Chrome/iOS honour the user-gesture
    //    for autoplay. Cheap (~0.1 ms).
    try { this.pipeline.unlockAudioSync(); } catch {}
    // audio-flow: clear any hard-kill latch left over from the previous
    // endCall so the new call's audio can play.
    try { this.pipeline.callAudio.armForNextCall(); } catch {}

    // Force this call to be Live (continuous) unless the user explicitly
    // chose Wake Word. Mode persists in storage but is not coercive here.
    if (this.mode !== 'live' && this.mode !== 'wakeword') this.mode = 'live';

    this._callActive = true;
    this._greetingSent = false;
    // audio-flow: reset gate + idempotency state for this call.
    this._greetGateOpened = false;
    this._endingCall = false;
    // audio-flow: explicit "start-call chime has settled" flag. Cleaner
    // than poking the controller's internal `_startPlaying` — this flips
    // exactly when we want the greet-gate logic to proceed.
    this._callOpenSettled = false;
    // Round-2 req 3 (updated in round-4): listening gate. The mic stays
    // PAUSED (no frames forwarded upstream) until BOTH:
    //   (a) `_listenGateOpen` — callOpen playback has ACTUALLY ENDED
    //       (round-4: moved from the round-2 "last 1 second" trigger to
    //       the clean `ended` event), OR the audio fell back via
    //       error / timeout / hard-kill / no-duration. AND
    //   (b) `_listenGateSetupComplete` — server `setup_complete` has
    //       fired.
    // `_openListenGateIfReady()` wraps the AND and calls
    // `setCapturePaused(false)` once both are true.
    this._listenGateOpen = false;
    this._listenGateSetupComplete = false;
    this._listenGateFallbackLogged = false;
    // Round-5: client-side playback buffering was retired. The upstream
    // (api/live-bridge.js::maybeFireGreeting) already gates the greeting
    // trigger on the client's `greet_gate_open` frame, which is itself
    // sent only after callOpen's `ended` event. No TTS audio can be
    // generated during callOpen, so no client-side buffer is needed.
    // A safety-belt log in `_onWsMessage` catches any regression.
    this._preSettleAudioWarned = false;
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

    // 2. FIRE WebSocket FIRST. `new WebSocket(...)` is synchronous; the
    //    TCP + TLS handshake runs off-thread in the browser. By kicking
    //    this off before any other work we give the handshake the
    //    earliest possible head-start — typically ~50–150 ms of raw
    //    wall-clock savings vs. running this after playCallOpen's
    //    setup work.
    this._connect();
    if (this._phaseTimestamps) {
      this._phaseTimestamps.wsCreatedAt = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      this._logPhase('ws_created', this._phaseTimestamps.placeCallAt, this._phaseTimestamps.wsCreatedAt);
    }

    // 3. FIRE mic permission / getUserMedia. Gesture lineage is
    //    preserved because we're still inside the click-tick (no await
    //    has happened yet). If the user hasn't granted mic before, the
    //    prompt appears now and the user can click Allow while the
    //    audio is already playing and the WS is already opening.
    if (this._phaseTimestamps) {
      this._phaseTimestamps.micRequestedAt = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      this._logPhase('mic_requested', this._phaseTimestamps.placeCallAt, this._phaseTimestamps.micRequestedAt);
    }
    const micPromise = this._openMic()
      .then((result) => {
        if (this._phaseTimestamps) {
          this._phaseTimestamps.micReadyAt = (typeof performance !== 'undefined' ? performance.now() : Date.now());
          this._logPhase('mic_ready', this._phaseTimestamps.placeCallAt, this._phaseTimestamps.micReadyAt);
        }
        return result;
      })
      .catch((err) => {
        dlog('placeCall mic open failed', err && err.message);
        this._setState(STATES.ERROR, 'mic_failed');
        this._tearDownCall();
        throw err;
      });

    // 4. FIRE the STT controller dynamic import in parallel with
    //    everything else. Non-blocking — starts the chunk fetch so the
    //    worker + WASM are warm by the time the user actually speaks.
    this._ensureSttController().then((ctrl) => {
      if (ctrl) {
        try { ctrl.start(); } catch {}
      } else if (this.localStt && this.localStt.supported) {
        this.localStt.start();
      }
    }).catch(() => {
      if (this.localStt && this.localStt.supported) this.localStt.start();
    });

    // 5. FIRE the callOpen audio clip LAST in the click-tick. The WS +
    //    mic + STT imports are now all racing; the ~15.7 s audio runs
    //    in parallel with them. `playCallOpen` never rejects — the
    //    wrapper IIFE swallows any controller surprises.
    //
    //    Round-4: BOTH the listen gate (capture → upstream) AND the
    //    playback gate (agent PCM → speakers) are now tied to the
    //    actual `ended` event — not the round-2 "last 1 second" lead.
    //    The `onAudioEnded` callback fires once on `ended` / `short_clip`
    //    / fallback reasons. `listenGateLeadMs: 0` disables the
    //    near-end preview callback completely. Direct consequence of
    //    the user's round-4 directive: "THE AGENT SHOULD ONLY START
    //    SPEAKING AND LISTENING ONCE THE CALL OPEN AUDIO IS FINISHED
    //    PLAYING".
    if (this._phaseTimestamps) {
      this._phaseTimestamps.audioPlayStartedAt = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      this._logPhase('audio_play_started', this._phaseTimestamps.placeCallAt, this._phaseTimestamps.audioPlayStartedAt);
    }
    this._callOpenPromise = (async () => {
      try {
        await this.pipeline.callAudio.playCallOpen({
          listenGateLeadMs: 0,
          onAudioEnded: ({ reason }) => {
            if (this._phaseTimestamps && this._phaseTimestamps.audioEndedAt == null) {
              this._phaseTimestamps.audioEndedAt = (typeof performance !== 'undefined' ? performance.now() : Date.now());
              this._logPhase('audio_ended', this._phaseTimestamps.placeCallAt, this._phaseTimestamps.audioEndedAt);
            }
            this._onCallOpenEnded(reason);
          }
        });
      } catch { /* controller never rejects but defend anyway */ }
      this._callOpenSettled = true;
      this._tryOpenGreetGate('call_open_ended');
    })();

    // 6. AWAIT the mic promise so the public `placeCall()` return
    //    reflects ok/fail. The WS + audio are already racing in the
    //    background — this await does NOT block setup_complete. On
    //    Chrome with a prior permission grant this resolves in ~10–50
    //    ms; first-time users see a prompt. Either way,
    //    `setup_complete` can land before `micPromise` resolves — the
    //    listen-gate only opens when BOTH gates AND the mic is
    //    actually open (we don't forward frames from a non-existent
    //    capture graph).
    try {
      await micPromise;
    } catch {
      return false;
    }
    return true;
  }

  /** Round-6 fix 2: unwire the deterministic end-call waiters. Safe
   *  to call even if nothing was armed. Called from teardown paths
   *  + early-kill (user click interrupting the wait). */
  _cancelAgentEndingWait(why) {
    if (!this._agentEndingArmed && !this._agentEndingTimer && !this._agentEndingListeners && !this._agentEndingGraceTimer) return;
    dlog('agent-end-call wait cancelled why=' + (why || '?'));
    this._agentEndingArmed = false;
    if (this._agentEndingTimer) {
      clearTimeout(this._agentEndingTimer);
      this._agentEndingTimer = null;
    }
    if (this._agentEndingGraceTimer) {
      clearTimeout(this._agentEndingGraceTimer);
      this._agentEndingGraceTimer = null;
    }
    if (this._agentEndingListeners) {
      try { this.removeEventListener('turn-complete', this._agentEndingListeners.onTurnComplete); } catch {}
      try { this.pipeline.removeEventListener('agent-playback-drained', this._agentEndingListeners.onAgentDrained); } catch {}
      this._agentEndingListeners = null;
    }
  }

  /**
   * User clicked Cancel while dialing. Graceful: close WS and mic, fade
   * ambient out, return to IDLE.
   */
  async cancelDial() {
    if (this.state !== STATES.DIALING && this.state !== STATES.LIVE_OPENING) return;
    this._cancelAgentEndingWait('cancelDial');
    dlog('cancelDial: user initiated');
    await this._gracefullyEndCall('user_cancel');
  }

  /**
   * User clicked End Call. Graceful: send server close, fade ambient,
   * close mic + WS, return to IDLE.
   *
   * Round-6 fix 2: if a deterministic agent-end-call wait is armed,
   * skip it entirely — user intent wins. Round-1 req 7 ("immediate
   * stop on user click") is preserved — we cut through the wait and
   * run teardown synchronously.
   */
  async endCall() {
    if (this._agentEndingArmed) {
      dlog('endCall: user overrode pending agent_end_call wait');
      this._cancelAgentEndingWait('endCall_user_override');
    }
    if (!this.isInCall() && this.state !== STATES.DIALING) return;
    dlog('endCall: user initiated');
    await this._gracefullyEndCall('user_end');
  }

  async _gracefullyEndCall(reason) {
    // audio-flow: idempotent — the end-call sequence can be triggered by
    // a user click, a server `end_call_requested` frame, AND the agent's
    // own `end_call` tool in close succession. Use a latch so the
    // endCall chime plays exactly once, the WS closes exactly once, and
    // the state machine transitions exactly once.
    if (this._endingCall) {
      dlog('_gracefullyEndCall skipped — already ending (reason=' + reason + ')');
      return;
    }
    this._endingCall = true;
    // Round-6 fix 2: cancel any armed deterministic-end-call wait.
    // If the user clicked End Call while we were waiting for
    // turn_complete + agent-playback-drained, skip the wait and kill.
    this._cancelAgentEndingWait('_gracefullyEndCall');

    const prevState = this.state;
    this._setState(STATES.CLOSING, reason);
    this.closedByUser = true;
    clearTimeout(this.dialTimer); this.dialTimer = null;
    clearInterval(this.liveIdleTimer); this.liveIdleTimer = null;
    if (this.localStt) this.localStt.stop();
    if (this._sttController) {
      try { this._sttController.stop(); } catch {}
    }

    // Round-8: two strictly-distinct end-call paths.
    //
    // AGENT path (`agent_end_call` / `agent_end_call_timeout`):
    //   • The deterministic chain already waited for turn_complete +
    //     agent-playback-drained. Agent audio has physically left the
    //     speakers; agent's last sample is silent.
    //   • Stop background (so the chime plays against silence).
    //   • Play callClose in full, await its onended.
    //   • Round-8 A.4: background off → brief silence → chime → teardown.
    //
    // USER path (`user_end` / `user_cancel`):
    //   • User clicked End Call. Round-8 Path B: ZERO audio, ZERO wait.
    //   • The UI click handler has ALREADY synchronously called
    //     `pipeline.stopAllAudio()` which latched `_hardKilled=true`
    //     and stopped every source. The `_agentEndingArmed` wait (if
    //     armed) was already cancelled by `endCall()`.
    //   • We DO NOT call `armForNextCall()` here — that would clear
    //     the hard-kill latch right before we try to play callClose.
    //     We DO NOT call `playCallClose()` at all. The latch is cleared
    //     naturally at the top of the NEXT `placeCall()`.
    //   • Skip straight to WS close + state reset. Same-frame teardown.
    const isAgentPath = reason === 'agent_end_call' || reason === 'agent_end_call_timeout';

    this.pipeline.setCapturePaused(true);
    this.preSetupBuffer = [];
    this.preSetupBytes = 0;

    // Round-6 fix 2: phase-logged end-call trace. Always-on so a
    // regression is obvious in the console without a debug flag.
    const teardownAt = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    // eslint-disable-next-line no-console
    console.log('[jarvis phase] end_call_teardown_start reason=' + reason + ' path=' + (isAgentPath ? 'agent' : 'user'));

    let closeOutcome = { ok: true, reason: 'skipped_user_path' };

    if (isAgentPath) {
      // Agent path only: stop background cleanly, then play callClose.
      // `stopAllCallAudio` latches `_hardKilled=true` + stops background
      // + stops any in-flight callOpen source (no-op by this point since
      // callOpen ended ~conversation-ago). It does NOT touch callClose
      // (round-6 fix 2 kept callClose untouched there so play works).
      try { this.pipeline.callAudio.stopAllCallAudio(); } catch {}
      // Clear the hard-kill latch JUST for the end-call chime. Safe on
      // the agent path because the user hasn't asked for silence.
      try { this.pipeline.callAudio.armForNextCall(); } catch {}
      if (this.transcript) this.transcript.turnBreak();

      // Tell the server we're done — they'll close upstream cleanly.
      try { this._sendJson({ type: 'call_end' }); } catch {}

      // Play the end-call chime. `playCallClose` is an
      // AudioBufferSourceNode (round 7) — deterministic `onended`
      // fires exactly once. Awaited so the UI doesn't flip to green
      // until the chime is physically done.
      try { closeOutcome = await this.pipeline.callAudio.playCallClose(); } catch {}
    } else {
      // User path: ZERO audio. The UI click handler already called
      // `pipeline.stopAllAudio()` — `_hardKilled` is true, every
      // source is stopped, background is paused. We do NOT re-arm
      // (`armForNextCall` is deliberately skipped — it would unlatch
      // the hard-kill and allow a stray late `playCallClose` call to
      // succeed). The latch is cleared naturally at the top of the
      // next `placeCall()`.
      //
      // Defensive belt: call stopAllAudio again here in case the
      // current _gracefullyEndCall entrypoint wasn't preceded by the
      // UI's explicit call (e.g. programmatic `agent.endCall()` from
      // a test or a future code path).
      try { this.pipeline.stopAllAudio(); } catch {}
      if (this.transcript) this.transcript.turnBreak();

      // Tell the server we're done. No callClose — user wanted instant.
      try { this._sendJson({ type: 'call_end' }); } catch {}
      closeOutcome = { ok: true, reason: 'skipped_user_path' };
    }

    const closeEndedAt = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    // eslint-disable-next-line no-console
    console.log('[jarvis phase] end_call_chime_done ms=' + Math.round(closeEndedAt - teardownAt) + ' outcome=' + (closeOutcome && closeOutcome.reason));

    // Close mic + WS.
    try { await this._closeMic(); } catch {}
    this.pipeline.stopCapture();
    try { if (this.ws) this.ws.close(1000, 'call-ended'); } catch {}
    this.ws = null;

    this._callActive = false;
    this._greetingSent = false;
    this._greetGateOpened = false;
    this._callOpenSettled = false;
    this._callOpenPromise = null;
    this.setupComplete = false;
    this.preSetupBuffer = [];
    this.preSetupBytes = 0;
    this.liveStartedAt = null;
    this.liveLastVoiceAt = null;
    this._phaseTimestamps = null; // latency-pass: reset so next call restamps
    // Round-3 fix 1: close the init span label so a re-placeCall doesn't
    // collide on the same console.time label. No-op if already closed.
    if (this._initSpanLabel && typeof console !== 'undefined' && typeof console.timeEnd === 'function') {
      try { console.timeEnd(this._initSpanLabel); } catch {}
    }
    this._initSpanLabel = null;
    // Round-2 req 3: reset listen-gate flags so the next call starts
    // with both gates closed.
    this._listenGateOpen = false;
    this._listenGateSetupComplete = false;
    this._listenGateFallbackLogged = false;

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

    this._endingCall = false;
    this._persistSessionBlob();
    this._publishEvent('call-ended', { reason, prevState });
  }

  /** Internal teardown on fatal error (mic dies, invalid key, etc). */
  _tearDownCall() {
    clearTimeout(this.dialTimer); this.dialTimer = null;
    clearInterval(this.liveIdleTimer); this.liveIdleTimer = null;
    // Round-6 fix 2: cancel any armed deterministic end-call wait.
    this._cancelAgentEndingWait('_tearDownCall');
    if (this.localStt) this.localStt.stop();
    if (this._sttController) {
      try { this._sttController.stop(); } catch {}
    }
    // audio-flow: hard-stop ALL call-audio on error. No end-chime here —
    // this path is for invalid keys / mic death, not user intent. The
    // hard-kill latch is cleared next time placeCall() runs.
    try { this.pipeline.stopAllAudio(); } catch {}
    this.pipeline.stopCapture();
    try { if (this.ws) this.ws.close(); } catch {}
    this.ws = null;
    this._callActive = false;
    this._greetingSent = false;
    this._greetGateOpened = false;
    this._callOpenSettled = false;
    this._callOpenPromise = null;
    this.setupComplete = false;
    this.preSetupBuffer = [];
    this.preSetupBytes = 0;
    this.liveStartedAt = null;
    this.liveLastVoiceAt = null;
    this._phaseTimestamps = null; // latency-pass: reset so next call restamps
    // Round-3 fix 1: close the init span label (see _gracefullyEndCall).
    if (this._initSpanLabel && typeof console !== 'undefined' && typeof console.timeEnd === 'function') {
      try { console.timeEnd(this._initSpanLabel); } catch {}
    }
    this._initSpanLabel = null;
    // Round-2 req 3: reset listen-gate flags.
    this._listenGateOpen = false;
    this._listenGateSetupComplete = false;
    this._listenGateFallbackLogged = false;
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

  /** Round-2 req 2: ship-time default is 'full'. Two persistence keys
   *  are honoured:
   *    • `liveAgent.transcriptMode` — canonical key going forward.
   *    • `jarvis.ui.transcriptMode` — legacy key (backward compatible);
   *      values read from here are migrated to the new key on the next
   *      save so old browser caches don't lose their preference.
   *  A missing / unrecognised value falls through to the 'full' default. */
  _loadTranscriptMode() {
    try {
      const canonical = localStorage.getItem(TRANSCRIPT_MODE_STORAGE_KEY);
      if (canonical === 'off' || canonical === 'captions' || canonical === 'full') return canonical;
      const legacy = localStorage.getItem(TRANSCRIPT_MODE_LEGACY_KEY);
      if (legacy === 'off' || legacy === 'captions' || legacy === 'full') {
        try { localStorage.setItem(TRANSCRIPT_MODE_STORAGE_KEY, legacy); } catch {}
        return legacy;
      }
    } catch {}
    return DEFAULT_TRANSCRIPT_MODE;
  }

  /** Persist + broadcast a transcript display mode. Server override takes
   *  precedence at render time (see `getTranscriptMode`). Writes to the
   *  canonical key; the legacy key is kept in sync so a downgrade to an
   *  older build still picks up the user's choice. */
  setTranscriptMode(mode) {
    const next = (mode === 'off' || mode === 'captions' || mode === 'full') ? mode : DEFAULT_TRANSCRIPT_MODE;
    if (next === this.transcriptMode) {
      this._publishEvent('transcript-mode-changed', { mode: this.getTranscriptMode(), serverForced: !this.flags.showText });
      return next;
    }
    this.transcriptMode = next;
    try { localStorage.setItem(TRANSCRIPT_MODE_STORAGE_KEY, next); } catch {}
    try { localStorage.setItem(TRANSCRIPT_MODE_LEGACY_KEY, next); } catch {}
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

  // audio-flow: background-audio toggle. Persists to localStorage and
  // takes effect immediately — if enabled mid-call, starts the loop; if
  // disabled mid-call, stops it. Fires `background-changed` so the UI
  // can reflect the state without reading private fields.
  setBackgroundEnabled(on) {
    const next = !!on;
    if (next === this.backgroundEnabled) {
      this._publishEvent('background-changed', { enabled: this.backgroundEnabled, playing: this.pipeline.callAudio.isBackgroundPlaying() });
      return next;
    }
    this.backgroundEnabled = next;
    try { localStorage.setItem(BACKGROUND_AUDIO_STORAGE_KEY, next ? 'on' : 'off'); } catch {}
    try {
      this.pipeline.callAudio.setBackgroundEnabled(next);
      // Mid-call: start or stop the loop to match the new preference.
      if (this.isInCall() && this._greetGateOpened) {
        if (next) this.pipeline.callAudio.startBackground();
        else this.pipeline.callAudio.stopBackground();
      }
    } catch {}
    this._publishEvent('background-changed', { enabled: next, playing: this.pipeline.callAudio.isBackgroundPlaying() });
    return next;
  }

  _loadBackgroundEnabled() {
    try {
      const raw = localStorage.getItem(BACKGROUND_AUDIO_STORAGE_KEY);
      if (raw === 'on')  return true;
      if (raw === 'off') return false;
    } catch {}
    return DEFAULT_BACKGROUND_ENABLED;
  }

  // audio-flow: phone-line compression toggle. Persists to localStorage
  // and applies immediately via a 50ms crossfade inside the pipeline.
  // Safe to call pre-call (graph not yet built) or mid-call.
  setPhoneCompression(on) {
    const next = !!on;
    if (next === this.phoneCompression) {
      this._publishEvent('phone-compression-changed', { enabled: this.phoneCompression });
      return next;
    }
    this.phoneCompression = next;
    try { localStorage.setItem(PHONE_COMPRESSION_STORAGE_KEY, next ? 'on' : 'off'); } catch {}
    try { this.pipeline.setPhoneCompression(next); } catch {}
    // audio-prefs: tell the server so it can re-negotiate the output
    // bitrate. No-op pre-call (WS is closed) — the hello frame will
    // include the fresh preference on the next placeCall.
    this._sendJson({ type: 'audio_prefs', phoneLine: next });
    this._publishEvent('phone-compression-changed', { enabled: next });
    return next;
  }

  /** latency-pass: record a client-side decode span (ms). Bounded buffer;
   *  read by the debug HUD. */
  _recordDecodeLatency(ms) {
    if (!this._decodeLatencyBuf) this._decodeLatencyBuf = [];
    this._decodeLatencyBuf.push(Number(ms) || 0);
    if (this._decodeLatencyBuf.length > 256) this._decodeLatencyBuf.shift();
  }

  /** latency-pass: percentiles for the HUD. Returns `{p50, p95, max, n}` in
   *  milliseconds. */
  getDecodeLatencyStats() {
    const arr = (this._decodeLatencyBuf || []).slice().sort((a, b) => a - b);
    if (arr.length === 0) return { p50: 0, p95: 0, max: 0, n: 0 };
    return {
      p50: arr[Math.floor(arr.length * 0.50)] || 0,
      p95: arr[Math.floor(arr.length * 0.95)] || 0,
      max: arr[arr.length - 1] || 0,
      n: arr.length
    };
  }

  /** latency-pass: current agent-audio rate the playback graph is
   *  decoding at. Exposed for the HUD. */
  getAgentAudioRate() { return this._agentAudioRate || 24000; }
  getAgentAudioPhoneLine() { return !!this._agentAudioPhoneLine; }

  _loadPhoneCompression() {
    try {
      const raw = localStorage.getItem(PHONE_COMPRESSION_STORAGE_KEY);
      if (raw === 'on')  return true;
      if (raw === 'off') return false;
    } catch {}
    return DEFAULT_PHONE_COMPRESSION;
  }

  _loadVolume() {
    try {
      const raw = localStorage.getItem('liveAgent.volume');
      if (raw != null) {
        const v = Number(raw);
        if (Number.isFinite(v)) return Math.max(0, Math.min(1.5, v));
      }
    } catch {}
    return 1.0;
  }

  setVolume(v) {
    const clamped = Math.max(0, Math.min(1.5, Number(v) || 0));
    this.outputVolume = clamped;
    try { this.pipeline.setOutputVolume(clamped); } catch {}
    try { localStorage.setItem('liveAgent.volume', String(clamped)); } catch {}
    return clamped;
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

  /** Set the preferred voice for future calls. Refuses mid-call. */
  setSelectedVoice(v) {
    if (this._callActive) {
      // eslint-disable-next-line no-console
      console.warn('[jarvis] setSelectedVoice refused — call is active');
      return false;
    }
    this.selectedVoice = v || null;
    try {
      if (v) localStorage.setItem('liveAgent.voice', v);
      else localStorage.removeItem('liveAgent.voice');
    } catch {}
    return true;
  }

  async setPersona(id) {
    if (!this.personas.some((p) => p.id === id)) return;
    if (id === this.personaId) return;
    this.personaId = id;
    // Round-2 req 2: mirror persona into localStorage so cross-session
    // restarts remember the pick (session blob still carries it for
    // in-tab resumption).
    try { localStorage.setItem(PERSONA_STORAGE_KEY, id); } catch {}
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
    // Round-2 req 3: the setup-complete half of the listen-gate must
    // close too so a persona-switch / reconnect doesn't keep forwarding
    // mic frames while the upstream is handshaking again.
    this._listenGateSetupComplete = false;
    // Proactively pause capture until the new setup_complete arrives.
    try { this.pipeline.setCapturePaused(true); } catch {}
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
    // latency-pass: guard against concurrent opens. The parallel-dial change
    // in placeCall() + the defensive `if (!this.pipeline.capture) _openMic()`
    // fallback in _onSetupComplete can race if WS reaches setup_complete
    // before getUserMedia resolves. Without this cache, two concurrent
    // _ensureCaptureStarted() calls would each fire getUserMedia, allocate
    // two MediaStreams, and leak one worklet + one track. A single shared
    // promise ensures exactly one capture graph is built per call.
    //
    // Round-2 req 3: the hardware mic is opened here but capture stays
    // PAUSED (no frames forwarded upstream) until the listening gates
    // are both open. `_openListenGateIfReady()` is the single call-site
    // that un-pauses, triggered by `_onListenGateFromAudio` (callOpen
    // reached last 1 s) AND `_onSetupComplete` (upstream ready).
    if (this._openMicPromise) return this._openMicPromise;
    this._openMicPromise = (async () => {
      try {
        await this._ensureCaptureStarted();
        // Hardware is live; frame forwarder remains paused until the
        // gate opens. `startCapture` initialises `capturePaused = true`.
        this._openListenGateIfReady('mic_open');
        return true;
      } finally {
        this._openMicPromise = null;
      }
    })();
    return this._openMicPromise;
  }

  async _closeMic() {
    this.pipeline.setCapturePaused(true);
  }

  // ---------- WebSocket lifecycle (only used while a call is active) ----------
  //
  // Nonce flow: before every WS open we fetch a fresh single-use token from
  // /api/ws-nonce and pass it via `?token=`. The request is small (~60 B
  // JSON response) and resolves in ~1 RTT — we pipeline it alongside mic +
  // audio in placeCall so there's zero net increase in perceived latency.
  // A fetched nonce older than its exp is rejected by the server; stale
  // tokens from a previous attempt are never reused.
  async _fetchWsNonce() {
    try {
      const r = await fetch('/api/ws-nonce', { cache: 'no-store' });
      if (!r.ok) return null;
      const j = await r.json();
      if (!j || typeof j.nonce !== 'string' || !j.nonce) return null;
      return j.nonce;
    } catch {
      return null;
    }
  }

  _connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this._setState(STATES.LIVE_OPENING);
    // Fetch a fresh nonce first. The WS open is the inner callback so we
    // never open without a token when the server requires one.
    this._fetchWsNonce().then((token) => {
      if (!this._callActive && !this.isInCall()) return; // user cancelled
      const qs = token ? ('?token=' + encodeURIComponent(token)) : '';
      this.wsUrl = `${proto}://${location.host}/api/live${qs}`;
      try {
        this.ws = new WebSocket(this.wsUrl);
        this.ws.binaryType = 'arraybuffer';
        // latency-pass: confirm in the console that the handshake uses a
        // nonce. Only when debug=1 — do not spam prod logs.
        if (DEBUG) {
          // eslint-disable-next-line no-console
          console.log('[jarvis] ws nonce handshake', token ? 'ok' : 'skipped');
        }
      } catch (err) {
        this._setState(STATES.ERROR, 'ws_failed');
        this._tearDownCall();
        return;
      }
      this._attachWsListeners();
    });
  }

  _attachWsListeners() {
    this.ws.onopen = () => {
      this.reconnectIdx = 0;
      this.metrics.connectedAt = Date.now();
      // latency-pass: record WS-open time so we can diff against placeCall
      // click. Zero-cost when phase telemetry isn't enabled.
      if (this._phaseTimestamps) {
        this._phaseTimestamps.wsOpenAt = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        this._logPhase('ws_open', this._phaseTimestamps.placeCallAt, this._phaseTimestamps.wsOpenAt);
      }
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
      // audio-prefs: piggyback the current phone-line compression state on
      // hello so the very first agent-audio chunk lands at the right rate
      // — no first-chunk resample cost and no extra round-trip.
      hello.audioPrefs = { phoneLine: !!this.phoneCompression };
      // Voice pinning: include the user's voice pick so the server locks
      // it for the session. Only sent when non-null.
      if (this.selectedVoice) {
        hello.selectedVoice = this.selectedVoice;
      }
      // latency-pass: piggyback the greeting inject on `hello` when this WS
      // open is for a fresh placeCall (not a reconnect / persona-switch /
      // mode-switch). Server honours `greet.{page,title}` by injecting the
      // <call_initiated> block as soon as the upstream is ready — one RTT
      // faster than the prior flow (wait for setup_complete, THEN send
      // call_start). The server acks with `eagerGreetAck:true` so we know
      // to skip the follow-up call_start.
      if (this._callActive && !this._greetingSent) {
        const page = this._currentPathname || location.pathname;
        const title = (document.title || '').slice(0, 120);
        hello.greet = { page, title };
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
      // Round-5 safety-belt: agent audio must never arrive before
      // callOpen has settled. The upstream gates greeting generation on
      // `greet_gate_open` (client sends that after callOpen.ended), so
      // if this branch logs anything, something in the server-side
      // gating has regressed. Logged at error level so regressions are
      // LOUD in DevTools. One-shot per call to avoid spam.
      if (!this._callOpenSettled && !this._preSettleAudioWarned) {
        this._preSettleAudioWarned = true;
        // eslint-disable-next-line no-console
        console.error('[jarvis] agent audio arrived before callOpen.ended — server-side greeting gate regression. bytes=' + data.byteLength);
      }
      // latency-pass: stamp first-token for perceived-response-start. Diff
      // against firstFrameSentAt is the priority-2 bucket (user spoke → Jarvis
      // starts speaking).
      if (this._phaseTimestamps && this._phaseTimestamps.firstTokenAt == null) {
        this._phaseTimestamps.firstTokenAt = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        if (this._phaseTimestamps.firstFrameSentAt != null) {
          this._logPhase('first_audio_frame_sent_to_first_token', this._phaseTimestamps.firstFrameSentAt, this._phaseTimestamps.firstTokenAt);
        }
        this._logPhase('setup_complete_to_first_token', this._phaseTimestamps.setupCompleteAt || this._phaseTimestamps.placeCallAt, this._phaseTimestamps.firstTokenAt);
      }
      // latency-pass: measure client-side decode (just the int16→buffer
      // copy and schedule). Useful HUD signal when debug=1.
      const _tDec0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      this.pipeline.enqueuePcm24k(pcm, this._agentAudioRate || 24000);
      const _tDec1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      this._recordDecodeLatency(_tDec1 - _tDec0);
      this._setState(STATES.MODEL_SPEAKING);
    }
  }

  _onServerMessage(msg) {
    dlog('server msg', msg.type, msg.state || msg.from || msg.code || '');
    switch (msg.type) {
      case 'audio_format': {
        // audio-prefs: server authoritative frame declaring the current
        // sample rate for incoming agent PCM. We store it so
        // `enqueuePcm` schedules buffers at the right rate.
        const rate = Math.max(4000, Math.min(48000, Number(msg.outSampleRate) || 24000));
        this._agentAudioRate = rate;
        this._agentAudioPhoneLine = !!msg.phoneLine;
        if (DEBUG) {
          // eslint-disable-next-line no-console
          console.log('[jarvis] audio_format codec=' + (msg.codec || '?') + ' rate=' + rate + ' phoneLine=' + !!msg.phoneLine);
        }
        this._publishEvent('audio-format-changed', {
          outSampleRate: rate,
          phoneLine: !!msg.phoneLine
        });
        return;
      }
      case 'encode_stats': {
        // latency-pass: HUD-only telemetry from the server. Re-dispatch
        // as a generic `server-frame` so the ui.js HUD can consume it
        // without adding a bespoke listener on every new frame type.
        this._publishEvent('server-frame', msg);
        return;
      }
      case 'hello_ack':
        if (Array.isArray(msg.personas) && msg.personas.length) this.personas = msg.personas;
        if (msg.mode && msg.mode !== this.mode) this.mode = msg.mode;
        // latency-pass: server confirms it will auto-inject <call_initiated>
        // on the first upstream message. Mark the greeting as sent so the
        // setup_complete handler doesn't issue a redundant `call_start`.
        // greeting-fix: only trust the ack when _callActive AND the server
        // actually set the flag. If the ack is false (server decided not to
        // eager-inject, e.g. hello.greet was missing or malformed), the
        // setup_complete handler falls through and issues call_start as
        // before — no silent failure mode.
        if (msg.eagerGreetAck === true && this._callActive) {
          this._greetingSent = true;
          this.pageContextInjected = true;
          this._logPhase('eager_greet_ack', this._phaseTimestamps && this._phaseTimestamps.placeCallAt, typeof performance !== 'undefined' ? performance.now() : Date.now());
          dlog('eager-greet ack received — skipping follow-up call_start');
        }
        // Voice pinning: stash the server's confirmed voice for display.
        if (typeof msg.voice === 'string' && msg.voice) {
          this.pinnedVoice = msg.voice;
          try {
            window.dispatchEvent(new CustomEvent('voice-pinned', { detail: { voice: msg.voice } }));
          } catch {}
        }
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
        this._resumeGraceUntil = Date.now() + 3000;
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
      case 'end_call_requested': {
        // Round-6 fix 2: DETERMINISTIC end-call chain.
        //
        // No more timer guess (was 3 s). The model decides to hang up
        // and produces its sign-off audio; we wait for two discrete,
        // deterministic signals before proceeding:
        //   1. `turn-complete` from Gemini — the model has finished
        //      generating audio for this turn (i.e. "Have a nice day!"
        //      is fully produced, including the trailing silence
        //      Gemini puts at the end of a turn).
        //   2. `agent-playback-drained` from the pipeline — every
        //      scheduled AudioBufferSourceNode has drained (i.e. the
        //      last PCM sample has left the speakers).
        // When BOTH have fired, `_gracefullyEndCall` runs and plays
        // the callClose chime.
        //
        // Idempotent: `_agentEndingArmed` latches on first fire so a
        // duplicate frame is dropped.
        //
        // Safety timeout: 10 s wallclock after we arm. If Gemini
        // silently dies between tool ack and turn_complete, we proceed
        // with teardown so the call doesn't hang forever. Logged at
        // error level so it's visible in DevTools.
        //
        // User kill during the wait: `endCall()` calls
        // `_gracefullyEndCall` directly with `reason='user_end'` which
        // short-circuits the wait (idempotent latch in
        // `_gracefullyEndCall` means the second call is a no-op).
        dlog('end_call_requested reason=' + (msg.reason || '—'));
        if (this._agentEndingArmed) {
          dlog('end_call_requested duplicate — already armed');
          return;
        }
        this._agentEndingArmed = true;
        this._agentTurnComplete = false;
        this._agentAudioDrained = !this.pipeline.isAgentAudioPlaying();
        const reasonForLog = msg.reason || null;
        this._publishEvent('agent-end-call-pending', { reason: reasonForLog });

        const tryFinish = (trigger) => {
          if (!this._agentEndingArmed) return;
          if (!this._agentTurnComplete || !this._agentAudioDrained) {
            dlog('agent-end-call waiting — turn=' + this._agentTurnComplete +
              ' drained=' + this._agentAudioDrained + ' via=' + trigger);
            // end-call-latency: once audio has drained (user heard the
            // last word), cap the additional wait for turn_complete.
            // Gemini often sends turn_complete a few hundred ms AFTER
            // audio generation finishes; without this cap, the user
            // hears "Have a good day!" then a noticeable pause before
            // the callClose chime. 300 ms is well under the perceptual
            // threshold for a conversational turn and still gives the
            // turn_complete frame ample time to arrive.
            if (this._agentAudioDrained && !this._agentTurnComplete && !this._agentEndingGraceTimer) {
              this._agentEndingGraceTimer = setTimeout(() => {
                this._agentEndingGraceTimer = null;
                if (!this._agentEndingArmed) return;
                dlog('agent-end-call grace-expired — proceeding without turn_complete');
                this._agentTurnComplete = true;
                tryFinish('grace_timeout');
              }, 300);
            }
            return;
          }
          // Both gates closed — run teardown.
          clearTimeout(this._agentEndingTimer); this._agentEndingTimer = null;
          clearTimeout(this._agentEndingGraceTimer); this._agentEndingGraceTimer = null;
          this._agentEndingArmed = false;
          dlog('agent-end-call deterministic fire via=' + trigger);
          this._gracefullyEndCall('agent_end_call').catch(() => {});
        };

        const onTurnComplete = () => {
          if (!this._agentEndingArmed) return;
          this._agentTurnComplete = true;
          tryFinish('turn_complete');
        };
        const onAgentDrained = () => {
          if (!this._agentEndingArmed) return;
          this._agentAudioDrained = true;
          tryFinish('agent_drained');
        };
        this.addEventListener('turn-complete', onTurnComplete);
        this.pipeline.addEventListener('agent-playback-drained', onAgentDrained);
        this._agentEndingListeners = { onTurnComplete, onAgentDrained };
        this._agentEndingGraceTimer = null;

        // Safety timeout: 3 s. If Gemini dies mid-turn, proceed anyway.
        // Reduced from 10 s — that was a worst-case guard but meant the
        // call could hang for ages if a signal genuinely failed.
        this._agentEndingTimer = setTimeout(() => {
          if (!this._agentEndingArmed) return;
          // eslint-disable-next-line no-console
          console.error('[jarvis] agent-end-call timeout — turn_complete or drained never fired. Proceeding with teardown.');
          this._agentEndingArmed = false;
          clearTimeout(this._agentEndingGraceTimer); this._agentEndingGraceTimer = null;
          this._gracefullyEndCall('agent_end_call_timeout').catch(() => {});
        }, 3000);

        // If audio was ALREADY drained at the moment the tool fired
        // (no sign-off was ever scheduled), we still wait for
        // turn_complete — the model may not have emitted any audio
        // parts but Gemini will still signal end-of-turn.
        if (this._agentAudioDrained) tryFinish('already_drained');
        return;
      }
      case 'transcript_delta':
        this._onTranscriptDelta(msg);
        if (msg.from === 'user') this.liveLastVoiceAt = Date.now();
        return;
      case 'usage':
        this._publishEvent('usage', msg);
        return;
      case 'interrupted':
        if (this.transcript) this.transcript.turnBreak();
        this._suppressUserTxUntil = Date.now() + 200;
        this.pipeline.flushPlayback();
        this._setState(STATES.LIVE_READY);
        return;
      case 'turn_complete':
        if (this.transcript) this.transcript.turnBreak();
        // Reset resume grace on first turn_complete after resume.
        if (this._resumeGraceUntil > 0) this._resumeGraceUntil = 0;
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
    // latency-pass: stamp setup-complete so we can diff placeCall → setup.
    if (this._phaseTimestamps && this._phaseTimestamps.setupCompleteAt == null) {
      this._phaseTimestamps.setupCompleteAt = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      this._logPhase('setup_complete_from_click', this._phaseTimestamps.placeCallAt, this._phaseTimestamps.setupCompleteAt);
      // Round-3 fix 1: log the parallel overlap — how much of the audio
      // playback already elapsed by the time setup_complete landed. A
      // negative delta would mean setup beat the audio start (should
      // never happen); a small positive number means init ran mostly
      // in parallel with audio; a number close to the audio duration
      // (~15 s) means init was mostly serial (the old bug).
      if (this._phaseTimestamps.audioPlayStartedAt != null) {
        const overlapMs = Math.round(
          this._phaseTimestamps.setupCompleteAt - this._phaseTimestamps.audioPlayStartedAt
        );
        // Always log (not DEBUG-gated) so production can diagnose
        // regression without a debug flag.
        // eslint-disable-next-line no-console
        console.log('[jarvis phase] setup_complete_vs_audio_start ' + overlapMs + 'ms');
      }
      if (this._initSpanLabel && typeof console !== 'undefined' && typeof console.timeEnd === 'function') {
        try { console.timeEnd(this._initSpanLabel); } catch {}
        this._initSpanLabel = null;
      }
    }
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

    // Round-2 req 3: flip the second listen-gate. `_openListenGateIfReady`
    // un-pauses capture only when BOTH this flag AND the callOpen
    // near-end flag are set. On a RECONNECT there is no callOpen chime,
    // so force the audio gate open too — the user was already talking
    // and expects to keep talking.
    this._listenGateSetupComplete = true;
    if (!this._listenGateOpen && this._callOpenSettled) {
      // Reconnect path: callOpen already settled (from the original
      // placeCall) and no new chime is played; open the gate.
      this._listenGateOpen = true;
    }
    this._openListenGateIfReady('setup_complete');

    // Greeting injection — exactly once per placeCall cycle. audio-flow:
    // hello.greet already carries the greet intent for fresh calls, so we
    // only emit the fallback `call_start` for paths that didn't use it
    // (reconnect / persona-switch). Either way, the actual greeting is
    // gated server-side on the `greet_gate_open` frame the client sends
    // once the startCall chime has ended — see _tryOpenGreetGate.
    if (this._callActive && !this._greetingSent) {
      this._greetingSent = true;
      const page = this._currentPathname || location.pathname;
      const title = (document.title || '').slice(0, 120);
      dlog('greeting call_start injected for page=' + page);
      this._sendJson({ type: 'call_start', page, title });
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

    // audio-flow: setup_complete is one of the two conditions for the
    // greet gate. If the start-audio chime has already finished, the
    // gate opens now; otherwise it opens when the chime resolves.
    this._tryOpenGreetGate('setup_complete');
  }

  /** Round-5: callback from the audio pipeline when the callOpen clip
   *  has FINISHED playing (or bailed out on a fallback reason). Opens
   *  the LISTEN gate only (round-2); the PLAYBACK gate from round-4
   *  was removed because the server-side greeting trigger is already
   *  gated on `greet_gate_open` which the client sends in
   *  `_tryOpenGreetGate` only after callOpen settles — no TTS audio
   *  can arrive during callOpen, so no client-side buffer is needed.
   *
   *  Clean finish reasons: `ended`, `short_clip`, `paused` (only when
   *  the call is still active — `paused` during teardown is ignored).
   *  Fallback reasons: `error`, `timeout`, `no_duration` — still open
   *  the listen gate to avoid permanently-muted capture. `hard_killed`
   *  is always ignored: it only fires when the pipeline latched for
   *  teardown and a late call to playCallOpen returned immediately. */
  _onCallOpenEnded(reason) {
    // Ignore when the call has already been torn down — this callback
    // can fire from `stopAllCallAudio()` pausing the element during
    // endCall, and we must NOT re-open the gate mid-teardown.
    if (!this._callActive || this._endingCall) {
      dlog('callOpen ended reason=' + reason + ' — ignored (call inactive or ending)');
      return;
    }
    if (reason === 'hard_killed') {
      dlog('callOpen ended hard_killed — gate stays closed');
      return;
    }
    const isFallback = !(reason === 'ended' || reason === 'short_clip' || reason === 'paused');
    if (isFallback && !this._listenGateFallbackLogged) {
      this._listenGateFallbackLogged = true;
      // eslint-disable-next-line no-console
      console.warn('[jarvis] callOpen ended with fallback reason — opening listen gate anyway (reason=' + reason + ')');
    }
    dlog('callOpen ended reason=' + reason);

    // Open the listen gate (mic → upstream). `_openListenGateIfReady`
    // is the single un-pause site; it also waits on setup_complete.
    if (!this._listenGateOpen) {
      this._listenGateOpen = true;
      this._openListenGateIfReady('audio_ended_' + reason);
    }
  }

  /** Round-2 req 3: un-pauses capture only when BOTH `_listenGateOpen`
   *  (callOpen near-end or fallback) AND `_listenGateSetupComplete`
   *  (upstream ready) are true. Safe to call many times. */
  _openListenGateIfReady(source) {
    if (!this._callActive) return;
    if (!this._listenGateOpen || !this._listenGateSetupComplete) {
      dlog('listen gate waiting — audio=' + this._listenGateOpen + ' setup=' + this._listenGateSetupComplete + ' via=' + source);
      return;
    }
    if (!this.pipeline || !this.pipeline.capture) return;
    if (!this.pipeline.capturePaused) return; // already forwarding
    dlog('listen gate OPEN via=' + source + ' — unpausing capture');
    this.pipeline.setCapturePaused(false);
  }

  /** Round-6 fix 1: signal the server that the callOpen chime has
   *  ended so it can release its pre-greet buffer. Generation was
   *  fired into Gemini the moment upstream setup completed (in
   *  parallel with callOpen playback). Any frames produced during
   *  the chime sit in a server-side buffer; this signal flushes
   *  them immediately.
   *
   *  Fires exactly once per call (latched on `_greetGateOpened`). We
   *  keep the internal flag name `_greetGateOpened` for low-churn
   *  across teardown paths; the wire frame name changed from
   *  `greet_gate_open` → `audio_prelude_ended` to reflect the new
   *  semantic (gates RELEASE, not INJECTION). The server accepts
   *  both names for backward compat during rolling deploys. */
  _tryOpenGreetGate(source) {
    if (!this._callActive) return;
    if (this._greetGateOpened) return;
    if (!this.setupComplete) return;
    // Still require BOTH setup_complete AND callOpen settled — this
    // is the gate for ACK'ing "safe to speak aloud". Unchanged.
    if (!this._callOpenSettled) {
      dlog('audio-prelude gate waiting — ' + source + ' before call-open settled');
      return;
    }
    this._greetGateOpened = true;
    dlog('audio-prelude gate OPEN via=' + source);
    // Tell the server to release its buffered greeting frames.
    try { this._sendJson({ type: 'audio_prelude_ended' }); } catch {}
    // audio-flow: background ambience starts here — exactly at the
    // moment Gemini's greeting begins. If the user disabled the
    // toggle the controller will no-op.
    try { this.pipeline.callAudio.startBackground(); } catch {}
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
    // audio-flow: `compression` / `noise` fields have been retired with
    // the procedural noise system. `backgroundEnabled` lives in
    // localStorage (cross-tab) so it isn't duplicated here.
    writeSessionBlob({
      handle: this.resumeHandle,
      handleIssuedAt: this.resumeHandleIssuedAt || (this.resumeHandle ? Date.now() : null),
      mode: this.mode,
      persona: this.personaId,
      muted: !!this.muted,
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

  /** Start a 4 s silence timer after a failed tool call. If the model
   *  doesn't speak (no agent transcript_delta) within that window, inject
   *  a synthetic notice so the user isn't left in dead air. */
  _startToolFailureSilenceTimer() {
    clearTimeout(this._toolFailureSilenceTimer);
    this._toolFailureSilenceTimer = setTimeout(() => {
      this._toolFailureSilenceTimer = null;
      if (!this._callActive) return;
      // Only fire if the model hasn't started speaking.
      if (this.state === STATES.MODEL_SPEAKING) return;
      this._announce({ from: 'system', text: 'Something didn\'t work — try asking me again.' });
    }, 4000);
  }

  _onTranscriptDelta(msg) {
    const from = msg.from === 'agent' ? 'agent' : 'user';
    // Cancel tool-failure silence timer on any agent speech.
    if (from === 'agent' && this._toolFailureSilenceTimer) {
      clearTimeout(this._toolFailureSilenceTimer);
      this._toolFailureSilenceTimer = null;
    }
    // Barge-in dedup: suppress late-arriving user deltas after interruption.
    if (from === 'user' && Date.now() < this._suppressUserTxUntil) return;
    // Resume dedup: drop agent deltas that repeat recently-finalized text.
    if (from === 'agent' && this._resumeGraceUntil > 0 && Date.now() < this._resumeGraceUntil) {
      const delta = String(msg.delta || '').trim();
      if (delta && this.transcript) {
        const recents = this.transcript.lastNFinals(5);
        if (recents.some((t) => t.includes(delta))) return;
      }
    }
    if (this.transcript) {
      this.transcript.addDelta({
        from,
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
    // latency-pass: stamp the first audio-frame-sent time once per call.
    // Diff against placeCall → this tells us priority-1 user-perceived latency.
    if (this._phaseTimestamps && this._phaseTimestamps.firstFrameSentAt == null) {
      this._phaseTimestamps.firstFrameSentAt = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      this._logPhase('first_audio_frame_sent', this._phaseTimestamps.placeCallAt, this._phaseTimestamps.firstFrameSentAt);
    }
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
      if (cfg.defaultPersona) {
        let hasUserPersona = false;
        try { hasUserPersona = !!localStorage.getItem(PERSONA_STORAGE_KEY); } catch {}
        if (!hasUserPersona) this.personaId = cfg.defaultPersona;
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
        if (this.flags.geminiTranscription) return; // server handles user STT
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
        if (this.flags.geminiTranscription) return; // server handles user STT
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
    this.state = state;
    this.lastDetail = detail;
    dlog('state ->', state, detail || '');
    this._publishEvent('state', { state, detail });
  }

  _publishEvent(name, payload) {
    this.dispatchEvent(new CustomEvent(name, { detail: payload }));
  }

  /** latency-pass: phase telemetry gated on localStorage['jarvis.debug']==='1'.
   *  Prints a single [phase] line per transition so we can measure the key
   *  latency buckets (connect, first-frame, first-token, tool-RTT) without
   *  perturbing any existing dlog lines that other JS or tests rely on. */
  _logPhase(label, fromTs, toTs) {
    if (!DEBUG) return;
    if (typeof fromTs !== 'number' || typeof toTs !== 'number') return;
    const ms = Math.round(toTs - fromTs);
    // eslint-disable-next-line no-console
    console.log(`[jarvis phase] ${label} ${ms}ms`);
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
