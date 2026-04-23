// Audio pipeline: capture (AudioWorklet → PCM16 16 kHz chunks to caller),
// playback of 24 kHz PCM16 chunks, and call-audio choreography (call-open
// chime, background ambience loop, call-close chime) driven off three
// HTMLAudioElement instances.
//
// audio-flow: The procedural noise-bed / human-call-layer systems that
// previously lived here have been removed. Phone-line compression has
// been re-introduced as an opt-in Web Audio sub-graph applied to the
// agent playback chain. The three <audio> elements remain:
//
//   • callOpen   — one-shot ring-then-pickup; covers dialling / setup.
//   • background — loops at low volume for the duration of the call.
//   • callClose  — one-shot hangup-then-disconnect; plays during teardown.
//
// HTMLAudioElement is intentional: it obeys the OS volume mixer, costs
// nothing to keep loaded, and doesn't need the Web Audio graph (which is
// still used for PCM capture + Gemini voice playback).
//
// Design notes:
//   • Single AudioContext for BOTH mic capture and Gemini playback.
//   • `unlockAudioSync()` creates + resumes the ctx synchronously inside a
//     user gesture (Chrome autoplay policy).
//   • The Place Call click also primes the three <audio> elements via
//     `unlockCallAudio()` so Safari / iOS honours the first `.play()`.
//   • No ScriptProcessorNode anywhere.

/** Encode an Int16Array of PCM samples into an AudioBuffer for playback. */
function int16ToAudioBuffer(ctx, int16, sampleRate) {
  const buf = ctx.createBuffer(1, int16.length, sampleRate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < int16.length; i++) ch[i] = int16[i] / 32768;
  return buf;
}

// audio-flow: volume constants for the three HTMLAudioElement layers.
// BACKGROUND_VOLUME is tuned quiet so it sits under Gemini's voice and
// doesn't force the user to keep turning the OS volume down.
const BACKGROUND_VOLUME = 0.15;
const START_END_VOLUME = 0.85;
// audio-flow: safety cap on how long we wait for callOpen / callClose
// clips to finish before we move on. A missing or corrupt file must never
// block the call flow — we log and continue.
//   • callOpen cap: 20000ms — the combined ring-then-pickup asset is
//     ~15.8s (FULL startCall + phonePick). 20s gives the asset room to
//     finish naturally even on a slow first decode while still bounding
//     the greet delay if the file is corrupt.
//   • callClose cap: 6000ms — combined hangup + 3× end-call beeps is ~4.1s.
const START_AUDIO_MAX_MS = 20000;
const END_AUDIO_MAX_MS = 6000;

// audio-flow: candidate asset paths. We probe <audio>.canPlayType for
// Opus-in-WebM up-front; if it returns a non-empty string we use .webm,
// otherwise we fall back to .mp3. This keeps download size down on
// modern browsers while keeping iOS Safari working.
//   • callOpen  = startCall (ring) + phonePick concatenated.
//   • callClose = phoneCut + endCall concatenated.
const CALL_AUDIO_SOURCES = {
  callOpen:   { webm: '/audio/callOpen.webm',   mp3: '/audio/callOpen.mp3' },
  background: { webm: '/audio/background.webm', mp3: '/audio/background.mp3' },
  callClose:  { webm: '/audio/callClose.webm',  mp3: '/audio/callClose.mp3' }
};

let _webmOpusProbeResult = null;
function canPlayWebmOpus() {
  if (_webmOpusProbeResult !== null) return _webmOpusProbeResult;
  try {
    // audio-flow: one-shot probe. We test an HTMLAudioElement (not a
    // MediaSource) because the former matches the runtime we'll use.
    // Cached so we don't spin up a throwaway element per clip.
    const probe = new Audio();
    const result = typeof probe.canPlayType === 'function'
      ? probe.canPlayType('audio/webm;codecs=opus')
      : '';
    _webmOpusProbeResult = !!(result && result !== '');
  } catch {
    _webmOpusProbeResult = false;
  }
  return _webmOpusProbeResult;
}

function pickCallAudioSrc(kind) {
  const pair = CALL_AUDIO_SOURCES[kind];
  if (!pair) return null;
  return canPlayWebmOpus() ? pair.webm : pair.mp3;
}

/** audio-flow: call-audio choreography.
 *
 *  Round-7: callOpen and callClose migrated from HTMLAudioElement to
 *  Web-Audio `AudioBufferSourceNode`. HTMLAudioElement's `ended` event
 *  was unreliable in browser reproductions (sometimes never firing,
 *  sometimes firing after stale timing), which cascaded into the
 *  user-visible flakiness of "background starts with callOpen" and
 *  "agent speaks during callOpen". AudioBufferSourceNode has a
 *  deterministic single-fire `onended` that triggers exactly once —
 *  either on natural completion or on `stop()`. It also removes the
 *  muted-play-then-pause unlock-dance for these two clips (the
 *  AudioContext itself is the unlock target, and `unlockAudioSync`
 *  has already resumed it synchronously inside the click handler).
 *
 *  Background audio stays HTMLAudioElement: it's a long-running loop,
 *  its start/stop timing is non-critical, and HTMLMediaElement's
 *  streaming + range-request support is what it's designed for.
 *
 *  Contract:
 *   • `prepareBuffers(ctx)` — eagerly fetch + decode callOpen + callClose
 *     into an AudioBuffer cache. Called at AudioContext creation, not
 *     at click-time, so the first placeCall is instant.
 *   • `playCallOpen({onAudioEnded})` — schedule a new BufferSource,
 *     fire the callback exactly once from `onended`. Stale event-order
 *     bugs impossible — no timeupdate, no pause, no loadedmetadata.
 *   • `stopAllCallAudio()` — sets `_hardKilled` + calls `.stop(0)` on
 *     any active open/close source. The source's `onended` still fires
 *     but the callback checks the stopped flag and reports
 *     `reason='stopped'`.
 *
 *  Background-loop watchdog for the HTMLAudioElement that DOES remain:
 *  `loop=true` occasionally no-ops on Chrome after tab blur. We
 *  defensively listen for `ended` and, if we still believe the
 *  ambience should be running, rewind + play again. */
class CallAudioController {
  constructor({ onStateChange, onAllStopped, pipeline } = {}) {
    this._onStateChange = typeof onStateChange === 'function' ? onStateChange : () => {};
    // audio-flow: `onAllStopped` fires when the call-audio layer goes
    // quiet (no open/background/close playing). UI listens to this so
    // the End Call button reverts to green ONLY when every audio element
    // has stopped (requirement 6).
    this._onAllStopped = typeof onAllStopped === 'function' ? onAllStopped : () => {};
    this._pipeline = pipeline;  // round-7: shared AudioContext + playbackGain accessor
    this._backgroundEnabled = true; // default ON; VoiceAgent overrides from localStorage

    // Round-7: callOpen + callClose are now AudioBufferSourceNodes.
    // `_buffers` caches the decoded AudioBuffer per kind; populated by
    // `prepareBuffers`. `_activeOpenSource` / `_activeCloseSource` hold
    // the live source handle so `stopAllCallAudio` can kill them.
    this._buffers = { callOpen: null, callClose: null };
    this._buffersLoading = null;   // Promise<void> while decoding
    this._activeOpenSource = null;
    this._activeCloseSource = null;
    this._activeOpenStopped = false;
    this._activeCloseStopped = false;

    // Background stays HTMLAudioElement (long-lived loop).
    this.backgroundAudio = this._buildAudio('background', { loop: true, volume: BACKGROUND_VOLUME });

    this._unlocked = false;
    this._openPlaying = false;
    this._backgroundPlaying = false;
    this._closePlaying = false;
    // audio-flow: latch set by `stopAllCallAudio()` — bars any further
    // playback kick-offs until the next call is placed. Prevents a stale
    // `startBackground()` or a scheduled `playCallClose()` from firing
    // after the user has smashed End Call.
    this._hardKilled = false;

    this._bgRestartAttempts = 0;
    this.backgroundAudio.addEventListener('ended', () => {
      if (!this._backgroundEnabled || !this._backgroundPlaying) return;
      // eslint-disable-next-line no-console
      console.warn('[audio-flow] background ended while loop expected; restarting');
      this._restartBackground('ended');
    });
    this.backgroundAudio.addEventListener('pause', () => {
      if (!this._backgroundPlaying) return;
      // eslint-disable-next-line no-console
      console.warn('[audio-flow] background paused unexpectedly; restarting');
      this._restartBackground('pause');
    });
  }

  /** Round-7: fetch + decode callOpen and callClose into AudioBuffer
   *  instances. Idempotent — safe to call multiple times; re-uses the
   *  first decode. Called from `AudioPipeline.unlockAudioSync` right
   *  after the context is created so the first placeCall is instant
   *  (the 15.7 s callOpen fetch finishes by then even on slow links).
   *  Returns a Promise that resolves once both buffers are ready OR
   *  a fatal decode failure has been logged (never rejects). */
  prepareBuffers(ctx) {
    if (!ctx) return Promise.resolve();
    if (this._buffersLoading) return this._buffersLoading;
    if (this._buffers.callOpen && this._buffers.callClose) return Promise.resolve();
    this._buffersLoading = (async () => {
      const kinds = ['callOpen', 'callClose'];
      for (const kind of kinds) {
        if (this._buffers[kind]) continue;
        const url = pickCallAudioSrc(kind);
        if (!url) continue;
        try {
          const res = await fetch(url);
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const bytes = await res.arrayBuffer();
          // decodeAudioData accepts both promise and callback forms
          // across browsers; wrap defensively.
          const buf = await new Promise((resolve, reject) => {
            try {
              const ret = ctx.decodeAudioData(bytes, resolve, reject);
              if (ret && typeof ret.then === 'function') ret.then(resolve).catch(reject);
            } catch (err) { reject(err); }
          });
          this._buffers[kind] = buf;
          // eslint-disable-next-line no-console
          console.log('[audio-flow] decoded ' + kind + ' duration=' + buf.duration.toFixed(2) + 's ch=' + buf.numberOfChannels + ' sr=' + buf.sampleRate);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('[audio-flow] failed to decode ' + kind, err && err.message);
          this._buffers[kind] = null;
        }
      }
      this._buffersLoading = null;
    })();
    return this._buffersLoading;
  }

  /** audio-flow: restart the background loop after an `ended` or rogue
   *  `pause`. Capped at 3 attempts per continuous playing session; counter
   *  resets on every fresh `startBackground()`. */
  _restartBackground(cause) {
    if (!this._backgroundEnabled || !this._backgroundPlaying) return;
    this._bgRestartAttempts += 1;
    if (this._bgRestartAttempts > 3) {
      // eslint-disable-next-line no-console
      console.error('[audio-flow] background restart exceeded retry budget (cause=' + cause + ')');
      this._backgroundPlaying = false;
      this._onStateChange({ backgroundPlaying: false, reason: 'restart_failed' });
      this._checkAllStopped();
      return;
    }
    try { this.backgroundAudio.currentTime = 0; } catch {}
    try { this.backgroundAudio.loop = true; } catch {}
    try { this.backgroundAudio.muted = false; } catch {}
    const p = this.backgroundAudio.play();
    if (p && typeof p.catch === 'function') {
      p.catch((err) => {
        // eslint-disable-next-line no-console
        console.warn('[audio-flow] background restart rejected (cause=' + cause + ')', err && err.message);
        // Try once more on next tick — sometimes a single rejection is a
        // transient autoplay-policy hiccup.
        setTimeout(() => this._restartBackground(cause + '_retry'), 120);
      });
    }
  }

  _buildAudio(kind, { loop, volume }) {
    const el = new Audio();
    el.preload = 'auto';
    el.loop = !!loop;
    el.volume = volume;
    const src = pickCallAudioSrc(kind);
    if (src) el.src = src;
    // Failed loads must not block the call. Log + swallow.
    el.addEventListener('error', () => {
      // eslint-disable-next-line no-console
      console.warn(`[audio-flow] failed to load ${kind} audio src=${el.src}`);
    });
    return el;
  }

  /** audio-flow: call once from inside the first user-gesture event
   *  handler. Round-7: only `backgroundAudio` needs the HTMLMediaElement
   *  unlock dance now — callOpen and callClose are AudioBufferSourceNodes
   *  which play off the shared AudioContext and are unlocked by
   *  `AudioPipeline.unlockAudioSync()` → `ctx.resume()`. That removes
   *  the source of the audible "background blip at call start" that
   *  users reported: the unlock dance no longer touches openAudio or
   *  closeAudio (they don't exist as HTMLAudioElements any more). */
  unlock() {
    if (this._unlocked) return;
    this._unlocked = true;
    try {
      this.backgroundAudio.muted = true;
      const p = this.backgroundAudio.play();
      try { this.backgroundAudio.pause(); } catch {}
      try { this.backgroundAudio.currentTime = 0; } catch {}
      this.backgroundAudio.muted = false;
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {}
  }

  /** Round-7: play a one-shot chime via AudioBufferSourceNode. Internal
   *  helper shared by `playCallOpen` and `playCallClose`. Takes a
   *  buffer key + max-wait timeout; resolves `{ok, reason}` exactly
   *  once — the source's `onended` fires deterministically either when
   *  the buffer plays to completion OR when `stop()` is called.
   *
   *  `activeHolder` is the property name on `this` where we store the
   *  source + stopped flag so `stopAllCallAudio` can kill it.
   *  `playingFlag` is the property name we set to true on start and
   *  false on end, so `_checkAllStopped` tracks lifecycle correctly. */
  _playBufferSource(bufferKey, activeHolderKey, stoppedFlagKey, playingFlagKey, maxWaitMs) {
    return new Promise((resolve) => {
      const ctx = this._pipeline && this._pipeline.ctx;
      const gain = this._pipeline && this._pipeline.playbackGain;
      if (!ctx || !gain) {
        // No AudioContext — pipeline wasn't unlocked. Return fallback
        // so the caller doesn't deadlock. Log so the regression is
        // visible.
        // eslint-disable-next-line no-console
        console.error('[audio-flow] ' + bufferKey + ' cannot play — no AudioContext');
        resolve({ ok: false, reason: 'no_context' });
        return;
      }
      const buffer = this._buffers[bufferKey];
      if (!buffer) {
        // Buffer not decoded yet. Try to kick a fetch+decode and
        // resolve when done (bounded by maxWaitMs). Mark playing
        // flag true so `_checkAllStopped` doesn't fire while we're
        // still in the middle of the clip's lifecycle.
        // eslint-disable-next-line no-console
        console.warn('[audio-flow] ' + bufferKey + ' buffer not ready — awaiting decode');
        this[playingFlagKey] = true;
        const timeout = setTimeout(() => {
          this[playingFlagKey] = false;
          this._checkAllStopped();
          resolve({ ok: false, reason: 'decode_timeout' });
        }, maxWaitMs);
        this.prepareBuffers(ctx).then(() => {
          clearTimeout(timeout);
          if (this._buffers[bufferKey]) {
            // Flag will be re-asserted inside the recursive call; clear
            // here so the recursion's own asserts aren't no-ops.
            this[playingFlagKey] = false;
            // Recurse once now that the buffer is ready.
            this._playBufferSource(bufferKey, activeHolderKey, stoppedFlagKey, playingFlagKey, maxWaitMs)
              .then(resolve);
          } else {
            this[playingFlagKey] = false;
            this._checkAllStopped();
            resolve({ ok: false, reason: 'decode_failed' });
          }
        });
        return;
      }

      this[playingFlagKey] = true;
      this[stoppedFlagKey] = false;

      const src = ctx.createBufferSource();
      src.buffer = buffer;
      // Connect to the playbackGain so the `setOutputVolume` control
      // and phone-compression crossfade apply uniformly.
      src.connect(gain);
      this[activeHolderKey] = src;

      let settled = false;
      const settle = (reason) => {
        if (settled) return;
        settled = true;
        clearTimeout(safetyTimer);
        this[playingFlagKey] = false;
        if (this[activeHolderKey] === src) this[activeHolderKey] = null;
        try { src.disconnect(); } catch {}
        this._checkAllStopped();
        resolve({ ok: reason === 'ended', reason });
      };

      src.onended = () => {
        // Fires exactly once — either buffer played to completion OR
        // `src.stop()` was called. `_stoppedFlagKey` distinguishes.
        settle(this[stoppedFlagKey] ? 'stopped' : 'ended');
      };

      // Safety timer — should never fire in normal flow. Logged at
      // error level if it does so we know there's a bug.
      const safetyTimer = setTimeout(() => {
        // eslint-disable-next-line no-console
        console.error('[audio-flow] ' + bufferKey + ' safety timeout fired — onended never arrived');
        try { src.stop(0); } catch {}
        settle('timeout');
      }, maxWaitMs);

      try {
        src.start(0);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[audio-flow] ' + bufferKey + ' start threw', err && err.message);
        settle('throw');
      }
    });
  }

  /** audio-flow: play the call-open clip (ring + pickup). Round-7:
   *  uses AudioBufferSourceNode with deterministic `onended`. The
   *  round-2 `onListenGate` API is retained as a compatibility shim
   *  (round-6 moved both gates to `onAudioEnded`, so it's a no-op for
   *  the live code path). `onAudioEnded({reason})` fires exactly once.
   *
   *  Reasons:
   *    'ended'       — buffer played to completion naturally
   *    'stopped'     — stopAllCallAudio() called stop() mid-playback
   *    'hard_killed' — _hardKilled latch was set before play even
   *                    began (second placeCall after endCall)
   *    'no_context'  — pipeline wasn't unlocked (should never happen)
   *    'decode_failed' / 'decode_timeout' — fetch+decode bailed
   *    'timeout'     — safety timer fired; bug if it happens
   *    'throw'       — source.start() threw
   */
  playCallOpen(opts) {
    const onListenGate = opts && typeof opts.onListenGate === 'function' ? opts.onListenGate : null;
    const onAudioEnded = opts && typeof opts.onAudioEnded === 'function' ? opts.onAudioEnded : null;

    if (this._hardKilled) {
      if (onListenGate) { try { onListenGate({ reason: 'hard_killed' }); } catch {} }
      if (onAudioEnded) { try { onAudioEnded({ reason: 'hard_killed' }); } catch {} }
      return Promise.resolve({ ok: false, reason: 'hard_killed' });
    }
    return this._playBufferSource('callOpen', '_activeOpenSource', '_activeOpenStopped', '_openPlaying', START_AUDIO_MAX_MS)
      .then((outcome) => {
        // Round-2/round-6 compat: callers that still wire onListenGate
        // get a one-shot fire with the same reason so any leftover
        // gating logic resolves.
        if (onListenGate) { try { onListenGate({ reason: outcome.reason }); } catch {} }
        if (onAudioEnded) { try { onAudioEnded({ reason: outcome.reason }); } catch {} }
        return outcome;
      });
  }

  /** audio-flow: play the call-close clip (hangup + 3× end-call beeps).
   *  Round-7: AudioBufferSourceNode with deterministic `onended`. */
  playCallClose() {
    if (this._hardKilled) return Promise.resolve({ ok: false, reason: 'hard_killed' });
    return this._playBufferSource('callClose', '_activeCloseSource', '_activeCloseStopped', '_closePlaying', END_AUDIO_MAX_MS);
  }

  /** audio-flow: emit the `all-stopped` event when every managed audio
   *  element is idle. UI uses it to flip the End Call button back to
   *  green only after the very last sample has played (requirement 6). */
  _checkAllStopped() {
    if (this._openPlaying || this._backgroundPlaying || this._closePlaying) return;
    try { this._onAllStopped(); } catch { /* never break the chain */ }
  }

  /** audio-flow: HARD kill — synchronously stops every IN-FLIGHT
   *  audio source and latches `_hardKilled` so nothing re-starts.
   *
   *  Round-7: callOpen + callClose are now AudioBufferSourceNodes.
   *  `stop()` is synchronous-but-fires-onended-later — we set the
   *  stopped flag BEFORE calling stop so the source's onended
   *  callback sees `reason='stopped'`. Then call stop(0).
   *
   *  Background is still HTMLAudioElement; pause it synchronously. */
  stopAllCallAudio() {
    this._hardKilled = true;
    this._backgroundPlaying = false;
    try { this.backgroundAudio.pause(); } catch {}
    try { this.backgroundAudio.currentTime = 0; } catch {}
    // Stop the active BufferSource for callOpen (if playing).
    if (this._activeOpenSource) {
      this._activeOpenStopped = true;
      try { this._activeOpenSource.stop(0); } catch {}
    }
    // Stop the active BufferSource for callClose (if playing).
    if (this._activeCloseSource) {
      this._activeCloseStopped = true;
      try { this._activeCloseSource.stop(0); } catch {}
    }
    this._checkAllStopped();
  }

  /** audio-flow: called by the agent at the top of placeCall() so a
   *  previous hard-kill doesn't bar the new call's audio. */
  armForNextCall() {
    this._hardKilled = false;
    this._bgRestartAttempts = 0;
  }

  /** audio-flow: start looping the background ambience. No-op if the
   *  toggle is off or background is already playing.
   *
   *  HARDENED FIX for "background sound not playing":
   *   1. `loop=true` re-asserted (some browsers drop it after pause/resume
   *      or unlock's muted-play cycle).
   *   2. `muted=false` re-asserted — `stopAllCallAudio()` can leave the
   *      element muted for a brief window; asserting here is safe.
   *   3. `volume` re-set — defends against a rogue caller zeroing it.
   *   4. `preload='auto'` re-asserted so the file is eager-decoded.
   *   5. `src` re-assigned if empty (destroy() clears it) — the element
   *      survives the AudioPipeline lifetime so we must be defensive.
   *   6. `play()` rejection triggers an immediate retry on the next
   *      macrotask. A second rejection logs at ERROR severity so the
   *      failure is LOUD in DevTools rather than silent.
   *   7. If the user toggled Background off mid-play, we respect it and
   *      no-op. */
  startBackground() {
    if (!this._backgroundEnabled) {
      // eslint-disable-next-line no-console
      console.warn('[audio-flow] startBackground skipped — toggle off');
      return;
    }
    if (this._hardKilled) {
      // eslint-disable-next-line no-console
      console.warn('[audio-flow] startBackground skipped — hard-killed (pending next call)');
      return;
    }
    if (this._backgroundPlaying) return;

    this._backgroundPlaying = true;
    this._bgRestartAttempts = 0;

    // 1–5: re-assert element state.
    try { this.backgroundAudio.loop = true; } catch {}
    try { this.backgroundAudio.volume = BACKGROUND_VOLUME; } catch {}
    try { this.backgroundAudio.muted = false; } catch {}
    try { this.backgroundAudio.preload = 'auto'; } catch {}
    if (!this.backgroundAudio.src || this.backgroundAudio.src === 'about:blank') {
      const src = pickCallAudioSrc('background');
      if (src) {
        try { this.backgroundAudio.src = src; } catch {}
        try { this.backgroundAudio.load(); } catch {}
      }
    }
    try { this.backgroundAudio.currentTime = 0; } catch {}

    const doPlay = (attempt) => {
      let p;
      try {
        p = this.backgroundAudio.play();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[audio-flow] background play threw (attempt ' + attempt + ')', err && err.message);
        if (attempt < 2) return setTimeout(() => doPlay(attempt + 1), 120);
        this._backgroundPlaying = false;
        this._onStateChange({ backgroundPlaying: false, reason: 'play_threw' });
        this._checkAllStopped();
        return;
      }
      if (p && typeof p.catch === 'function') {
        p.catch((err) => {
          // eslint-disable-next-line no-console
          console.warn('[audio-flow] background play rejected (attempt ' + attempt + ')', err && err.message);
          if (attempt < 2) return setTimeout(() => doPlay(attempt + 1), 120);
          // Loud, persistent: surface the failure mode rather than stay silent.
          // eslint-disable-next-line no-console
          console.error('[audio-flow] background play REJECTED after retries — ambience will be silent for this call', err && err.message);
          this._backgroundPlaying = false;
          this._onStateChange({ backgroundPlaying: false, reason: 'play_rejected' });
          this._checkAllStopped();
        });
      }
    };
    doPlay(1);

    this._onStateChange({ backgroundPlaying: true });
  }

  /** audio-flow: stop the background loop if it's running. Idempotent. */
  stopBackground() {
    const wasPlaying = this._backgroundPlaying;
    this._backgroundPlaying = false;
    try { this.backgroundAudio.pause(); } catch {}
    try { this.backgroundAudio.currentTime = 0; } catch {}
    if (wasPlaying) this._onStateChange({ backgroundPlaying: false });
    this._checkAllStopped();
  }

  /** audio-flow: toggle the user's background preference. When called
   *  mid-call, take effect immediately. */
  setBackgroundEnabled(on) {
    const next = !!on;
    const changed = this._backgroundEnabled !== next;
    this._backgroundEnabled = next;
    if (!next && this._backgroundPlaying) {
      this.stopBackground();
    }
    return changed;
  }

  isBackgroundEnabled() { return this._backgroundEnabled; }
  isBackgroundPlaying() { return this._backgroundPlaying; }

  /** audio-flow: stop everything and detach listeners. Called on full
   *  pipeline close. */
  destroy() {
    // Background (HTMLAudioElement) — pause + unload.
    try { this.backgroundAudio.pause(); } catch {}
    try { this.backgroundAudio.removeAttribute('src'); this.backgroundAudio.load(); } catch {}
    // callOpen + callClose (AudioBufferSourceNode) — stop if active.
    if (this._activeOpenSource) {
      this._activeOpenStopped = true;
      try { this._activeOpenSource.stop(0); } catch {}
      try { this._activeOpenSource.disconnect(); } catch {}
      this._activeOpenSource = null;
    }
    if (this._activeCloseSource) {
      this._activeCloseStopped = true;
      try { this._activeCloseSource.stop(0); } catch {}
      try { this._activeCloseSource.disconnect(); } catch {}
      this._activeCloseSource = null;
    }
    this._openPlaying = false;
    this._backgroundPlaying = false;
    this._closePlaying = false;
  }
}

export class AudioPipeline extends EventTarget {
  constructor() {
    super();
    // Single AudioContext for both capture and playback. Created lazily
    // (or eagerly via unlockAudioSync) and never destroyed across route
    // changes.
    this.ctx = null;
    this.capture = null;           // { micStream, worklet, source, track }
    this.onPcmFrame = null;        // (Int16Array) => void
    this.capturePaused = true;
    this.muted = false;            // orthogonal to paused — user-controlled
    this.activePlaybackSources = new Set();

    // Playback graph pieces.
    this.nextStartTime = 0;
    this.playbackGain = null;      // agent volume only
    this.outputVolume = 1.0;

    // Round-5: the round-4 client-side playback buffer + gate has been
    // removed. The correct fix is upstream — the Gemini Live session
    // never generates audio until the client sends a user-turn, and
    // the `greet_gate_open` frame that triggers the proactive greeting
    // is itself gated on the callOpen `ended` event
    // (see VoiceAgent._tryOpenGreetGate + api/live-bridge.js
    // maybeFireGreeting). So no TTS audio arrives during callOpen, so
    // there is nothing to buffer. `enqueuePcm24k` schedules every
    // chunk directly into the AudioContext with no gating. A
    // safety-belt log in VoiceAgent._onWsMessage catches any
    // regression where agent PCM arrives before callOpen settles.

    // audio-flow: phone-line compression sub-graph. Optional, crossfaded.
    // Default OFF (bypass). Owned by pipeline; toggled via
    // setPhoneCompression(). Graph:
    //   playbackGain ──┬─ _cleanGain ─────────────────────────────┐
    //                  │                                           ├─> destination
    //                  └─ _phoneIn → HP → LP → Comp → Makeup ─────┘
    // _cleanGain and _phoneIn (which feeds through to _phoneOut at the
    // end of the chain) have their gains crossfaded so there's no click.
    this._phoneCompressionOn = false;
    this._cleanGain = null;
    this._phoneIn = null;
    this._phoneHP = null;
    this._phoneLP1 = null;
    this._phoneLP2 = null;
    this._phoneComp = null;
    this._phoneMakeup = null;

    // audio-flow: call-audio controller owns the three lifecycle clips.
    // It's independent from the Web Audio graph so it keeps working even
    // if the ctx is suspended — the browser drives <audio> scheduling.
    this.callAudio = new CallAudioController({
      onStateChange: (ev) => this.dispatchEvent(new CustomEvent('call-audio-changed', { detail: ev })),
      onAllStopped: () => this.dispatchEvent(new CustomEvent('call-audio-all-stopped')),
      // Round-7: pass self so the controller can construct
      // AudioBufferSourceNodes off the shared AudioContext +
      // playbackGain when callOpen/callClose are triggered.
      pipeline: this
    });

    this._analyser = null;
    this._micAnalyser = null;

    // Keep-alive watchdog — periodically resume the context if Chrome
    // decides to suspend it while idle.
    this._keepAliveTimer = null;

    // Visibility-resume listener so tabs returning from background unlock
    // the shared context without requiring a click.
    this._onVisibility = () => this._onVisibilityChange();
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this._onVisibility);
    }
  }

  _onVisibilityChange() {
    if (typeof document === 'undefined') return;
    if (document.visibilityState !== 'visible') return;
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
  }

  // ----- Context bootstrap -----

  /**
   * SYNCHRONOUS context creation + resume. MUST be called from inside a
   * user-gesture event handler stack (e.g. click, keydown) BEFORE any
   * `await`. Chrome's autoplay policy only honours resume() while the
   * gesture activation is alive — one sync call wide.
   *
   * Idempotent. Safe to call many times.
   */
  unlockAudioSync() {
    if (!this.ctx) {
      const ctor = (typeof window !== 'undefined') && (window.AudioContext || window.webkitAudioContext);
      if (!ctor) return null;
      this.ctx = new ctor({ latencyHint: 'interactive', sampleRate: 48000 });
      this._buildPlaybackGraph();
      this._startKeepAlive();
    }
    // Note: `resume()` returns a promise, but the CRITICAL part — Chrome
    // marking the context as unblocked — happens synchronously when the
    // call originates from an active user gesture.
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    // audio-flow: unlock the HTMLAudioElement layer (only background
    // now, since round-7 moved callOpen/callClose to Web Audio).
    try { this.callAudio.unlock(); } catch {}
    // Round-7: kick off the AudioBuffer decode for callOpen +
    // callClose so the first placeCall has them ready. Fire-and-forget:
    // the decode promise is tracked inside the controller so the play
    // path can await it if the user clicks before decode finishes.
    try { this.callAudio.prepareBuffers(this.ctx); } catch {}
    return this.ctx;
  }

  /** Async variant. Safe to call outside a gesture but cannot unlock a
   *  suspended context on Chrome without one. */
  async ensureCtx() {
    if (!this.ctx) this.unlockAudioSync();
    if (this.ctx && this.ctx.state === 'suspended') {
      try { await this.ctx.resume(); } catch { /* will retry on enqueue */ }
    }
    return this.ctx;
  }

  /** True when the AudioContext is blocked by Chrome's autoplay policy. */
  isPlaybackBlocked() {
    return !this.ctx || this.ctx.state === 'suspended';
  }

  _buildPlaybackGraph() {
    const ctx = this.ctx;

    // Agent-output chain with an opt-in phone-line compression branch.
    // Base chain (default, compression OFF):
    //   sources → playbackGain → _cleanGain → destination
    // Phone chain (when ON, crossfaded in):
    //   playbackGain → _phoneIn → HP(300Hz) → LP(3400Hz) → LP(3400Hz)
    //               → DynamicsCompressor → makeupGain → destination
    // Both gain paths are mixed into destination; we crossfade
    // _cleanGain.gain vs _phoneIn.gain with a 50ms exponential ramp.
    this.playbackGain = ctx.createGain();
    this.playbackGain.gain.value = this.outputVolume;

    // Clean path.
    this._cleanGain = ctx.createGain();
    this._cleanGain.gain.value = 1.0; // default: clean ON (bypass phone)

    // Phone path.
    this._phoneIn = ctx.createGain();
    this._phoneIn.gain.value = 0.0; // default: phone OFF (bypassed)

    // 300Hz high-pass then 3400Hz low-pass cascaded twice for a steeper
    // roll-off that better evokes the POTS bandwidth.
    this._phoneHP = ctx.createBiquadFilter();
    this._phoneHP.type = 'highpass';
    this._phoneHP.frequency.value = 300;
    this._phoneHP.Q.value = 0.707;

    this._phoneLP1 = ctx.createBiquadFilter();
    this._phoneLP1.type = 'lowpass';
    this._phoneLP1.frequency.value = 3400;
    this._phoneLP1.Q.value = 0.707;

    this._phoneLP2 = ctx.createBiquadFilter();
    this._phoneLP2.type = 'lowpass';
    this._phoneLP2.frequency.value = 3400;
    this._phoneLP2.Q.value = 0.707;

    // Soft compressor to simulate a carrier's dynamics processing.
    this._phoneComp = ctx.createDynamicsCompressor();
    this._phoneComp.threshold.value = -18;
    this._phoneComp.ratio.value = 3;
    this._phoneComp.attack.value = 0.010;
    this._phoneComp.release.value = 0.200;
    this._phoneComp.knee.value = 6;

    // +6 dB makeup to restore loudness lost to bandpass + compression.
    this._phoneMakeup = ctx.createGain();
    this._phoneMakeup.gain.value = 2.0; // ~+6 dB

    // Wire phone chain.
    this._phoneIn.connect(this._phoneHP);
    this._phoneHP.connect(this._phoneLP1);
    this._phoneLP1.connect(this._phoneLP2);
    this._phoneLP2.connect(this._phoneComp);
    this._phoneComp.connect(this._phoneMakeup);
    this._phoneMakeup.connect(ctx.destination);

    // Wire parallel paths off playbackGain.
    this.playbackGain.connect(this._cleanGain);
    this._cleanGain.connect(ctx.destination);
    this.playbackGain.connect(this._phoneIn);

    // Analyser on agent audio (for VU meter). Tap playbackGain so the
    // reading is unaffected by the phone/clean crossfade.
    this._analyser = ctx.createAnalyser();
    this._analyser.fftSize = 256;
    this.playbackGain.connect(this._analyser);
  }

  /** audio-flow: enable/disable the phone-line compression sub-graph.
   *  Crossfades the clean vs. phone path with a 50ms exponential ramp
   *  to avoid clicks. Safe to call before the AudioContext exists (will
   *  be applied next time the graph is built, but in practice the graph
   *  is built during placeCall's unlock so this is a no-op edge). */
  setPhoneCompression(on) {
    const next = !!on;
    this._phoneCompressionOn = next;
    if (!this.ctx || !this._cleanGain || !this._phoneIn) return next;
    const now = this.ctx.currentTime;
    const RAMP = 0.050;
    const EPS = 0.0001; // exponentialRamp can't target 0
    try {
      // Cancel any pending schedules so toggling fast doesn't stack.
      this._cleanGain.gain.cancelScheduledValues(now);
      this._phoneIn.gain.cancelScheduledValues(now);
      // Set starting values explicitly (cancel doesn't — it just clears
      // the automation curve). Read current value before ramping.
      this._cleanGain.gain.setValueAtTime(Math.max(this._cleanGain.gain.value, EPS), now);
      this._phoneIn.gain.setValueAtTime(Math.max(this._phoneIn.gain.value, EPS), now);
      if (next) {
        // Phone ON: clean fades to EPS, phone fades to 1.
        this._cleanGain.gain.exponentialRampToValueAtTime(EPS, now + RAMP);
        this._phoneIn.gain.exponentialRampToValueAtTime(1.0, now + RAMP);
      } else {
        this._phoneIn.gain.exponentialRampToValueAtTime(EPS, now + RAMP);
        this._cleanGain.gain.exponentialRampToValueAtTime(1.0, now + RAMP);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[audio-flow] setPhoneCompression crossfade threw', err && err.message);
      // Fallback: hard set.
      this._cleanGain.gain.value = next ? 0.0 : 1.0;
      this._phoneIn.gain.value = next ? 1.0 : 0.0;
    }
    return next;
  }

  isPhoneCompressionOn() { return !!this._phoneCompressionOn; }

  /** Gentle watchdog: resumes the AudioContext if Chrome suspends it while
   *  we think a call is active. Tiny CPU cost. */
  _startKeepAlive() {
    if (this._keepAliveTimer) return;
    this._keepAliveTimer = setInterval(() => {
      if (!this.ctx) return;
      if (this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {});
      }
    }, 2000);
  }
  _stopKeepAlive() {
    if (this._keepAliveTimer) clearInterval(this._keepAliveTimer);
    this._keepAliveTimer = null;
  }

  // ----- Playback -----

  /** Schedule a PCM16 24 kHz chunk into the AudioContext immediately.
   *  No buffering, no gating — the upstream (live-bridge.js) is
   *  responsible for not generating audio until the client is ready
   *  (server-side pre-greet buffer, see round-6 fix 1).
   *
   *  Round-1 req 7 still holds: `flushPlayback()` stops every scheduled
   *  source synchronously for the immediate-kill UX.
   *
   *  Round-6 fix 2: fires the `agent-playback-drained` event when the
   *  last scheduled source's `onended` runs AND the set becomes
   *  empty. The deterministic end-call chain listens for this to
   *  decide when the model has physically finished speaking. */
  enqueuePcm24k(int16) {
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    const buffer = int16ToAudioBuffer(this.ctx, int16, 24000);
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.playbackGain);
    const t = Math.max(this.ctx.currentTime, this.nextStartTime);
    src.start(t);
    this.nextStartTime = t + buffer.duration;
    this.activePlaybackSources.add(src);
    src.onended = () => {
      try { src.disconnect(); } catch {}
      this.activePlaybackSources.delete(src);
      if (this.activePlaybackSources.size === 0) {
        try { this.dispatchEvent(new CustomEvent('agent-playback-drained')); } catch {}
      }
    };
  }

  /** Round-6 fix 2: `true` while any agent-audio source is still
   *  scheduled or playing. The deterministic end-call chain uses this
   *  to decide whether to wait for `agent-playback-drained` or
   *  proceed immediately. */
  isAgentAudioPlaying() {
    return this.activePlaybackSources.size > 0;
  }

  /** Hard flush: stop all in-flight scheduled sources immediately.
   *  Called from `flushPlayback` consumers in VoiceAgent to kill any
   *  still-playing agent voice (round-1 req 7, round-2 teardown). */
  flushPlayback() {
    for (const src of this.activePlaybackSources) {
      try { src.stop(); } catch {}
      try { src.disconnect(); } catch {}
    }
    this.activePlaybackSources.clear();
    this.nextStartTime = this.ctx ? this.ctx.currentTime : 0;
  }

  /** audio-flow: Total-audio kill-switch. Synchronously stops every
   *  Gemini playback source AND every HTMLAudioElement so no further
   *  sound can reach the speakers. Used when the user clicks End Call
   *  and we need "THEN AND THERE" silence (requirement 7).
   *
   *  Emits the `call-audio-all-stopped` event so the UI flips the End
   *  Call button back to green (requirement 6). */
  stopAllAudio() {
    // 1. Kill scheduled PCM sources (Gemini voice).
    this.flushPlayback();
    // 2. HARD-kill every lifecycle <audio> element (callOpen, background,
    //    callClose). Also latches the controller so a late-arriving
    //    `startBackground()` or `playCallClose()` can't resurrect audio.
    try { this.callAudio.stopAllCallAudio(); } catch {}
    // 3. Make sure the "all stopped" event fires even if the controller
    //    already flipped its internal flags. Idempotent consumers are
    //    expected.
    try { this.dispatchEvent(new CustomEvent('call-audio-all-stopped')); } catch {}
  }

  setOutputVolume(v) {
    this.outputVolume = Math.max(0, Math.min(1.5, v));
    if (this.playbackGain) this.playbackGain.gain.value = this.outputVolume;
  }

  // ----- Capture -----

  async startCapture({ onPcmFrame }) {
    this.onPcmFrame = onPcmFrame;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('getUserMedia not supported by this browser.');
    }
    // Use the shared AudioContext for capture too.
    if (!this.ctx) this.unlockAudioSync();
    if (!this.ctx) throw new Error('AudioContext unavailable.');

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    if (this.ctx.state === 'suspended') await this.ctx.resume();

    // Register the worklet module once per context.
    try {
      await this.ctx.audioWorklet.addModule('/js/audio-worklets/pcm-capture.js');
    } catch (err) {
      // Swallow if already added; first add on some browsers throws on re-add.
      if (!/already|registered/i.test(err && err.message || '')) throw err;
    }

    const source = this.ctx.createMediaStreamSource(stream);
    const worklet = new AudioWorkletNode(this.ctx, 'pcm-capture', {
      processorOptions: { outputSampleRate: 16000, frameMs: 40 }
    });
    source.connect(worklet);
    // DO NOT connect worklet to destination — we never want to play back the mic.

    // Mic-side analyser for the VU meter.
    this._micAnalyser = this.ctx.createAnalyser();
    this._micAnalyser.fftSize = 256;
    source.connect(this._micAnalyser);

    worklet.port.onmessage = (e) => {
      if (this.capturePaused || this.muted) return;
      if (typeof this.onPcmFrame !== 'function') return;
      const int16 = new Int16Array(e.data);
      this.onPcmFrame(int16);
    };

    // Detect if the mic track dies (USB sleep, another app grabs it).
    const track = stream.getAudioTracks()[0];
    if (track) {
      track.addEventListener('ended', () => {
        this.dispatchEvent(new CustomEvent('mic-ended', {}));
      });
      track.addEventListener('mute', () => {
        this.dispatchEvent(new CustomEvent('mic-hw-mute', { detail: { muted: true } }));
      });
      track.addEventListener('unmute', () => {
        this.dispatchEvent(new CustomEvent('mic-hw-mute', { detail: { muted: false } }));
      });
    }

    this.capture = { micStream: stream, worklet, source, track };
    this.capturePaused = true;
    worklet.port.postMessage({ type: 'mute', value: true });
  }

  setCapturePaused(paused) {
    this.capturePaused = !!paused;
    if (this.capture?.worklet) {
      this.capture.worklet.port.postMessage({ type: 'mute', value: !!paused });
    }
  }

  /** User-facing mute toggle. Disables the MediaStreamTrack so even if a
   *  stray frame sneaks through our `muted` check, nothing gets captured at
   *  the device level. */
  setMuted(muted) {
    this.muted = !!muted;
    if (this.capture && this.capture.track) {
      try { this.capture.track.enabled = !this.muted; } catch {}
    }
    if (this.capture?.worklet) {
      this.capture.worklet.port.postMessage({ type: 'mute', value: this.muted || this.capturePaused });
    }
  }

  isMuted() { return !!this.muted; }
  isMicEnded() { return !!(this.capture && this.capture.track && this.capture.track.readyState === 'ended'); }

  /** Read an analyser on the mic itself (not playback). Used by Live mode UI. */
  readMicLevel() {
    if (!this._micAnalyser) return 0;
    const arr = new Uint8Array(this._micAnalyser.frequencyBinCount);
    this._micAnalyser.getByteTimeDomainData(arr);
    let peak = 0;
    for (let i = 0; i < arr.length; i++) {
      const v = Math.abs(arr[i] - 128);
      if (v > peak) peak = v;
    }
    return peak / 128;
  }

  stopCapture() {
    if (!this.capture) return;
    try { this.capture.worklet.disconnect(); } catch {}
    try { this.capture.source.disconnect(); } catch {}
    try { this.capture.micStream.getTracks().forEach((t) => t.stop()); } catch {}
    this.capture = null;
  }

  // ----- VU meter -----
  readVuLevel() {
    if (!this._analyser) return 0;
    const arr = new Uint8Array(this._analyser.frequencyBinCount);
    this._analyser.getByteTimeDomainData(arr);
    let peak = 0;
    for (let i = 0; i < arr.length; i++) {
      const v = Math.abs(arr[i] - 128);
      if (v > peak) peak = v;
    }
    return peak / 128;
  }

  async close() {
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this._onVisibility);
    }
    this._stopKeepAlive();
    this.stopCapture();
    // audio-flow: stop the call-audio layer before tearing down the ctx.
    try { this.callAudio.destroy(); } catch {}
    if (this.ctx) { try { await this.ctx.close(); } catch {} this.ctx = null; }
  }
}
